/**
 * Typed errors for the execution system.
 *
 * Every failure that crosses a boundary here — client -> control plane ->
 * worker -> sandbox — carries a stable `code` so clients and tests can branch
 * on it without string matching.
 */

export type ExecutionErrorCode =
  | "task_not_found"
  | "task_state_invalid"
  | "profile_invalid"
  | "profile_not_found"
  | "execution_target_unavailable"
  | "sandbox_not_found"
  | "sandbox_backend_unsupported"
  | "lease_fenced"
  | "capability_unsupported"
  | "idempotency_conflict"
  | "protocol_violation"
  | "worker_unavailable"
  | "secret_policy_violation"
  | "secret_not_found"
  | "path_outside_workspace"
  | "approval_required"
  | "unauthorized"
  | "internal";

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ExecutionErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class TaskNotFoundError extends ExecutionError {
  constructor(taskId: string) {
    super("task_not_found", `Task ${taskId} does not exist.`, { taskId });
    this.name = "TaskNotFoundError";
  }
}

export class TaskStateError extends ExecutionError {
  constructor(taskId: string, from: string, detail: string) {
    super("task_state_invalid", `Task ${taskId} in state ${from}: ${detail}`, {
      taskId,
      from,
      detail,
    });
    this.name = "TaskStateError";
  }
}

export class ProfileNotFoundError extends ExecutionError {
  constructor(id: string) {
    super("profile_not_found", `Environment profile ${id} does not exist.`, { id });
    this.name = "ProfileNotFoundError";
  }
}

/**
 * Thrown whenever an operation needs the task's sandbox and cannot reach it.
 * A silent local fallback is the "especially dangerous failure" the report
 * warns about: a correct remote conversation while the Git diff viewer
 * inspects a different repository.
 */
export class ExecutionTargetUnavailableError extends ExecutionError {
  constructor(taskId: string, detail: string) {
    super(
      "execution_target_unavailable",
      `Execution target for task ${taskId} is unavailable: ${detail}`,
      { taskId, detail },
    );
    this.name = "ExecutionTargetUnavailableError";
  }
}

export class SandboxNotFoundError extends ExecutionError {
  constructor(sandboxId: string) {
    super("sandbox_not_found", `Sandbox ${sandboxId} does not exist.`, { sandboxId });
    this.name = "SandboxNotFoundError";
  }
}

export class SandboxBackendUnsupportedError extends ExecutionError {
  constructor(backend: string, operation: string) {
    super(
      "sandbox_backend_unsupported",
      `Sandbox backend ${backend} does not support ${operation}.`,
      { backend, operation },
    );
    this.name = "SandboxBackendUnsupportedError";
  }
}

/** Raised on both sides of the worker protocol when a lease was replaced. */
export class LeaseFencedError extends ExecutionError {
  constructor(taskId: string, staleEpoch: number, currentEpoch: number) {
    super(
      "lease_fenced",
      `Lease epoch ${staleEpoch} for task ${taskId} is fenced; current epoch is ${currentEpoch}.`,
      { taskId, staleEpoch, currentEpoch },
    );
    this.name = "LeaseFencedError";
  }
}

export class CapabilityUnsupportedError extends ExecutionError {
  constructor(driver: string, capability: string) {
    super("capability_unsupported", `Provider ${driver} does not support ${capability}.`, {
      driver,
      capability,
    });
    this.name = "CapabilityUnsupportedError";
  }
}

export class IdempotencyConflictError extends ExecutionError {
  constructor(effectId: string, detail: string) {
    super(
      "idempotency_conflict",
      `Effect ${effectId} was replayed with a different payload: ${detail}`,
      { effectId, detail },
    );
    this.name = "IdempotencyConflictError";
  }
}

export class ProtocolViolationError extends ExecutionError {
  constructor(detail: string, details: Record<string, unknown> = {}) {
    super("protocol_violation", `Worker protocol violation: ${detail}`, details);
    this.name = "ProtocolViolationError";
  }
}

export class WorkerUnavailableError extends ExecutionError {
  constructor(taskId: string, detail: string) {
    super("worker_unavailable", `No worker for task ${taskId}: ${detail}`, {
      taskId,
      detail,
    });
    this.name = "WorkerUnavailableError";
  }
}

export class SecretPolicyViolationError extends ExecutionError {
  constructor(detail: string, details: Record<string, unknown> = {}) {
    super("secret_policy_violation", `Secret policy violation: ${detail}`, details);
    this.name = "SecretPolicyViolationError";
  }
}

export class SecretNotFoundError extends ExecutionError {
  constructor(name: string) {
    super("secret_not_found", `Secret ${name} is not registered.`, { name });
    this.name = "SecretNotFoundError";
  }
}

export class PathOutsideWorkspaceError extends ExecutionError {
  constructor(path: string) {
    super("path_outside_workspace", `Path ${path} escapes the task workspace root.`, {
      path,
    });
    this.name = "PathOutsideWorkspaceError";
  }
}

export function isExecutionError(value: unknown): value is ExecutionError {
  return value instanceof ExecutionError;
}

/** Serialize any thrown value into a protocol-safe payload. */
export function errorPayload(value: unknown): {
  code: ExecutionErrorCode | "unknown";
  message: string;
  details: Record<string, unknown>;
} {
  if (isExecutionError(value)) {
    return { code: value.code, message: value.message, details: value.details };
  }
  if (value instanceof Error) {
    return { code: "unknown", message: value.message, details: {} };
  }
  return { code: "unknown", message: String(value), details: {} };
}
