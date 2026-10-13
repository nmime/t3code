/**
 * Execution target resolution.
 *
 * The provider instance is an agent configuration; the execution target
 * decides where it runs. Resolving one never implies the other.
 */

import type { ExecutionTarget, TaskRecord } from "../contracts/execution.js";
import { ExecutionError } from "../contracts/errors.js";

export interface ExecutionTargetResolver {
  resolve(task: TaskRecord): ExecutionTarget;
}

export class DefaultExecutionTargetResolver implements ExecutionTargetResolver {
  resolve(task: TaskRecord): ExecutionTarget {
    if (task.sandboxId) {
      return {
        kind: "sandbox",
        taskId: task.taskId,
        sandboxId: task.sandboxId,
        environmentProfileVersion: `${task.profileId}#${task.profileDigest.slice(0, 12)}`,
      };
    }
    if (task.state === "pending") {
      throw new ExecutionError(
        "execution_target_unavailable",
        `Task ${task.taskId} has no execution target until it is provisioned.`,
        { taskId: task.taskId },
      );
    }
    return { kind: "local" };
  }
}
