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
  /**
   * Address workers must dial, when the control plane is not reachable at
   * 127.0.0.1 from the sandbox (every remote deployment). An `https://` URL
   * becomes a `wss://` socket; the path `/worker` is appended.
   */
  publicWorkerUrl?: string;
  /** Tarball of the worker to ship into remote sandboxes (`t3x worker bundle`). */
  workerBundle?: string;
  /** Entry the shipped bundle exposes inside the sandbox. */
  workerEntryInSandbox?: string;
  apiToken?: string | null;
  policy?: unknown;
  /** Global default sandbox scope (default: shared sandbox per project). */
  globalDefaultScope?: SandboxScope;
  /** Start the effect polling loop immediately (default true). */
  autoStartEffects?: boolean;
  launcher?: WorkerLauncher;
  workerAttachTimeoutMs?: number;
}

/**
 * Which sandbox backend to run.
 *
 * `auto` (the default) uses Daytona when `DAYTONA_API_KEY` is set and the SDK
 * is installed, and the local directory backend otherwise — so a laptop can
 * run the control plane with no Daytona account, and a VPS with the key
 * provisions real sandboxes without a flag.
 */
export type SandboxBackendKind = "auto" | "local" | "daytona";

export async function createSandboxBackend(options: {
  stateDir: string;
  kind?: SandboxBackendKind;
  daytona?: {
    apiKey?: string;
    apiUrl?: string;
    target?: string;
    defaultImage?: string;
    defaultAutoStopMinutes?: number;
  };
}): Promise<SandboxBackend> {
  const kind = options.kind ?? "auto";
  if (kind === "local") return new LocalBackend(path.join(options.stateDir, "sandboxes"));
  const apiKey = options.daytona?.apiKey ?? process.env.DAYTONA_API_KEY ?? "";
  if (kind === "auto" && !apiKey) return new LocalBackend(path.join(options.stateDir, "sandboxes"));
  const { DaytonaBackend } = await import("./daytona/DaytonaBackend.js");
  return await DaytonaBackend.create({
    apiKey,
    ...(options.daytona?.apiUrl ? { apiUrl: options.daytona.apiUrl } : {}),
    ...(options.daytona?.target ? { target: options.daytona.target } : {}),
    ...(options.daytona?.defaultImage ? { defaultImage: options.daytona.defaultImage } : {}),
    ...(options.daytona?.defaultAutoStopMinutes !== undefined
      ? { defaultAutoStopMinutes: options.daytona.defaultAutoStopMinutes }
      : {}),
  });
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
  private readonly publicWorkerUrl: string | null;

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
    publicWorkerUrl?: string | null;
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
    this.publicWorkerUrl = init.publicWorkerUrl ?? null;
  }

  get port(): number {
    const address = this.httpServer.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  get workerUrl(): string {
    const base = this.publicWorkerUrl ?? `http://127.0.0.1:${this.port}`;
    return `${base.replace(/\/+$/, "")}/worker`;
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

    const workerUrlBase = options.publicWorkerUrl ?? `http://127.0.0.1:${options.port ?? 8087}`;
    const controlPlane = new SandboxControlPlane({
      store,
      backend,
      registry,
      profiles,
      secrets,
      bundles,
      projects,
      stateDir,
      workerUrl: `${workerUrlBase.replace(/\/+$/, "")}/worker`,
      workerEntry: options.workerEntry ?? defaultWorkerEntry(),
      ...(options.workerBundle ? { workerBundle: options.workerBundle } : {}),
      ...(options.workerEntryInSandbox
        ? { workerEntryInSandbox: options.workerEntryInSandbox }
        : {}),
      ...(options.globalDefaultScope ? { globalDefaultScope: options.globalDefaultScope } : {}),
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

    // A public URL is taken exactly as given; otherwise the URL must use the
    // actually bound port (the caller may have asked for port 0).
    const bound = (httpServer.address() as AddressInfo).port;
    const workerBase = options.publicWorkerUrl
      ? options.publicWorkerUrl.replace(/\/+$/, "")
      : `http://127.0.0.1:${bound}`;
    controlPlane.workerUrl = `${workerBase}/worker`;

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
      publicWorkerUrl: options.publicWorkerUrl ?? null,
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
