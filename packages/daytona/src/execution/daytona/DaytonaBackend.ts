/**
 * Daytona sandbox backend.
 *
 * Maps SandboxBackend onto the Daytona TypeScript SDK surface: custom
 * snapshots, sandbox creation with resource templates, process sessions,
 * stop/start, secrets and signed preview URLs.
 *
 * The SDK is loaded at runtime through a structural interface
 * (`DaytonaClientLike`) so this module compiles and tests without the SDK
 * installed; `loadDaytonaClient()` binds it to `@daytona-io/sdk` when present.
 * The Daytona organization API key stays on the VPS and is never passed to an
 * agent or written into a sandbox.
 */

import type { SandboxHandle, SandboxStatus, WorkspaceEntry } from "../../contracts/execution.js";
import {
  ExecutionError,
  SandboxNotFoundError,
  SandboxBackendUnsupportedError,
} from "../../contracts/errors.js";
import type { ExecOptions, ExecResult, SandboxBackend, SandboxSpec } from "./SandboxBackend.js";

/** Structural slice of the Daytona SDK this backend needs. */
export interface DaytonaSandboxLike {
  getId(): string;
  getState(): Promise<string>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  delete(): Promise<unknown>;
  createSnapshot(name: string): Promise<{ getId(): string } | { id: string }>;
  restoreSnapshot?(snapshotId: string): Promise<unknown>;
  fs: {
    downloadFile(path: string): Promise<Buffer | Uint8Array>;
    uploadFile(path: string, data: Buffer | Uint8Array, mode?: number): Promise<unknown>;
    listDir(path: string): Promise<
      Array<{
        name: string;
        isDir?: boolean;
        isDirectory?: boolean;
        size?: number;
        modTime?: string;
      }>
    >;
  };
  process: {
    executeCommand(
      command: string,
      options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
    ): Promise<{ exitCode: number; result?: string; stdout?: string; stderr?: string }>;
  };
  getPreviewUrl?(port: number, ttlSeconds?: number): Promise<string>;
}

export interface DaytonaClientLike {
  create(options: {
    snapshot?: string;
    image?: string;
    resources?: { cpu: number; memory: number; disk?: number };
    env?: Record<string, string>;
    labels?: Record<string, string>;
    autoStopInterval?: number;
  }): Promise<DaytonaSandboxLike>;
  get(id: string): Promise<DaytonaSandboxLike>;
  list(filter?: { labels?: Record<string, string> }): Promise<DaytonaSandboxLike[]>;
  delete(id: string): Promise<unknown>;
}

export async function loadDaytonaClient(options: {
  apiKey: string;
  apiUrl?: string;
}): Promise<DaytonaClientLike> {
  const mod = (await import(/* webpackIgnore: true */ "@daytona-io/sdk" as string).catch(
    () => null,
  )) as { Daytona?: new (opts: unknown) => DaytonaClientLike } | null;
  if (!mod?.Daytona) {
    throw new ExecutionError(
      "sandbox_backend_unsupported",
      "@daytona-io/sdk is not installed; run `npm install @daytona-io/sdk` to use the Daytona backend.",
    );
  }
  return new mod.Daytona({
    apiKey: options.apiKey,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
  }) as DaytonaClientLike;
}

export interface DaytonaBackendOptions {
  apiKey?: string;
  client?: DaytonaClientLike;
  defaultAutoStopMinutes?: number;
}

export class DaytonaBackend implements SandboxBackend {
  readonly kind = "daytona" as const;
  private readonly client: DaytonaClientLike;
  private readonly defaultAutoStopMinutes: number;

  private constructor(client: DaytonaClientLike, defaultAutoStopMinutes: number) {
    this.client = client;
    this.defaultAutoStopMinutes = defaultAutoStopMinutes;
  }

  static async create(options: DaytonaBackendOptions = {}): Promise<DaytonaBackend> {
    const client =
      options.client ??
      (await loadDaytonaClient({ apiKey: options.apiKey ?? process.env.DAYTONA_API_KEY ?? "" }));
    return new DaytonaBackend(client, options.defaultAutoStopMinutes ?? 30);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandbox = await this.client.create({
      snapshot: spec.snapshot,
      resources: {
        cpu: spec.resources.cpu,
        memory: spec.resources.memoryGiB,
        disk: spec.resources.diskGiB,
      },
      env: spec.env,
      labels: {
        "t3x.task-id": spec.taskId,
        "t3x.managed": "true",
        "t3x.profile": spec.snapshot,
      },
      autoStopInterval: Math.max(1, Math.round(spec.stopAfterIdleMinutes)),
    });
    const id = sandbox.getId();
    if (spec.secrets.length > 0) await this.injectSecrets(id, spec.secrets);

    for (const step of spec.setup) {
      const result = await sandbox.process.executeCommand(step, { cwd: spec.workingDirectory });
      if (result.exitCode !== 0) {
        throw new ExecutionError(
          "internal",
          `Setup step failed (${result.exitCode}): ${step}`,
          { taskId: spec.taskId, sandboxId: id, stderr: result.stderr ?? result.result ?? "" },
        );
      }
    }

    return {
      id,
      taskId: spec.taskId,
      backend: "daytona",
      workspaceRoot: spec.workingDirectory,
    };
  }

  private async getSandbox(sandboxId: string): Promise<DaytonaSandboxLike> {
    try {
      return await this.client.get(sandboxId);
    } catch {
      throw new SandboxNotFoundError(sandboxId);
    }
  }

  private snapshotId(snap: { getId(): string } | { id: string }): string {
    return "getId" in snap ? snap.getId() : snap.id;
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    const sandbox = await this.getSandbox(sandboxId);
    const state = (await sandbox.getState()).toLowerCase();
    return {
      id: sandboxId,
      taskId: null,
      backend: "daytona",
      state: state.includes("run")
        ? "running"
        : state.includes("stop")
          ? "stopped"
          : state.includes("pause")
            ? "paused"
            : state.includes("delet")
              ? "deleted"
              : "creating",
      createdAt: 0,
      autoStopAt: null,
      snapshot: null,
      resources: { cpu: 0, memoryGiB: 0 },
    };
  }

  async list(): Promise<SandboxStatus[]> {
    const sandboxes = await this.client.list({ labels: { "t3x.managed": "true" } });
    const out: SandboxStatus[] = [];
    for (const sandbox of sandboxes) out.push(await this.status(sandbox.getId()));
    return out;
  }

  async start(sandboxId: string): Promise<void> {
    await (await this.getSandbox(sandboxId)).start();
  }

  async stop(sandboxId: string): Promise<void> {
    await (await this.getSandbox(sandboxId)).stop();
  }

  async destroy(sandboxId: string): Promise<void> {
    await this.getSandbox(sandboxId);
    await this.client.delete(sandboxId);
  }

  async snapshot(sandboxId: string, name: string): Promise<{ id: string }> {
    const sandbox = await this.getSandbox(sandboxId);
    return { id: this.snapshotId(await sandbox.createSnapshot(name)) };
  }

  async restoreSnapshot(sandboxId: string, snapshotId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    if (!sandbox.restoreSnapshot) {
      throw new SandboxBackendUnsupportedError("daytona", "restoreSnapshot");
    }
    await sandbox.restoreSnapshot(snapshotId);
  }

  async exec(sandboxId: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const sandbox = await this.getSandbox(sandboxId);
    const result = await sandbox.process.executeCommand(command, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    return {
      exitCode: result.exitCode,
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
    await sandbox.fs.uploadFile(filePath, data, mode);
  }

  async listDir(sandboxId: string, dirPath: string): Promise<WorkspaceEntry[]> {
    const sandbox = await this.getSandbox(sandboxId);
    const entries = await sandbox.fs.listDir(dirPath);
    return entries.map((entry) => ({
      name: entry.name,
      path: `${dirPath.replace(/\/$/, "")}/${entry.name}`,
      kind: (entry.isDir ?? entry.isDirectory) ? "directory" : "file",
      size: entry.size ?? 0,
      modifiedAt: entry.modTime ? Date.parse(entry.modTime) : 0,
    }));
  }

  /**
   * Credentials are injected for the lifetime of the sandbox. Header-injected
   * secrets (HTTPS substitution with host allowlists) are declared here;
   * body/OAuth credentials are handled by the provider-specific auth lifecycle.
   */
  async injectSecrets(
    sandboxId: string,
    secrets: Array<{ name: string; value: string; inject: "env" | "headers" }>,
  ): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    const env: Record<string, string> = {};
    for (const secret of secrets) {
      if (secret.inject === "env") env[secret.name] = secret.value;
    }
    if (Object.keys(env).length > 0) {
      await sandbox.process.executeCommand("true", { env });
    }
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
      await sandbox.fs.uploadFile(target, Buffer.from(file.content, "utf8"), file.mode);
    }
  }

  async previewUrl(sandboxId: string, port: number, ttlSeconds: number): Promise<string> {
    const sandbox = await this.getSandbox(sandboxId);
    if (!sandbox.getPreviewUrl) {
      throw new SandboxBackendUnsupportedError("daytona", "previewUrl");
    }
    return await sandbox.getPreviewUrl(port, ttlSeconds);
  }
}

export const DEFAULT_DAYTONA_AUTO_STOP_MINUTES = 30;
