/**
 * Daytona sandbox backend.
 *
 * Maps SandboxBackend onto the Daytona TypeScript SDK surface
 * (`@daytonaio/sdk`, package name verified against 0.224.0): snapshot and
 * image creation, resource templates, process execution, file transfer,
 * stop/start, organization secrets and signed preview links.
 *
 * The SDK is loaded at runtime through a structural interface
 * (`DaytonaClientLike`) so this module compiles and tests without the SDK
 * installed; `loadDaytonaClient()` binds it to `@daytonaio/sdk` when present.
 * The Daytona organization API key stays on the VPS and is never passed to an
 * agent or written into a sandbox.
 *
 * Three properties of the real API shape the code below and are worth knowing
 * before changing it:
 *
 *  - `client.list()` is an async iterable, not an array, and `client.delete()`
 *    takes a Sandbox object, not an id;
 *  - a Sandbox carries `id` and `state` as properties (there is no
 *    `getId()`/`getState()`), and `process.executeCommand` takes positional
 *    `(command, cwd, env, timeoutSeconds)` with the timeout in seconds;
 *  - credentials are mounted, not pushed: environment secrets are set at
 *    creation through `envVars`, and header-injected secrets must exist in the
 *    organization (`daytona.secret.create`) and are referenced by name in the
 *    sandbox's `secrets` map, which the platform substitutes on outbound
 *    requests to the secret's hosts. There is no API to add either after a
 *    sandbox exists.
 */

import type { SandboxHandle, SandboxStatus, WorkspaceEntry } from "../../contracts/execution.js";
import {
  ExecutionError,
  SandboxNotFoundError,
  SandboxBackendUnsupportedError,
} from "../../contracts/errors.js";
import type {
  ExecOptions,
  ExecResult,
  PreviewLink,
  SandboxBackend,
  SandboxSecret,
  SandboxSpec,
} from "./SandboxBackend.js";

/** Structural slice of the Daytona SDK this backend needs. */
export interface DaytonaSandboxLike {
  id: string;
  /** Populated on `get`; list results may need `refreshData()` first. */
  state?: string;
  snapshot?: string;
  cpu?: number;
  memory?: number;
  createdAt?: string;
  autoStopInterval?: number;
  refreshData?(): Promise<void>;
  start(timeout?: number): Promise<unknown>;
  stop(timeout?: number, force?: boolean): Promise<unknown>;
  delete(timeout?: number, wait?: boolean): Promise<unknown>;
  createSnapshot(name: string, timeout?: number): Promise<unknown>;
  fs: {
    downloadFile(remotePath: string, timeout?: number): Promise<Buffer | Uint8Array>;
    uploadFile(file: Buffer | Uint8Array, remotePath: string, timeout?: number): Promise<unknown>;
    listFiles(
      path: string,
      options?: { depth?: number },
    ): Promise<
      Array<{
        name: string;
        isDir?: boolean;
        isDirectory?: boolean;
        size?: number;
        /** ISO 8601. */
        modifiedAt?: string;
        /** Deprecated Go time layout; only used as a fallback. */
        modTime?: string;
      }>
    >;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result?: string; stdout?: string; stderr?: string }>;
  };
  getPreviewLink?(port: number): Promise<{ url: string; token?: string }>;
  getPreviewUrl?(port: number): Promise<string>;
}

export interface DaytonaSecretLike {
  id?: string;
  name: string;
}

export interface DaytonaSecretServiceLike {
  list(query?: { limit?: number; cursor?: string }): Promise<{
    items?: DaytonaSecretLike[];
    total?: number;
    nextCursor?: string | null;
  }>;
  create(params: { name: string; value: string; hosts?: string[] }): Promise<DaytonaSecretLike>;
  update(
    secretId: string,
    params: { value?: string; hosts?: string[] },
  ): Promise<DaytonaSecretLike>;
}

export interface DaytonaClientLike {
  create(
    options: {
      snapshot?: string;
      image?: string;
      resources?: { cpu: number; memory: number; disk?: number };
      envVars?: Record<string, string>;
      /** env var name -> name of an existing organization secret. */
      secrets?: Record<string, string>;
      labels?: Record<string, string>;
      autoStopInterval?: number;
      public?: boolean;
    },
    options2?: { timeout?: number },
  ): Promise<DaytonaSandboxLike>;
  get(id: string): Promise<DaytonaSandboxLike>;
  list(query?: {
    labels?: Record<string, string>;
    limit?: number;
  }): AsyncIterableIterator<DaytonaSandboxLike>;
  delete(sandbox: DaytonaSandboxLike, timeout?: number, wait?: boolean): Promise<unknown>;
  secret?: DaytonaSecretServiceLike;
}

/** The package that actually exists on npm. */
export const DAYTONA_SDK_PACKAGE = "@daytonaio/sdk";

export const DAYTONA_SDK_INSTALL_HINT =
  `Install it where the control plane runs: npm install ${DAYTONA_SDK_PACKAGE} ` +
  `(or pnpm add ${DAYTONA_SDK_PACKAGE} --filter @t3tools/daytona).`;

/** How the SDK is imported; a test substitutes a module with a fake constructor. */
export type DaytonaSdkLoader = () => Promise<{
  Daytona?: new (opts: unknown) => DaytonaClientLike;
} | null>;

export const importDaytonaSdk: DaytonaSdkLoader = () =>
  import(/* webpackIgnore: true */ DAYTONA_SDK_PACKAGE as string).catch(() => null) as Promise<{
    Daytona?: new (opts: unknown) => DaytonaClientLike;
  } | null>;

export async function loadDaytonaClient(
  options: {
    apiKey: string;
    apiUrl?: string;
    target?: string;
  },
  load: DaytonaSdkLoader = importDaytonaSdk,
): Promise<DaytonaClientLike> {
  const mod = await load();
  if (!mod?.Daytona) {
    throw new ExecutionError(
      "sandbox_backend_unsupported",
      `${DAYTONA_SDK_PACKAGE} is not installed; the Daytona backend cannot run. ${DAYTONA_SDK_INSTALL_HINT}`,
    );
  }
  if (!options.apiKey) {
    throw new ExecutionError(
      "unauthorized",
      "DAYTONA_API_KEY is not set; the Daytona backend cannot authenticate.",
    );
  }
  return new mod.Daytona({
    apiKey: options.apiKey,
    // Point the SDK at a self-hosted Daytona instead of the managed cloud.
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    // The default region for sandboxes and snapshots; a per-call target wins.
    ...(options.target ? { target: options.target } : {}),
  }) as DaytonaClientLike;
}

export interface DaytonaBackendOptions {
  apiKey?: string;
  /** API root of the Daytona deployment: `https://app.daytona.io/api` or your own. */
  apiUrl?: string;
  /** Default region (target) for sandboxes and snapshots. */
  target?: string;
  client?: DaytonaClientLike;
  defaultAutoStopMinutes?: number;
  /** Image used when a profile names no snapshot (resources then apply). */
  defaultImage?: string;
}

export class DaytonaBackend implements SandboxBackend {
  readonly kind = "daytona" as const;
  private readonly client: DaytonaClientLike;
  private readonly defaultAutoStopMinutes: number;
  private readonly defaultImage: string;

  private constructor(client: DaytonaClientLike, options: DaytonaBackendOptions) {
    this.client = client;
    this.defaultAutoStopMinutes = options.defaultAutoStopMinutes ?? 30;
    this.defaultImage = options.defaultImage ?? "daytonaio/sandbox:latest";
  }

  static async create(options: DaytonaBackendOptions = {}): Promise<DaytonaBackend> {
    const client =
      options.client ??
      (await loadDaytonaClient({
        apiKey: options.apiKey ?? process.env.DAYTONA_API_KEY ?? "",
        ...((options.apiUrl ?? process.env.DAYTONA_API_URL)
          ? { apiUrl: options.apiUrl ?? process.env.DAYTONA_API_URL }
          : {}),
        ...((options.target ?? process.env.DAYTONA_TARGET)
          ? { target: options.target ?? process.env.DAYTONA_TARGET }
          : {}),
      }));
    return new DaytonaBackend(client, options);
  }

  /**
   * Create a task sandbox.
   *
   * A snapshot fixes the resources, so `resources` is only sent when the
   * sandbox is built from an image (no snapshot in the profile).
   */
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const envVars: Record<string, string> = { ...spec.env };
    const secretMounts: Record<string, string> = {};
    for (const secret of spec.secrets) {
      if (secret.inject === "env") {
        envVars[secret.name] = secret.value;
        continue;
      }
      secretMounts[secret.name] = await this.ensureOrgSecret(secret);
    }

    const sandbox = await this.client.create(
      {
        ...(spec.snapshot
          ? { snapshot: spec.snapshot }
          : {
              image: this.defaultImage,
              resources: {
                cpu: spec.resources.cpu,
                memory: spec.resources.memoryGiB,
                disk: spec.resources.diskGiB,
              },
            }),
        envVars,
        ...(Object.keys(secretMounts).length > 0 ? { secrets: secretMounts } : {}),
        labels: {
          "t3x.task-id": spec.taskId,
          "t3x.managed": "true",
          ...(spec.snapshot ? { "t3x.profile": spec.snapshot } : {}),
        },
        autoStopInterval: Math.max(1, Math.round(spec.stopAfterIdleMinutes)),
      },
      { timeout: 300 },
    );
    const id = sandbox.id;

    // A fresh sandbox does not contain the profile's working directory, and
    // the toolbox refuses to run a command with a cwd that does not exist.
    // Create it (and its parents) before anything runs there.
    if (spec.workingDirectory) {
      const mkdir = await sandbox.process.executeCommand(
        `mkdir -p ${shellQuote(spec.workingDirectory)}`,
      );
      if (mkdir.exitCode !== 0) {
        throw new ExecutionError(
          "internal",
          `Could not create the working directory ${spec.workingDirectory} in sandbox ${id}: ` +
            `${mkdir.result ?? ""}`.trim(),
          { taskId: spec.taskId, sandboxId: id },
        );
      }
    }

    for (const step of spec.setup) {
      const result = await this.exec(id, step, { cwd: spec.workingDirectory, timeoutMs: 900_000 });
      if (result.exitCode !== 0) {
        throw new ExecutionError("internal", `Setup step failed (${result.exitCode}): ${step}`, {
          taskId: spec.taskId,
          sandboxId: id,
          stderr: result.stderr || result.stdout,
        });
      }
    }

    return {
      id,
      taskId: spec.taskId,
      backend: "daytona",
      workspaceRoot: spec.workingDirectory,
    };
  }

  /**
   * Header-injected credentials live in the organization and are referenced by
   * name from the sandbox, so the value never reaches the sandbox filesystem.
   */
  private async ensureOrgSecret(secret: SandboxSecret): Promise<string> {
    const hosts = secret.hostAllowlist ?? [];
    if (hosts.length === 0) {
      throw new ExecutionError(
        "sandbox_backend_unsupported",
        `Secret ${secret.name} is injected as headers but the profile declares no hostAllowlist; ` +
          "Daytona substitutes secrets only for declared hosts.",
        { secret: secret.name },
      );
    }
    if (!this.client.secret) {
      throw new SandboxBackendUnsupportedError("daytona", "header-injected secrets");
    }
    const name = `t3x-${secret.name}`;
    const existing = await this.findOrgSecret(name);
    if (existing?.id) {
      await this.client.secret.update(existing.id, { value: secret.value, hosts });
      return name;
    }
    await this.client.secret.create({ name, value: secret.value, hosts });
    return name;
  }

  private async findOrgSecret(name: string): Promise<DaytonaSecretLike | null> {
    if (!this.client.secret) return null;
    let cursor: string | undefined;
    do {
      const page = await this.client.secret.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      const hit = (page.items ?? []).find((item) => item.name === name);
      if (hit) return hit;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  }

  private async getSandbox(sandboxId: string): Promise<DaytonaSandboxLike> {
    try {
      return await this.client.get(sandboxId);
    } catch {
      throw new SandboxNotFoundError(sandboxId);
    }
  }

  private mapState(state: string | undefined): SandboxStatus["state"] {
    const value = (state ?? "creating").toLowerCase();
    if (value.startsWith("delet")) return "deleted";
    if (value.startsWith("stop")) return "stopped";
    if (value.startsWith("paus")) return "paused";
    if (value.startsWith("start") || value.startsWith("resum")) return "running";
    return "creating";
  }

  private mapStatus(sandbox: DaytonaSandboxLike): SandboxStatus {
    return {
      id: sandbox.id,
      taskId: null,
      backend: "daytona",
      state: this.mapState(sandbox.state),
      createdAt: sandbox.createdAt ? Date.parse(sandbox.createdAt) : 0,
      autoStopAt:
        typeof sandbox.autoStopInterval === "number" && sandbox.autoStopInterval > 0
          ? Date.now() + sandbox.autoStopInterval * 60_000
          : null,
      snapshot: sandbox.snapshot ?? null,
      resources: { cpu: sandbox.cpu ?? 0, memoryGiB: sandbox.memory ?? 0 },
    };
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    const sandbox = await this.getSandbox(sandboxId);
    await sandbox.refreshData?.().catch(() => undefined);
    return this.mapStatus(sandbox);
  }

  async list(): Promise<SandboxStatus[]> {
    const out: SandboxStatus[] = [];
    for await (const sandbox of this.client.list({ labels: { "t3x.managed": "true" } })) {
      if (sandbox.state === undefined) await sandbox.refreshData?.().catch(() => undefined);
      out.push(this.mapStatus(sandbox));
    }
    return out;
  }

  async start(sandboxId: string): Promise<void> {
    await (await this.getSandbox(sandboxId)).start();
  }

  async stop(sandboxId: string): Promise<void> {
    await (await this.getSandbox(sandboxId)).stop();
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    await this.client.delete(sandbox);
  }

  async snapshot(sandboxId: string, name: string): Promise<{ id: string }> {
    const sandbox = await this.getSandbox(sandboxId);
    // `createSnapshot` resolves when the snapshot is active; Daytona identifies
    // a snapshot by the name it was created with.
    await sandbox.createSnapshot(name);
    return { id: name };
  }

  async restoreSnapshot(_sandboxId: string, _snapshotId: string): Promise<void> {
    // The SDK has no restore primitive: a sandbox is created from a snapshot,
    // it cannot be rolled back to one.
    throw new SandboxBackendUnsupportedError("daytona", "restoreSnapshot");
  }

  async exec(sandboxId: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const sandbox = await this.getSandbox(sandboxId);
    const result = await sandbox.process.executeCommand(
      command,
      options.cwd,
      options.env,
      options.timeoutMs ? Math.max(1, Math.ceil(options.timeoutMs / 1000)) : undefined,
    );
    return {
      exitCode: result.exitCode,
      // The toolbox returns one combined stream; stderr is not separated.
      stdout: result.stdout ?? result.result ?? "",
      stderr: result.stderr ?? "",
      truncated: false,
    };
  }

  async readFile(sandboxId: string, filePath: string): Promise<Buffer> {
    const sandbox = await this.getSandbox(sandboxId);
    return Buffer.from(await sandbox.fs.downloadFile(filePath));
  }

  async writeFile(sandboxId: string, filePath: string, data: Buffer, mode?: number): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    await sandbox.fs.uploadFile(data, filePath);
    if (mode !== undefined) {
      // The SDK's upload takes no mode; set it explicitly, best effort.
      await sandbox.process
        .executeCommand(`chmod ${mode.toString(8)} ${shellQuote(filePath)}`)
        .catch(() => undefined);
    }
  }

  async listDir(sandboxId: string, dirPath: string): Promise<WorkspaceEntry[]> {
    const sandbox = await this.getSandbox(sandboxId);
    const entries = await sandbox.fs.listFiles(dirPath);
    return entries.map((entry) => {
      const stamp = entry.modifiedAt ?? entry.modTime;
      return {
        name: entry.name,
        path: `${dirPath.replace(/\/$/, "")}/${entry.name}`,
        kind: (entry.isDir ?? entry.isDirectory) ? "directory" : "file",
        size: entry.size ?? 0,
        modifiedAt: stamp ? Date.parse(stamp) || 0 : 0,
      };
    });
  }

  /**
   * Credentials are mounted at creation (`envVars` for environment secrets,
   * the organization secret service for header substitution). Daytona exposes
   * no way to attach either to a running sandbox, so this is refused rather
   * than silently ignored.
   */
  async injectSecrets(sandboxId: string, secrets: SandboxSecret[]): Promise<void> {
    if (secrets.length === 0) return;
    throw new ExecutionError(
      "sandbox_backend_unsupported",
      "Daytona injects credentials at sandbox creation; declare them in the profile " +
        "instead of injecting into a running sandbox.",
      { sandboxId, secrets: secrets.map((secret) => secret.name) },
    );
  }

  homeDir(_sandboxId: string): string {
    return "/home/daytona";
  }

  async writeConfigFiles(
    sandboxId: string,
    files: Array<{ path: string; content: string; mode?: number }>,
  ): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    for (const file of files) {
      const target = file.path.startsWith("~") ? `/home/daytona/${file.path.slice(2)}` : file.path;
      await sandbox.fs.uploadFile(Buffer.from(file.content, "utf8"), target);
      if (file.mode !== undefined) {
        await sandbox.process
          .executeCommand(`chmod ${file.mode.toString(8)} ${shellQuote(target)}`)
          .catch(() => undefined);
      }
    }
  }

  /**
   * Port-scoped preview link. Daytona scopes access with a per-sandbox token
   * rather than a deadline, so `expiresAt` is null and the token (when the
   * sandbox is private) travels in the `X-Daytona-Preview-Token` header.
   */
  async previewUrl(sandboxId: string, port: number, _ttlSeconds: number): Promise<PreviewLink> {
    const sandbox = await this.getSandbox(sandboxId);
    if (sandbox.getPreviewLink) {
      const link = await sandbox.getPreviewLink(port);
      return { url: link.url, token: link.token ?? null, expiresAt: null };
    }
    if (sandbox.getPreviewUrl) {
      return { url: await sandbox.getPreviewUrl(port), token: null, expiresAt: null };
    }
    throw new SandboxBackendUnsupportedError("daytona", "previewUrl");
  }
}

export const DEFAULT_DAYTONA_AUTO_STOP_MINUTES = 30;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
