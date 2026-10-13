/**
 * Effect worker.
 *
 * Claims durable effects from the outbox and executes them against the
 * sandbox world. Effects are idempotent by `effectId`:
 *
 *  - the store refuses to enqueue the same effect id with a different payload
 *    (IdempotencyConflictError),
 *  - commands carry the effect id to the worker, which keeps a processed
 *    ledger and replays the original result for a duplicate — so retrying
 *    `turn.start` after a crash can never launch the same turn twice.
 */

import type { EventStore, EffectRecord } from "./EventStore.js";
import type { SandboxControlPlane } from "./SandboxControlPlane.js";
import { RemoteProviderAdapter } from "../orchestration-v2/RemoteProviderAdapter.js";
import type { WorkerConnectionRegistry } from "./WorkerConnectionRegistry.js";
import { TaskStateMachine } from "./TaskStateMachine.js";
import { DEFAULT_RUNTIME_MODE } from "./TaskService.js";
import type { RemoteWorkspaceService } from "./RemoteWorkspaceService.js";
import { errorPayload } from "../contracts/errors.js";
import type { TaskRecord } from "../contracts/execution.js";

export interface EffectWorkerDeps {
  store: EventStore;
  controlPlane: SandboxControlPlane;
  registry: WorkerConnectionRegistry;
  workspace: RemoteWorkspaceService;
  pollIntervalMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
}

export class EffectWorker {
  private readonly store: EventStore;
  private readonly controlPlane: SandboxControlPlane;
  private readonly registry: WorkerConnectionRegistry;
  private readonly workspace: RemoteWorkspaceService;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly states: TaskStateMachine;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: EffectWorkerDeps) {
    this.store = deps.store;
    this.controlPlane = deps.controlPlane;
    this.registry = deps.registry;
    this.workspace = deps.workspace;
    this.pollIntervalMs = deps.pollIntervalMs ?? 50;
    this.maxAttempts = deps.maxAttempts ?? 5;
    this.retryBackoffMs = deps.retryBackoffMs ?? 250;
    this.states = new TaskStateMachine(deps.store);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One polling round; exposed so tests can drive execution deterministically. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const effects = this.store.claimDueEffects(10);
      for (const effect of effects) await this.execute(effect);
      return effects.length;
    } finally {
      this.running = false;
    }
  }

  /** Drain until no effects remain (tests, shutdown). */
  async drain(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i += 1) {
      const processed = await this.tick();
      if (processed === 0) return;
    }
  }

  private async execute(effect: EffectRecord): Promise<void> {
    try {
      const result = await this.dispatch(effect);
      this.store.completeEffect(effect.effectId, result);
      this.store.completeCommand(`fx:${effect.effectId}`, "completed", result);
    } catch (err) {
      const error = errorPayload(err);
      this.store.appendEvents(effect.taskId, "effect", [
        { type: "effect.failed", payload: { effectId: effect.effectId, kind: effect.kind, error } },
      ]);
      const retryInMs =
        effect.attempts < this.maxAttempts
          ? this.retryBackoffMs * Math.pow(2, effect.attempts)
          : null;
      // A turn that failed permanently must not leave the task stuck as
      // "running": release it back to ready so the user can try again.
      if (retryInMs === null && effect.kind === "turn.start") {
        try {
          const task = this.store.getTask(effect.taskId);
          if (task?.state === "running") {
            this.states.transition(effect.taskId, "ready", { reason: "turn_start_failed" });
          }
        } catch {
          // state already moved on
        }
      }
      this.store.failEffect(effect.effectId, error, retryInMs);
    }
  }

  private async dispatch(effect: EffectRecord): Promise<unknown> {
    const taskId = effect.taskId;
    const payload = effect.payload as Record<string, unknown>;

    switch (effect.kind) {
      case "task.provision":
        await this.controlPlane.provision(taskId);
        return { ok: true };
      case "task.ensure_ready":
        await this.controlPlane.ensureReady(taskId);
        return { ok: true };
      case "task.stop":
        await this.controlPlane.stop(taskId);
        return { ok: true };
      case "task.resume":
        await this.controlPlane.resume(taskId);
        return { ok: true };
      case "task.restore":
        await this.controlPlane.restore(taskId);
        return { ok: true };
      case "task.destroy":
        await this.controlPlane.destroy(taskId);
        return { ok: true };
      case "task.reconcile":
        return await this.controlPlane.reconcile();

      case "sandbox.stop": {
        const stopped = await this.controlPlane.stopSandbox(
          String(payload.sandboxId),
          String(payload.reason ?? "policy"),
        );
        return { stopped };
      }

      case "sandbox.destroy": {
        const destroyed = await this.controlPlane.destroySandbox(
          String(payload.sandboxId),
          String(payload.reason ?? "policy"),
        );
        return { destroyed };
      }

      case "checkpoint.capture": {
        const checkpointId = String(payload.checkpointId);
        await this.workspace.captureCheckpoint(
          taskId,
          checkpointId,
          payload.label ? String(payload.label) : undefined,
        );
        return { checkpointId };
      }
      case "checkpoint.restore": {
        const checkpointId = String(payload.checkpointId);
        await this.workspace.restoreCheckpoint(taskId, checkpointId);
        return { checkpointId };
      }

      case "turn.start":
        return await this.startTurn(effect);

      case "turn.interrupt": {
        const adapter = this.adapter(taskId);
        await adapter.interrupt(
          {
            threadId: String(payload.threadId),
            runId: String(payload.runId),
            providerTurnId: String(payload.providerTurnId),
          },
          effect.effectId,
        );
        return { ok: true };
      }

      case "turn.steer": {
        const adapter = this.adapter(taskId);
        await adapter.steer({
          threadId: String(payload.threadId),
          runId: String(payload.runId),
          providerTurnId: String(payload.providerTurnId),
          text: String(payload.text),
        });
        return { ok: true };
      }

      case "runtime_request.respond": {
        const adapter = this.adapter(taskId);
        await adapter.respondRuntimeRequest(
          {
            requestId: String(payload.requestId),
            decision: payload.decision as "approved" | "rejected" | "cancelled",
            ...(payload.answer !== undefined ? { answer: payload.answer } : {}),
          },
          effect.effectId,
        );
        this.store.resolveApproval(
          String(payload.requestId),
          payload.decision as "approved" | "rejected" | "cancelled",
          payload.answer ?? null,
        );
        return { ok: true };
      }

      case "provider.thread.ensure": {
        const adapter = this.adapter(taskId);
        return await adapter.ensureThread(payload as never);
      }

      case "provider.thread.rollback": {
        const adapter = this.adapter(taskId);
        await adapter.rollbackThread(
          {
            threadId: String(payload.threadId),
            providerThreadId: String(payload.providerThreadId),
            ...(payload.checkpointId ? { checkpointId: String(payload.checkpointId) } : {}),
          },
          effect.effectId,
        );
        return { ok: true };
      }

      case "provider.thread.fork": {
        const adapter = this.adapter(taskId);
        await adapter.forkThread({
          threadId: String(payload.threadId),
          providerThreadId: String(payload.providerThreadId),
        });
        return { ok: true };
      }

      default:
        throw new Error(`unknown effect kind ${effect.kind}`);
    }
  }

  private adapter(taskId: string): RemoteProviderAdapter {
    const task = this.store.requireTask(taskId);
    return new RemoteProviderAdapter({
      driver: task.provider,
      taskId,
      store: this.store,
      registry: this.registry,
    });
  }

  /**
   * `turn.start` is the effect the report warns about: a retry must not start
   * the same turn twice. The effect id is carried as the command's idempotency
   * key, and the worker deduplicates on it.
   */
  private async startTurn(effect: EffectRecord): Promise<unknown> {
    const task: TaskRecord = this.store.requireTask(effect.taskId);
    const payload = effect.payload as Record<string, unknown>;
    const adapter = this.adapter(effect.taskId);
    // The agent runs in *this task's* directory: its worktree inside a shared
    // project sandbox, or the checkout of its dedicated sandbox.
    const cwd = this.workspace.rootFor(effect.taskId) ?? null;
    // The mode the turn runs under: what the client asked for, already capped
    // against the task's pinned profile when the message was accepted. This
    // used to be the hardcoded pair below, which told the sandbox a mode T3
    // does not have and dropped the client's own choice entirely.
    const requestedPolicy = payload.runtimePolicy as
      | { runtimeMode?: string; interactionMode?: string }
      | undefined;
    const runtimePolicy = {
      runtimeMode: requestedPolicy?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: requestedPolicy?.interactionMode ?? "default",
      cwd,
      reasoningEffort: "medium",
    };

    const ensured = await adapter.ensureThread({
      threadId: task.threadId,
      model: task.model,
      runtimePolicy,
    });

    // Mark the task running before the turn starts: a provider may emit its
    // terminal event before the start command even returns.
    this.states.transition(effect.taskId, "running", {
      runId: payload.runId,
      providerThreadId: ensured.providerThreadId,
    });

    await adapter.startTurn(
      {
        threadId: task.threadId,
        runId: String(payload.runId),
        runOrdinal: Number(payload.runOrdinal ?? 1),
        providerTurnOrdinal: Number(payload.providerTurnOrdinal ?? 1),
        attemptId: String(payload.attemptId ?? effect.effectId),
        message: {
          messageId: String(payload.messageId),
          text: String(payload.text),
          attachments: [],
          createdBy: "user",
          creationSource: "client",
        },
        model: task.model,
        runtimePolicy,
      },
      effect.effectId,
    );

    return { providerThreadId: ensured.providerThreadId, runId: payload.runId };
  }
}
