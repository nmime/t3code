/**
 * Core execution contracts (report §7).
 *
 * The boundary the report insists on keeping separate:
 *
 *   execution target routing  !=  provider selection
 *
 * `executionTarget` decides *where* a task runs (local machine or a Daytona
 * sandbox); `providerInstanceId` decides *which agent* runs there.
 */

import type {
  ProviderCapabilities,
  ProviderInventoryEntry,
  ProviderEventPayload,
  SessionOpenPayload,
} from "./workerProtocol.js";
import type { ResolvedProfile } from "./environmentProfile.js";
import type { SandboxScope } from "./sandboxScope.js";

export type { TaskExecutionBinding, SandboxScope } from "./sandboxScope.js";

export type ExecutionTarget =
  | { kind: "local" }
  | {
      kind: "daytona";
      taskId: string;
      sandboxId: string;
      environmentProfileVersion: string;
    };

export type TaskExecutionState =
  | "pending"
  | "provisioning"
  | "ready"
  | "running"
  | "waiting"
  | "suspended"
  | "restoring"
  | "completed"
  | "failed";

/**
 * "Resume task" reconnects to the same sandbox and continues the native
 * session where supported; "restore task" recreates an environment and may
 * create a new native agent session. The distinction is surfaced to users
 * because claiming a deleted native session was seamlessly resumed would be
 * misleading.
 */
export type TaskResumeKind = "fresh" | "resumed" | "restored" | null;

export interface TaskRecord {
  taskId: string;
  threadId: string;
  state: TaskExecutionState;
  resumeKind: TaskResumeKind;

  /**
   * Sandbox scope decided at creation time (report follow-up: shared sandbox
   * per project by default, dedicated sandbox on request). Never re-resolved
   * for a running task, so changing a default cannot migrate it.
   */
  sandboxScope: SandboxScope;
  projectId: string | null;

  profileId: string;
  profileDigest: string;
  profile: ResolvedProfile;

  /** Agent selection — independent from the execution target. */
  provider: string;
  providerInstanceId: string;
  model: string;
  permissionMode: "supervised" | "auto";

  executionTarget: ExecutionTarget;
  sandboxId: string | null;
  /** Sandbox-absolute base checkout directory (the project sandbox's repo). */
  workspaceRoot: string;
  /**
   * Sandbox-absolute directory the agent works in. In a shared project sandbox
   * this is the task's own git worktree; for a dedicated sandbox it is the
   * checkout itself.
   */
  worktreePath: string;
  worktreeBranch: string;
  repositoryUrl: string;
  branch: string;

  leaseEpoch: number;
  lastEventSequence: number;

  createdAt: number;
  updatedAt: number;
  idleSince: number | null;
  completedAt: number | null;

  /** Coarse cost tracking for the policy engine. */
  budgetCents: number | null;
  spentCents: number;
}

/** Legal transitions (report §5 "Task state machine"). */
export const TASK_STATE_TRANSITIONS: Record<TaskExecutionState, TaskExecutionState[]> = {
  pending: ["provisioning", "failed"],
  provisioning: ["ready", "failed", "suspended"],
  ready: ["running", "waiting", "suspended", "completed", "failed", "restoring"],
  running: ["waiting", "ready", "suspended", "completed", "failed", "restoring"],
  waiting: ["running", "ready", "suspended", "completed", "failed", "restoring"],
  suspended: ["restoring", "ready", "completed", "failed"],
  restoring: ["ready", "failed", "completed"],
  completed: ["restoring"],
  failed: ["restoring"],
};

export const TERMINAL_TASK_STATES: TaskExecutionState[] = ["completed", "failed"];

export function canTransition(from: TaskExecutionState, to: TaskExecutionState): boolean {
  return TASK_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface SandboxControlPlane {
  provision(taskId: string): Promise<void>;
  ensureReady(taskId: string): Promise<void>;
  stop(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  destroy(taskId: string): Promise<void>;
  /** Bring persisted state and real sandboxes back into agreement. */
  reconcile(): Promise<ReconcileReport>;
}

export interface ReconcileReport {
  checked: number;
  reattached: number;
  restored: number;
  stopped: number;
  destroyedOrphans: number;
  notes: string[];
}

/**
 * Every file, git and checkpoint operation for a task resolves through its
 * execution target. There is no local fallback path by design: a correct
 * remote conversation must never be paired with diffs read from a different
 * repository.
 */
export interface WorkspaceExecution {
  readFile(taskId: string, path: string): Promise<Buffer>;
  writeFile(taskId: string, path: string, data: Buffer): Promise<void>;
  listDir(taskId: string, path: string): Promise<WorkspaceEntry[]>;
  execute(
    taskId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; output: string }>;
  gitStatus(taskId: string): Promise<GitStatus>;
  gitDiff(taskId: string, options?: { staged?: boolean; ref?: string }): Promise<string>;
  captureCheckpoint(taskId: string, checkpointId: string, label?: string): Promise<void>;
  restoreCheckpoint(
    taskId: string,
    checkpointId: string,
    options?: { cleanUntracked?: boolean },
  ): Promise<void>;
  diffCheckpoints(
    taskId: string,
    fromCheckpointId: string | null,
    toCheckpointId: string | null,
  ): Promise<string>;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: number;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: Array<{
    path: string;
    index: string;
    worktree: string;
    renamedFrom?: string;
    untracked?: boolean;
  }>;
  /** Hidden checkpoint refs known to the sandbox. */
  checkpoints: string[];
}

/**
 * The provider-neutral session/turn surface. The VPS side implements it by
 * proxying over the worker protocol (RemoteProviderAdapter); the sandbox side
 * implements it by hosting the provider runtimes. It mirrors the operation set
 * of T3's `ProviderAdapterV2`.
 */
export interface ProviderRuntimePort {
  readonly driver: string;
  capabilities(): ProviderCapabilities;
  inventory(): ProviderInventoryEntry;

  openSession(input: SessionOpenPayload): Promise<void>;
  closeSession(providerSessionId: string): Promise<void>;
  ensureThread(input: {
    threadId: string;
    title?: string;
    providerSessionId?: string;
    existingProviderThread?: unknown;
    model: string;
    runtimePolicy: SessionOpenPayload["runtimePolicy"];
  }): Promise<{ providerThreadId: string }>;
  resumeThread(input: { threadId: string; providerThreadId: string }): Promise<void>;
  startTurn(input: {
    threadId: string;
    runId: string;
    runOrdinal: number;
    providerTurnOrdinal: number;
    attemptId: string;
    message: {
      messageId: string;
      text: string;
      attachments: unknown[];
      createdBy: string;
      creationSource: string;
    };
    model: string;
    runtimePolicy: SessionOpenPayload["runtimePolicy"];
  }): Promise<void>;
  interrupt(input: { threadId: string; runId: string; providerTurnId: string }): Promise<void>;
  steer(input: {
    threadId: string;
    runId: string;
    providerTurnId: string;
    text: string;
  }): Promise<void>;
  respondRuntimeRequest(input: {
    requestId: string;
    decision: "approved" | "rejected" | "cancelled";
    answer?: unknown;
  }): Promise<void>;
  rollbackThread(input: {
    threadId: string;
    providerThreadId: string;
    checkpointId?: string;
  }): Promise<void>;
  forkThread(input: { threadId: string; providerThreadId: string }): Promise<void>;

  events(): AsyncIterable<ProviderEventPayload>;
}

export interface SandboxHandle {
  id: string;
  taskId: string;
  backend: "local" | "daytona";
  workspaceRoot: string;
}

export interface SandboxStatus {
  id: string;
  taskId: string | null;
  backend: "local" | "daytona";
  state: "creating" | "running" | "stopped" | "paused" | "deleted";
  createdAt: number;
  autoStopAt: number | null;
  snapshot: string | null;
  resources: { cpu: number; memoryGiB: number };
}
