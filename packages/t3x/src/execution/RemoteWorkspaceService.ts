/**
 * Remote workspace service (report §2 Finding C, revised for sandbox scope).
 *
 * Every file, git and checkpoint operation for a task is routed to the task's
 * sandbox worker, and — in a shared project sandbox — to *that task's worktree*
 * inside it. There is deliberately no local fallback: if the worker is not
 * reachable the call fails with ExecutionTargetUnavailableError rather than
 * silently reading a different repository on the VPS.
 */

import * as path from "node:path";
import type { GitStatus, WorkspaceEntry, WorkspaceExecution } from "../contracts/execution.js";
import { ExecutionTargetUnavailableError, PathOutsideWorkspaceError } from "../contracts/errors.js";
import type {
  CheckpointCapturePayload,
  CheckpointDiffPayload,
  CheckpointRestorePayload,
  WorkspaceExecPayload,
  WorkspaceGitPayload,
  WorkspaceListPayload,
  WorkspaceReadPayload,
  WorkspaceWorktreePayload,
  WorkspaceWritePayload,
} from "../contracts/workerProtocol.js";
import type { EventStore } from "./EventStore.js";
import type { WorkerCommandContext, WorkerConnectionRegistry } from "./WorkerConnectionRegistry.js";
import type { WorkerPathMapper } from "./WorkerPathMapper.js";

export interface WorktreeEntry {
  path: string;
  branch: string;
}

export class RemoteWorkspaceService implements WorkspaceExecution {
  constructor(
    private readonly store: EventStore,
    private readonly registry: WorkerConnectionRegistry,
    private readonly paths: WorkerPathMapper = (_sandboxId, sandboxPath) => sandboxPath,
  ) {}

  /**
   * Worker-space root of the task's own working directory: its worktree in a
   * shared project sandbox, or the sandbox checkout for a dedicated one.
   */
  rootFor(taskId: string): string | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    const sandboxPath = task.worktreePath || task.workspaceRoot;
    if (!sandboxPath) return undefined;
    return this.paths(task.sandboxId, sandboxPath);
  }

  private async call<T>(
    taskId: string,
    type:
      | "workspace.exec"
      | "workspace.read"
      | "workspace.write"
      | "workspace.list"
      | "workspace.git"
      | "workspace.worktree"
      | "checkpoint.capture"
      | "checkpoint.restore"
      | "checkpoint.diff",
    payload: unknown,
  ): Promise<T> {
    const task = this.store.getTask(taskId);
    if (!task) throw new ExecutionTargetUnavailableError(taskId, "unknown task");
    if (!this.registry.isConnected(taskId)) {
      throw new ExecutionTargetUnavailableError(
        taskId,
        `task state is ${task.state} and no worker is attached`,
      );
    }
    const ctx: WorkerCommandContext = { effectId: `ws_${taskId}_${type}_${Date.now()}` };
    return (await this.registry.sendCommand(taskId, type, payload as never, ctx)) as T;
  }

  /** Workspace-relative resolution with an escape guard. */
  private guard(taskId: string, target: string): string {
    const normalized = path.posix.normalize(target.startsWith("/") ? `.${target}` : target);
    if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
      throw new PathOutsideWorkspaceError(target);
    }
    void taskId;
    return normalized;
  }

  private withRoot<T extends object>(taskId: string, payload: T): T & { root?: string } {
    const root = this.rootFor(taskId);
    return root ? { ...payload, root } : payload;
  }

  async readFile(taskId: string, target: string): Promise<Buffer> {
    const payload = this.withRoot<WorkspaceReadPayload>(taskId, {
      path: this.guard(taskId, target),
      encoding: "base64",
    });
    const result = await this.call<{ dataBase64: string }>(taskId, "workspace.read", payload);
    return Buffer.from(result.dataBase64, "base64");
  }

  async writeFile(taskId: string, target: string, data: Buffer): Promise<void> {
    const payload = this.withRoot<WorkspaceWritePayload>(taskId, {
      path: this.guard(taskId, target),
      dataBase64: data.toString("base64"),
    });
    await this.call(taskId, "workspace.write", payload);
  }

  async listDir(taskId: string, target: string): Promise<WorkspaceEntry[]> {
    const payload = this.withRoot<WorkspaceListPayload>(taskId, {
      path: this.guard(taskId, target),
    });
    const result = await this.call<{ entries: WorkspaceEntry[] }>(
      taskId,
      "workspace.list",
      payload,
    );
    return result.entries;
  }

  async execute(
    taskId: string,
    command: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; output: string }> {
    const payload = this.withRoot<WorkspaceExecPayload>(taskId, {
      command,
      ...(options.cwd ? { cwd: this.guard(taskId, options.cwd) } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const result = await this.call<{ exitCode: number; output: string }>(
      taskId,
      "workspace.exec",
      payload,
    );
    return { exitCode: result.exitCode, output: result.output };
  }

  async gitStatus(taskId: string): Promise<GitStatus> {
    const payload = this.withRoot<WorkspaceGitPayload>(taskId, { operation: "status" });
    return await this.call<GitStatus>(taskId, "workspace.git", payload);
  }

  async gitDiff(taskId: string, options: { staged?: boolean; ref?: string } = {}): Promise<string> {
    const payload = this.withRoot<WorkspaceGitPayload>(taskId, {
      operation: "diff",
      args: [...(options.staged ? ["--cached"] : []), ...(options.ref ? [options.ref] : [])],
    });
    const result = await this.call<{ output: string }>(taskId, "workspace.git", payload);
    return result.output;
  }

  /** Git worktrees of the sandbox a task lives in (shared-sandbox visibility). */
  async listWorktrees(taskId: string): Promise<WorktreeEntry[]> {
    const payload = this.withRoot<WorkspaceWorktreePayload>(taskId, { operation: "list" });
    const result = await this.call<{ worktrees: WorktreeEntry[] }>(
      taskId,
      "workspace.worktree",
      payload,
    );
    return result.worktrees;
  }

  async captureCheckpoint(taskId: string, checkpointId: string, label?: string): Promise<void> {
    const payload = this.withRoot<CheckpointCapturePayload>(taskId, {
      checkpointId,
      ...(label ? { label } : {}),
    });
    const result = await this.call<{ digest: string }>(taskId, "checkpoint.capture", payload);
    this.store.recordCheckpoint(taskId, checkpointId, label, result.digest);
  }

  async restoreCheckpoint(
    taskId: string,
    checkpointId: string,
    options: { cleanUntracked?: boolean } = {},
  ): Promise<void> {
    const payload = this.withRoot<CheckpointRestorePayload>(taskId, {
      checkpointId,
      cleanUntracked: options.cleanUntracked ?? true,
    });
    await this.call(taskId, "checkpoint.restore", payload);
  }

  async diffCheckpoints(
    taskId: string,
    fromCheckpointId: string | null,
    toCheckpointId: string | null,
  ): Promise<string> {
    const payload = this.withRoot<CheckpointDiffPayload>(taskId, {
      fromCheckpointId,
      toCheckpointId,
    });
    const result = await this.call<{ output: string }>(taskId, "checkpoint.diff", payload);
    return result.output;
  }
}
