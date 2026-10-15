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
    const report = await this.reconcileSafely();
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
    const report = await this.reconcileSafely();
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

  /**
   * Reconcile, but never throw.
   *
   * Measured on the deployment: rebuilding the sandbox image left paused
   * sandboxes pointing at an image id that no longer existed, the provider's
   * `GET /v1/sandboxes` started answering 500, and the sweep's rejection was
   * unhandled — Node exited, systemd restarted the process, the boot reconcile
   * hit the same 500, and the loop created a sandbox on every attempt.
   *
   * A provider that cannot be listed is an outage of the *provider*: the API,
   * the event log and every task bound to a live worker are still usable, so
   * the failure is reported and retried on the next sweep instead of killing
   * the control plane.
   */
  private async reconcileSafely(): Promise<ReconcileReport> {
    try {
      return await this.deps.controlPlane.reconcile();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`t3x: reconcile failed, continuing: ${message}`);
      return {
        checked: 0,
        reattached: 0,
        restored: 0,
        stopped: 0,
        renewed: 0,
        destroyedOrphans: 0,
        notes: [`reconcile failed: ${message}`],
      };
    }
  }
}
