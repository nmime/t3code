/**
 * Cost and retention policy (report §5 "Cost controls", revised for sandbox
 * scope).
 *
 * The orchestrator must not rely on infrastructure idleness to decide that an
 * agent has finished: automatic stopping is disabled while a task is actively
 * executing, idle tasks are stopped, and completed environments are deleted
 * only after their outputs are safely retained.
 *
 * Project sandboxes add a second level: they outlive their tasks, so they are
 * evaluated on their own — and only ever stopped or destroyed when the
 * reference count is zero. A sandbox with tasks still bound to it is never
 * touched, whatever the timers say.
 */

import type { TaskRecord } from "../contracts/execution.js";
import type { EventStore } from "./EventStore.js";
import type { ProjectSandboxStore } from "./ProjectSandboxStore.js";

export interface PolicyDecision {
  /** "task" decisions act on one task; "sandbox" decisions on a project sandbox. */
  scope: "task" | "sandbox";
  taskId: string;
  sandboxId?: string | null;
  action: "none" | "stop" | "destroy";
  reason: string;
}

export interface PolicyConfig {
  idleStopMinutes: number;
  deleteCompletedAfterHours: number;
  enforceBudget: boolean;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  idleStopMinutes: 30,
  deleteCompletedAfterHours: 48,
  enforceBudget: true,
};

export class PolicyEngine {
  constructor(
    private readonly store: EventStore,
    private readonly config: PolicyConfig = DEFAULT_POLICY_CONFIG,
    private readonly projects: ProjectSandboxStore | null = null,
  ) {}

  evaluate(now = Date.now()): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];
    for (const task of this.store.listTasks()) {
      const decision = this.evaluateTask(task, now);
      if (decision) decisions.push(decision);
    }
    for (const decision of this.evaluateSandboxes(now)) decisions.push(decision);
    return decisions;
  }

  private evaluateTask(task: TaskRecord, now: number): PolicyDecision | null {
    // Active execution never auto-stops.
    if (
      task.state === "running" ||
      task.state === "provisioning" ||
      task.state === "restoring"
    ) {
      return null;
    }

    if (
      this.config.enforceBudget &&
      task.budgetCents !== null &&
      task.spentCents > task.budgetCents &&
      (task.state === "ready" || task.state === "waiting")
    ) {
      return {
        scope: "task",
        taskId: task.taskId,
        sandboxId: task.sandboxId,
        action: "stop",
        reason: `budget exceeded (${task.spentCents} > ${task.budgetCents} cents)`,
      };
    }

    if (task.state === "ready" && task.idleSince !== null) {
      const idleMs = now - task.idleSince;
      const limitMs =
        Math.min(this.config.idleStopMinutes, task.profile.body.sandbox.stopAfterIdleMinutes) *
        60_000;
      if (idleMs > limitMs) {
        return {
          scope: "task",
          taskId: task.taskId,
          sandboxId: task.sandboxId,
          action: "stop",
          reason: `idle for ${Math.round(idleMs / 60_000)} minutes`,
        };
      }
    }

    if ((task.state === "completed" || task.state === "failed") && task.completedAt !== null) {
      const retentionMs =
        Math.min(
          this.config.deleteCompletedAfterHours,
          task.profile.body.sandbox.deleteAfterCompletedHours,
        ) * 3_600_000;
      if (now - task.completedAt > retentionMs) {
        return {
          scope: "task",
          taskId: task.taskId,
          sandboxId: task.sandboxId,
          action: "destroy",
          reason: `completed ${Math.round((now - task.completedAt) / 3_600_000)} hours ago`,
        };
      }
    }

    return null;
  }

  /**
   * Project sandboxes are stopped when they have been unused for longer than
   * the idle window and deleted after the retention window — but never while a
   * task still holds a reference to them.
   */
  private evaluateSandboxes(now: number): PolicyDecision[] {
    if (!this.projects) return [];
    const decisions: PolicyDecision[] = [];
    for (const sandbox of this.projects.listSandboxes()) {
      if (sandbox.state === "deleted") continue;
      const bound = this.projects.taskCount(sandbox.sandboxId);
      if (bound > 0) continue;

      const idleMs = now - sandbox.lastUsedAt;
      const idleLimitMs = this.config.idleStopMinutes * 60_000;
      if (sandbox.state === "running" && idleMs > idleLimitMs) {
        decisions.push({
          scope: "sandbox",
          taskId: sandbox.sandboxId,
          sandboxId: sandbox.sandboxId,
          action: "stop",
          reason: `project sandbox unused for ${Math.round(idleMs / 60_000)} minutes`,
        });
        continue;
      }

      const retentionMs = this.config.deleteCompletedAfterHours * 3_600_000;
      if (sandbox.state === "stopped" && idleMs > retentionMs) {
        decisions.push({
          scope: "sandbox",
          taskId: sandbox.sandboxId,
          sandboxId: sandbox.sandboxId,
          action: "destroy",
          reason: `project sandbox unused for ${Math.round(idleMs / 3_600_000)} hours`,
        });
      }
    }
    return decisions;
  }
}
