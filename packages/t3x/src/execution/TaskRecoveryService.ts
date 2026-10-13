/**
 * Task recovery service.
 *
 * On control-plane boot — and periodically afterwards — it brings the durable
 * state, the real sandboxes and the live workers back into agreement:
 *
 *  - stuck effects are requeued (a crash mid-effect must not strand a task),
 *  - tasks whose sandbox survived restart get their worker reattached and
 *    their event stream resumed from the last persisted sequence,
 *  - tasks whose sandbox was deleted are *restored* from the pinned profile
 *    and marked `restored`, never silently claimed as resumed,
 *  - policy decisions (idle stop, budget stop, retention destroy) are applied,
 *  - orphan sandboxes are cleaned up.
 */

import type { ReconcileReport } from "../contracts/execution.js";
import type { EventStore } from "./EventStore.js";
import type { SandboxControlPlane } from "./SandboxControlPlane.js";
import { PolicyEngine, type PolicyConfig, DEFAULT_POLICY_CONFIG } from "./PolicyEngine.js";
import type { TaskService } from "./TaskService.js";
import type { ProjectSandboxStore } from "./ProjectSandboxStore.js";

export interface TaskRecoveryDeps {
  store: EventStore;
  controlPlane: SandboxControlPlane;
  tasks: TaskService;
  policyConfig?: PolicyConfig;
  /** Project sandboxes are policy-evaluated separately from their tasks. */
  projects?: ProjectSandboxStore;
}

export class TaskRecoveryService {
  private readonly policy: PolicyEngine;

  constructor(private readonly deps: TaskRecoveryDeps) {
    this.policy = new PolicyEngine(
      deps.store,
      deps.policyConfig ?? DEFAULT_POLICY_CONFIG,
      deps.projects ?? null,
    );
  }

  /** Boot-time recovery. */
  async recover(): Promise<ReconcileReport> {
    const report = await this.deps.controlPlane.reconcile();
    this.deps.store.appendEvents("system", "recovery", [
      { type: "recovery.completed", payload: report as unknown as Record<string, unknown> },
    ]);
    return report;
  }

  /**
   * Periodic sweep: recovery plus policy enforcement. Returns what it did so
   * operators can see why a sandbox stopped or disappeared.
   */
  async sweep(): Promise<{ report: ReconcileReport; policyActions: string[] }> {
    const report = await this.deps.controlPlane.reconcile();
    const policyActions: string[] = [];

    for (const decision of this.policy.evaluate()) {
      try {
        if (decision.action === "stop") {
          if (decision.scope === "sandbox" && decision.sandboxId) {
            const stopped = await this.deps.controlPlane.stopSandbox(
              decision.sandboxId,
              decision.reason,
            );
            policyActions.push(
              `${decision.sandboxId}: ${stopped ? "stopped" : "stop refused"} (${decision.reason})`,
            );
          } else {
            this.deps.tasks.stop(decision.taskId);
            policyActions.push(`${decision.taskId}: stopped (${decision.reason})`);
          }
        } else if (decision.action === "destroy") {
          if (decision.scope === "sandbox" && decision.sandboxId) {
            const destroyed = await this.deps.controlPlane.destroySandbox(
              decision.sandboxId,
              decision.reason,
            );
            policyActions.push(
              `${decision.sandboxId}: ${destroyed ? "destroyed" : "destroy refused"} (${decision.reason})`,
            );
          } else {
            this.deps.tasks.destroy(decision.taskId);
            policyActions.push(`${decision.taskId}: destroyed (${decision.reason})`);
          }
        }
      } catch (err) {
        policyActions.push(`${decision.taskId}: policy action failed: ${(err as Error).message}`);
      }
    }

    return { report, policyActions };
  }
}
