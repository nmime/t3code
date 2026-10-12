/**
 * Local sandbox backend.
 *
 * A real, process-and-filesystem backed implementation of SandboxBackend used
 * by `executionTarget = local` development and by the test suite. Every task
 * gets its own directory tree, its own secret file (mode 0600), its own
 * snapshots and its own process table, so the isolation guarantees the
 * architecture promises are actually exercised instead of mocked away.
 */

import { spawn } from "node:child_process";
import { createHmac, randomBytes, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { SandboxHandle, SandboxStatus, WorkspaceEntry } from "../../contracts/execution.js";
import { SandboxNotFoundError, ExecutionError } from "../../contracts/errors.js";
import { newSandboxId } from "../../contracts/ids.js";
import type { ExecOptions, ExecResult, SandboxBackend, SandboxSpec } from "./SandboxBackend.js";

interface SandboxMeta {
  id: string;
  taskId: string | null;
  state: SandboxStatus["state"];
  createdAt: number;
  autoStopAt: number | null;
  snapshot: string | null;
  resources: { cpu: number; memoryGiB: number };
  env: Record<string, string>;
  workingDirectory: string;
  secrets: string[];
  previewKey: string;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

export class LocalBackend implements SandboxBackend {
  readonly kind = "local" as const;
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private sandboxDir(sandboxId: string): string {
    return path.join(this.root, sandboxId);
  }

  private workspaceDir(sandboxId: string): string {
    return path.join(this.sandboxDir(sandboxId), "workspace");
  }

  private snapshotsDir(): string {
    return path.join(this.root, "_snapshots");
  }

  private metaPath(sandboxId: string): string {
    return path.join(this.sandboxDir(sandboxId), "meta.json");
  }

  private async readMeta(sandboxId: string): Promise<SandboxMeta> {
    const p = this.metaPath(sandboxId);
    if (!existsSync(p)) throw new SandboxNotFoundError(sandboxId);
    return JSON.parse(await fs.readFile(p, "utf8")) as SandboxMeta;
  }

  private async writeMeta(meta: SandboxMeta): Promise<void> {
    await fs.writeFile(this.metaPath(meta.id), JSON.stringify(meta, null, 2), "utf8");
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const id = newSandboxId();
    const dir = this.sandboxDir(id);
    await fs.mkdir(path.join(dir, "workspace"), { recursive: true });
    await fs.mkdir(path.join(dir, "state"), { recursive: true });

    const meta: SandboxMeta = {
      id,
      taskId: spec.taskId,
      state: "running",
      createdAt: Date.now(),
      autoStopAt: Date.now() + spec.stopAfterIdleMinutes * 60_000,
      snapshot: spec.snapshot,
      resources: { cpu: spec.resources.cpu, memoryGiB: spec.resources.memoryGiB },
      env: { ...spec.env },
      workingDirectory: spec.workingDirectory,
      secrets: [],
      previewKey: randomBytes(32).toString("hex"),
    };
    await this.writeMeta(meta);
    if (spec.secrets.length > 0) await this.injectSecrets(id, spec.secrets);

    return {
      id,
      taskId: spec.taskId,
      backend: "local",
      workspaceRoot: this.workspaceDir(id),
    };
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    const meta = await this.readMeta(sandboxId);
    return {
      id: meta.id,
      taskId: meta.taskId,
      backend: "local",
      state: meta.state,
      createdAt: meta.createdAt,
      autoStopAt: meta.autoStopAt,
      snapshot: meta.snapshot,
      resources: meta.resources,
    };
  }

  async list(): Promise<SandboxStatus[]> {
    if (!existsSync(this.root)) return [];
    const names = await fs.readdir(this.root);
    const out: SandboxStatus[] = [];
    for (const name of names) {
      if (name.startsWith("_")) continue;
      if (!existsSync(this.metaPath(name))) continue;
      out.push(await this.status(name));
    }
    return out;
  }

  async start(sandboxId: string): Promise<void> {
    const meta = await this.readMeta(sandboxId);
    if (meta.state === "deleted") {
      throw new ExecutionError(
        "sandbox_not_found",
        `Sandbox ${sandboxId} was deleted and cannot be started.`,
        { sandboxId },
      );
    }
    meta.state = "running";
    meta.autoStopAt = Date.now() + 60 * 60_000;
    await this.writeMeta(meta);
  }

  async stop(sandboxId: string): Promise<void> {
    const meta = await this.readMeta(sandboxId);
    meta.state = "stopped";
    await this.writeMeta(meta);
  }

  async destroy(sandboxId: string): Promise<void> {
    const dir = this.sandboxDir(sandboxId);
    if (!existsSync(dir)) return;
    await fs.rm(dir, { recursive: true, force: true });
  }

  async snapshot(sandboxId: string, name: string): Promise<{ id: string }> {
    const meta = await this.readMeta(sandboxId);
    const id = `snap_${createHash("sha256")
      .update(`${sandboxId}:${name}:${Date.now()}`)
      .digest("hex")
      .slice(0, 16)}`;
    const dest = path.join(this.snapshotsDir(), id);
    await fs.mkdir(this.snapshotsDir(), { recursive: true });
    await fs.cp(this.workspaceDir(sandboxId), dest, { recursive: true });
    await fs.writeFile(
      path.join(this.snapshotsDir(), `${id}.json`),
      JSON.stringify({ id, name, sandboxId, taskId: meta.taskId, createdAt: Date.now() }, null, 2),
      "utf8",
    );
    return { id };
  }

  async restoreSnapshot(sandboxId: string, snapshotId: string): Promise<void> {
    const src = path.join(this.snapshotsDir(), snapshotId);
    if (!existsSync(src)) {
      throw new ExecutionError("sandbox_not_found", `Snapshot ${snapshotId} does not exist.`, {
        snapshotId,
      });
    }
    const dest = this.workspaceDir(sandboxId);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(src, dest, { recursive: true });
  }

  /**
   * Path translation.
   *
   * The control plane speaks in sandbox-absolute paths (`/workspace/project`,
   * `/workspace/worktrees/<taskId>`), exactly as a Daytona sandbox would see
   * them. Locally the sandbox *is* a directory tree, so those paths are mapped
   * onto `<root>/<sandboxId>/...`; a relative path is resolved against the
   * sandbox's workspace. Anything that escapes the sandbox tree is refused.
   */
  private resolveInSandbox(sandboxId: string, target: string): string {
    const root = this.sandboxDir(sandboxId);
    const resolved = path.isAbsolute(target)
      ? target === root || target.startsWith(root + path.sep)
        ? path.resolve(target)
        : path.join(root, target)
      : path.resolve(root, "workspace", target);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ExecutionError("path_outside_workspace", `Path ${target} escapes sandbox ${sandboxId}.`, {
        sandboxId,
        target,
      });
    }
    return resolved;
  }

  private resolveInWorkspace(sandboxId: string, target: string): string {
    const root = this.workspaceDir(sandboxId);
    const resolved = path.isAbsolute(target)
      ? target === root || target.startsWith(root + path.sep)
        ? path.resolve(target)
        : this.resolveInSandbox(sandboxId, target)
      : path.resolve(root, target);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ExecutionError(
        "path_outside_workspace",
        `Path ${target} escapes sandbox ${sandboxId} workspace.`,
        { sandboxId, target },
      );
    }
    return resolved;
  }

  async exec(sandboxId: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const meta = await this.readMeta(sandboxId);
    if (meta.state !== "running") {
      throw new ExecutionError(
        "execution_target_unavailable",
        `Sandbox ${sandboxId} is ${meta.state}.`,
        { sandboxId, state: meta.state },
      );
    }
    // The working directory is a sandbox-absolute path ("/workspace/project"),
    // translated into this sandbox's directory tree.
    const cwd = options.cwd
      ? this.resolveInSandbox(sandboxId, options.cwd)
      : this.resolveInSandbox(sandboxId, meta.workingDirectory);
    await fs.mkdir(cwd, { recursive: true });

    const secrets = await this.readSecrets(sandboxId);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...meta.env,
      ...secrets,
      ...(options.env ?? {}),
      T3X_SANDBOX_ID: sandboxId,
      T3X_TASK_ID: meta.taskId ?? "",
    };

    const timeoutMs = options.timeoutMs ?? 120_000;
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-lc", command], { cwd, env });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          stdout += chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - stdout.length)).toString("utf8");
          child.kill("SIGKILL");
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          stderr += chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - stderr.length)).toString("utf8");
          child.kill("SIGKILL");
          return;
        }
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        truncated = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr, truncated });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        stderr += String(err);
        resolve({ exitCode: 127, stdout, stderr, truncated });
      });
    });
  }

  async readFile(sandboxId: string, target: string): Promise<Buffer> {
    return await fs.readFile(this.resolveInWorkspace(sandboxId, target));
  }

  async writeFile(sandboxId: string, target: string, data: Buffer, mode?: number): Promise<void> {
    const p = this.resolveInWorkspace(sandboxId, target);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data, mode !== undefined ? { mode } : undefined);
  }

  async listDir(sandboxId: string, target: string): Promise<WorkspaceEntry[]> {
    const p = this.resolveInWorkspace(sandboxId, target);
    const names = await fs.readdir(p);
    const out: WorkspaceEntry[] = [];
    for (const name of names) {
      const st = await fs.lstat(path.join(p, name));
      out.push({
        name,
        path: path.posix.join(target, name),
        kind: st.isFile()
          ? "file"
          : st.isDirectory()
            ? "directory"
            : st.isSymbolicLink()
              ? "symlink"
              : "other",
        size: st.size,
        modifiedAt: st.mtimeMs,
      });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async injectSecrets(
    sandboxId: string,
    secrets: Array<{ name: string; value: string; inject: "env" | "headers" }>,
  ): Promise<void> {
    const meta = await this.readMeta(sandboxId);
    const file = path.join(this.sandboxDir(sandboxId), "secrets.env");
    const existing = await this.readSecrets(sandboxId);
    for (const secret of secrets) {
      if (secret.inject === "env") existing[secret.name] = secret.value;
    }
    const body = Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    await fs.writeFile(file, body, { mode: 0o600 });
    meta.secrets = Object.keys(existing);
    await this.writeMeta(meta);
  }

  homeDir(sandboxId: string): string {
    return path.join(this.sandboxDir(sandboxId), "home");
  }

  async writeConfigFiles(
    sandboxId: string,
    files: Array<{ path: string; content: string; mode?: number }>,
  ): Promise<void> {
    const home = this.homeDir(sandboxId);
    await fs.mkdir(home, { recursive: true });
    for (const file of files) {
      const target = file.path.startsWith("~/")
        ? path.join(home, file.path.slice(2))
        : path.isAbsolute(file.path)
          ? this.resolveInSandbox(sandboxId, file.path)
          : path.join(home, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        file.content,
        file.mode !== undefined ? { mode: file.mode } : undefined,
      );
    }
  }

  private async readSecrets(sandboxId: string): Promise<Record<string, string>> {
    const file = path.join(this.sandboxDir(sandboxId), "secrets.env");
    if (!existsSync(file)) return {};
    const body = await fs.readFile(file, "utf8");
    const out: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  }

  /** Signed, port-scoped, expiring preview URL. */
  async previewUrl(sandboxId: string, port: number, ttlSeconds: number): Promise<string> {
    const meta = await this.readMeta(sandboxId);
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = createHmac("sha256", meta.previewKey)
      .update(`${sandboxId}:${port}:${exp}`)
      .digest("hex")
      .slice(0, 32);
    return `http://127.0.0.1:${port}/?t3x-preview=${sig}&sandbox=${sandboxId}&exp=${exp}`;
  }
}
