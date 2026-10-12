/**
 * Control plane assembly (report §7 "SandboxControlPlane — VPS").
 *
 * Wires the event store, sandbox backend, worker registry, profile service,
 * secrets broker, remote workspace service, effect worker, recovery service
 * and the client HTTP API into one process. A deployment runs exactly this on
 * the VPS; tests start it in-process on an ephemeral port.
 */

import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { EventStore } from "./EventStore.js";
import { WorkerConnectionRegistry } from "./WorkerConnectionRegistry.js";
import { EnvironmentProfileService } from "./EnvironmentProfileService.js";
import { SecretsBroker } from "./SecretsBroker.js";
import { RemoteWorkspaceService } from "./RemoteWorkspaceService.js";
import { SandboxControlPlane, type WorkerLauncher } from "./SandboxControlPlane.js";
import { ProjectSandboxStore } from "./ProjectSandboxStore.js";
import { workerPathMapper } from "./WorkerPathMapper.js";
import type { SandboxScope } from "../contracts/sandboxScope.js";
import { TaskService } from "./TaskService.js";
import { EffectWorker } from "./EffectWorker.js";
import { TaskRecoveryService } from "./TaskRecoveryService.js";
import { HttpApi } from "./HttpApi.js";
import { LocalBackend } from "./daytona/LocalBackend.js";
import type { SandboxBackend } from "./daytona/SandboxBackend.js";
import { ConfigBundleStore } from "../config-importer/ConfigBundle.js";

export interface ControlPlaneOptions {
  stateDir: string;
  port?: number;
  backend?: SandboxBackend;
  workerEntry?: string;
  apiToken?: string | null;
  policy?: unknown;
  /** Global default sandbox scope (default: shared sandbox per project). */
  globalDefaultScope?: SandboxScope;
  /** Start the effect polling loop immediately (default true). */
  autoStartEffects?: boolean;
  launcher?: WorkerLauncher;
  workerAttachTimeoutMs?: number;
}

/** dist/src/execution -> dist/src/worker/index.js */
export function defaultWorkerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "worker", "index.js");
}

export class ControlPlaneServer {
  readonly store: EventStore;
  readonly backend: SandboxBackend;
  readonly registry: WorkerConnectionRegistry;
  readonly profiles: EnvironmentProfileService;
  readonly secrets: SecretsBroker;
  readonly bundles: ConfigBundleStore;
  readonly projects: ProjectSandboxStore;
  readonly workspace: RemoteWorkspaceService;
  readonly controlPlane: SandboxControlPlane;
  readonly tasks: TaskService;
  readonly effectWorker: EffectWorker;
  readonly recovery: TaskRecoveryService;
  readonly api: HttpApi;
  readonly httpServer: http.Server;
  readonly stateDir: string;

  private constructor(init: {
    store: EventStore;
    backend: SandboxBackend;
    registry: WorkerConnectionRegistry;
    profiles: EnvironmentProfileService;
    secrets: SecretsBroker;
    bundles: ConfigBundleStore;
    projects: ProjectSandboxStore;
    workspace: RemoteWorkspaceService;
    controlPlane: SandboxControlPlane;
    tasks: TaskService;
    effectWorker: EffectWorker;
    recovery: TaskRecoveryService;
    api: HttpApi;
    httpServer: http.Server;
    stateDir: string;
  }) {
    this.store = init.store;
    this.backend = init.backend;
    this.registry = init.registry;
    this.profiles = init.profiles;
    this.secrets = init.secrets;
    this.bundles = init.bundles;
    this.projects = init.projects;
    this.workspace = init.workspace;
    this.controlPlane = init.controlPlane;
    this.tasks = init.tasks;
    this.effectWorker = init.effectWorker;
    this.recovery = init.recovery;
    this.api = init.api;
    this.httpServer = init.httpServer;
    this.stateDir = init.stateDir;
  }

  get port(): number {
    const address = this.httpServer.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  get workerUrl(): string {
    return `http://127.0.0.1:${this.port}/worker`;
  }

  static async start(options: ControlPlaneOptions): Promise<ControlPlaneServer> {
    const stateDir = path.resolve(options.stateDir);
    const store = new EventStore(path.join(stateDir, "control-plane.sqlite"));
    const backend = options.backend ?? new LocalBackend(path.join(stateDir, "sandboxes"));
    const secrets = new SecretsBroker(store, path.join(stateDir, "secret.key"));
    const bundles = new ConfigBundleStore(path.join(stateDir, "config-bundles"));
    const profiles = new EnvironmentProfileService(store, options.policy ?? {});
    const projects = new ProjectSandboxStore(store.db);

    let controlPlaneRef: SandboxControlPlane | null = null;
    const registry = new WorkerConnectionRegistry(store, {
      projects,
      issueToken: (taskId: string, sandboxId: string): string =>
        controlPlaneRef!.issueWorkerToken(taskId, sandboxId),
    });
    const workspace = new RemoteWorkspaceService(store, registry, workerPathMapper(backend));

    const httpServer = http.createServer();
    registry.attach(httpServer, "/worker");

    const controlPlane = new SandboxControlPlane({
      store,
      backend,
      registry,
      profiles,
      secrets,
      bundles,
      projects,
      stateDir,
      workerUrl: `http://127.0.0.1:${options.port ?? 8087}/worker`,
      workerEntry: options.workerEntry ?? defaultWorkerEntry(),
      ...(options.globalDefaultScope
        ? { globalDefaultScope: options.globalDefaultScope }
        : {}),
      ...(options.launcher ? { launcher: options.launcher } : {}),
      ...(options.workerAttachTimeoutMs
        ? { workerAttachTimeoutMs: options.workerAttachTimeoutMs }
        : {}),
    });
    controlPlaneRef = controlPlane;

    const tasks = new TaskService(store, controlPlane, registry, workspace, projects);
    const effectWorker = new EffectWorker({ store, controlPlane, registry, workspace });
    const recovery = new TaskRecoveryService({ store, controlPlane, tasks, projects });
    const api = new HttpApi({
      tasks,
      profiles,
      controlPlane,
      projects,
      registry,
      apiToken: options.apiToken ?? null,
    });

    httpServer.on("request", api.handler);

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port ?? 8087, "127.0.0.1", () => resolve());
    });

    // The worker URL must use the actually bound port when port 0 was asked.
    const bound = (httpServer.address() as AddressInfo).port;
    controlPlane.workerUrl = `http://127.0.0.1:${bound}/worker`;

    const server = new ControlPlaneServer({
      store,
      backend,
      registry,
      profiles,
      secrets,
      bundles,
      projects,
      workspace,
      controlPlane,
      tasks,
      effectWorker,
      recovery,
      api,
      httpServer,
      stateDir,
    });

    if (options.autoStartEffects !== false) effectWorker.start();
    return server;
  }

  async stop(): Promise<void> {
    this.effectWorker.stop();
    this.controlPlane.stopAllWorkers();
    this.registry.close();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    this.store.close();
  }
}
