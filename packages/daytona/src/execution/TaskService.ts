/**
 * Task service: the client-facing command surface.
 *
 * Clients (Mac GUI, phone GUI, CLI) call into this service only. Every call
 * produces a command receipt, domain events and durable effects in a single
 * transaction; nothing here talks to a sandbox directly.
 */

import type { TaskRecord, GitStatus, WorkspaceEntry } from "../contracts/execution.js";
import type { ProjectExecutionPolicy, SandboxScope } from "../contracts/sandboxScope.js";
import {
  TaskNotFoundError,
  ExecutionError,
  CapabilityUnsupportedError,
} from "../contracts/errors.js";
import { newEffectId, newRunId, newCommandId } from "../contracts/ids.js";
import type { EventStore, StoredEvent } from "./EventStore.js";
import type { SandboxControlPlane, CreateTaskInput } from "./SandboxControlPlane.js";
import type { WorkerConnectionRegistry } from "./WorkerConnectionRegistry.js";
import type { RemoteWorkspaceService } from "./RemoteWorkspaceService.js";
import type { ProjectSandboxStore } from "./ProjectSandboxStore.js";
import { TaskStateMachine } from "./TaskStateMachine.js";

export interface SendMessageInput {
  text: string;
  attachments?: unknown[];
  createdBy?: string;
  /** Override the model for this turn (task override layer). */
  model?: string;
}

export class TaskService {
  private readonly states: TaskStateMachine;

  constructor(
    private readonly store: EventStore,
    private readonly controlPlane: SandboxControlPlane,
    private readonly registry: WorkerConnectionRegistry,
    private readonly workspace: RemoteWorkspaceService,
    private readonly projects: ProjectSandboxStore | null = null,
  ) {
    this.states = new TaskStateMachine(store);
    this.projectProviderEvents();
  }

  createTask(input: CreateTaskInput): TaskRecord {
    return this.controlPlane.createTask(input);
  }

  /**
   * Fork a task's provider thread into a new task in the same project. The new
   * task's thread identity is the caller's, so a client can find it again by
   * thread.
   */
  forkTask(input: { sourceTaskId: string; threadId: string }): TaskRecord {
    return this.controlPlane.forkTask(input);
  }

  getTask(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  listTasks(): TaskRecord[] {
    return this.store.listTasks();
  }

  /** Status view for clients: binding, sandbox, connection, approvals, effects. */
  status(taskId: string): Record<string, unknown> {
    const task = this.getTask(taskId);
    const binding = this.projects?.bindingFor(taskId) ?? null;
    const sandbox = task.sandboxId ? (this.projects?.getSandbox(task.sandboxId) ?? null) : null;
    return {
      task,
      sandboxScope: task.sandboxScope,
      projectId: task.projectId,
      worktreePath: task.worktreePath,
      worktreeBranch: task.worktreeBranch,
      binding,
      sandbox,
      /** How many tasks currently share this sandbox (1 for a dedicated one). */
      sharedWith: binding ? (this.projects?.taskCount(binding.sandboxId) ?? 1) - 1 : 0,
      worker: this.registry.connection(taskId),
      approvals: this.store.listApprovals(taskId),
      checkpoints: this.store.listCheckpoints(taskId),
      pendingEffects: this.store.pendingEffectsForTask(taskId).map((e) => ({
        effectId: e.effectId,
        kind: e.kind,
        status: e.status,
        attempts: e.attempts,
      })),
    };
  }

  // -- projects and project sandboxes --------------------------------------

  /** Project policy: the default scope lives here, per project. */
  upsertProject(input: {
    projectId?: string;
    name?: string;
    repositoryUrl: string;
    defaultScope?: SandboxScope | null;
    environmentProfileId?: string | null;
    maxConcurrentTasks?: number;
  }): ProjectExecutionPolicy {
    if (!this.projects) throw new ExecutionError("internal", "project store is not wired");
    return this.projects.upsertProject(input);
  }

  listProjects(): ProjectExecutionPolicy[] {
    return this.projects?.listProjects() ?? [];
  }

  projectSandboxes(projectId: string): Array<Record<string, unknown>> {
    if (!this.projects) return [];
    return this.projects.listProjectSandboxes(projectId).map((sandbox) => ({
      ...sandbox,
      boundTasks: this.projects!.listBindings(sandbox.sandboxId).map((b) => b.taskId),
    }));
  }

  listSandboxes(): Array<Record<string, unknown>> {
    if (!this.projects) return [];
    return this.projects.listSandboxes().map((sandbox) => ({
      ...sandbox,
      boundTasks: this.projects!.listBindings(sandbox.sandboxId).map((b) => b.taskId),
    }));
  }

  stopSandbox(sandboxId: string, reason = "manual"): void {
    this.store.enqueueEffect({
      effectId: `sandbox_stop_${sandboxId}_${Date.now()}`,
      taskId: sandboxId,
      kind: "sandbox.stop",
      payload: { sandboxId, reason },
      leaseEpoch: 0,
    });
  }

  destroySandbox(sandboxId: string, reason = "manual"): void {
    this.store.enqueueEffect({
      effectId: `sandbox_destroy_${sandboxId}_${Date.now()}`,
      taskId: sandboxId,
      kind: "sandbox.destroy",
      payload: { sandboxId, reason },
      leaseEpoch: 0,
    });
  }

  events(taskId: string, fromSeq = 0, limit = 500): StoredEvent[] {
    this.getTask(taskId);
    return this.store.eventsSince(taskId, fromSeq, limit);
  }

  /** Queue a message; the turn starts when the effect worker picks it up. */
  sendMessage(taskId: string, input: SendMessageInput): { runId: string; effectId: string } {
    const task = this.states.assertAcceptsMessages(taskId);
    const runId = newRunId();
    const effectId = newEffectId();
    const commandId = newCommandId();

    this.store.submitCommand({
      commandId,
      taskId,
      kind: "message.send",
      payload: { text: input.text, runId },
      events: [
        {
          type: "message.accepted",
          payload: {
            runId,
            text: input.text,
            createdBy: input.createdBy ?? "user",
            provider: task.provider,
          },
        },
      ],
      effects: [
        {
          effectId,
          kind: "turn.start",
          payload: {
            taskId,
            runId,
            runOrdinal:
              this.store.eventsSince(taskId, 0, 10_000).filter((e) => e.type === "turn.start")
                .length + 1,
            providerTurnOrdinal: 1,
            attemptId: effectId,
            messageId: `msg_${runId}`,
            text: input.text,
            model: input.model ?? task.model,
          },
          leaseEpoch: task.leaseEpoch,
        },
      ],
      ...(input.model ? { taskPatch: { model: input.model } } : {}),
    });

    return { runId, effectId };
  }

  /** Answer an approval / runtime request surfaced by the agent. */
  respondToApproval(
    taskId: string,
    requestId: string,
    decision: "approved" | "rejected" | "cancelled",
    answer?: unknown,
  ): void {
    const task = this.getTask(taskId);
    const approval = this.store.getApproval(requestId);
    if (!approval || approval.taskId !== taskId) {
      throw new ExecutionError("task_not_found", `Approval ${requestId} not found`, {
        taskId,
        requestId,
      });
    }
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "approval.respond",
      payload: { requestId, decision, answer },
      events: [{ type: "approval.resolved", payload: { requestId, decision, answer } }],
      effects: [
        {
          effectId: newEffectId(),
          kind: "runtime_request.respond",
          payload: { requestId, decision, answer },
          leaseEpoch: task.leaseEpoch,
        },
      ],
    });
  }

  stop(taskId: string): void {
    this.getTask(taskId);
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "task.stop",
      payload: {},
      events: [{ type: "task.stop_requested", payload: { taskId } }],
      effects: [
        {
          effectId: newEffectId(),
          kind: "task.stop",
          payload: { taskId },
          leaseEpoch: this.getTask(taskId).leaseEpoch,
        },
      ],
    });
  }

  resume(taskId: string): void {
    this.getTask(taskId);
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "task.resume",
      payload: {},
      events: [{ type: "task.resume_requested", payload: { taskId } }],
      effects: [
        {
          effectId: newEffectId(),
          kind: "task.resume",
          payload: { taskId },
          leaseEpoch: this.getTask(taskId).leaseEpoch,
        },
      ],
    });
  }

  destroy(taskId: string): void {
    this.getTask(taskId);
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "task.destroy",
      payload: {},
      events: [{ type: "task.destroy_requested", payload: { taskId } }],
      effects: [
        {
          effectId: newEffectId(),
          kind: "task.destroy",
          payload: { taskId },
          leaseEpoch: this.getTask(taskId).leaseEpoch,
        },
      ],
    });
  }

  captureCheckpoint(taskId: string, checkpointId: string, label?: string): void {
    this.getTask(taskId);
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "checkpoint.capture",
      payload: { checkpointId, label },
      events: [{ type: "checkpoint.capture_requested", payload: { checkpointId, label } }],
      effects: [
        {
          effectId: newEffectId(),
          kind: "checkpoint.capture",
          payload: { checkpointId, label },
          leaseEpoch: this.getTask(taskId).leaseEpoch,
        },
      ],
    });
  }

  // -- turn control and the provider snapshot ------------------------------

  /**
   * The run a control command addresses: the newest accepted run, with the
   * provider turn and provider thread the worker reported for it.
   *
   * Steer and interrupt are meaningless without a turn to address, so callers
   * get `null` rather than a guessed id.
   */
  activeRun(taskId: string): {
    threadId: string;
    runId: string;
    providerTurnId: string;
    providerThreadId: string | null;
  } | null {
    const task = this.getTask(taskId);
    let runId: string | null = null;
    let providerTurnId: string | null = null;
    let providerThreadId: string | null = null;

    for (const event of this.store.eventsSince(taskId, 0, 10_000)) {
      const payload = event.payload;
      if (event.type === "message.accepted" && typeof payload.runId === "string") {
        runId = payload.runId;
      }
      const thread = payload.providerThread as Record<string, unknown> | undefined;
      if (event.type === "thread.updated" && typeof thread?.providerThreadId === "string") {
        providerThreadId = thread.providerThreadId;
      }
      const turn = payload.providerTurn as Record<string, unknown> | undefined;
      if (event.type === "turn.updated" && turn) {
        if (typeof turn.runId === "string") runId = turn.runId;
        if (typeof turn.providerTurnId === "string") providerTurnId = turn.providerTurnId;
      }
    }

    if (!runId || !providerTurnId) return null;
    return { threadId: task.threadId, runId, providerTurnId, providerThreadId };
  }

  /** Queue a steer for the turn that is running now. */
  steer(taskId: string, text: string): { runId: string; effectId: string } {
    const task = this.getTask(taskId);
    const active = this.activeRun(taskId);
    if (!active || task.state !== "running") {
      throw new ExecutionError(
        "task_state_invalid",
        `Task ${taskId} has no running turn to steer`,
        {
          taskId,
          state: task.state,
        },
      );
    }
    const effectId = newEffectId();
    // A provider that cannot steer is refused now, not by a failed effect the
    // client only learns about from the event stream.
    const inventory = this.registry.providersFor(taskId).find((p) => p.driver === task.provider);
    if (inventory && inventory.capabilities && inventory.capabilities.steer === false) {
      throw new CapabilityUnsupportedError(task.provider, "steer");
    }
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "turn.steer",
      payload: { text, runId: active.runId },
      events: [
        {
          type: "message.accepted",
          payload: {
            runId: active.runId,
            text,
            createdBy: "user",
            provider: task.provider,
            steer: true,
          },
        },
      ],
      effects: [
        {
          effectId,
          kind: "turn.steer",
          payload: {
            taskId,
            threadId: active.threadId,
            runId: active.runId,
            providerTurnId: active.providerTurnId,
            text,
          },
          leaseEpoch: task.leaseEpoch,
        },
      ],
    });
    return { runId: active.runId, effectId };
  }

  /** Queue an interrupt for the turn that is running now. */
  interrupt(taskId: string): { runId: string; effectId: string } {
    const task = this.getTask(taskId);
    const active = this.activeRun(taskId);
    if (!active || task.state !== "running") {
      throw new ExecutionError(
        "task_state_invalid",
        `Task ${taskId} has no running turn to interrupt`,
        { taskId, state: task.state },
      );
    }
    const effectId = newEffectId();
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "turn.interrupt",
      payload: { runId: active.runId },
      events: [{ type: "turn.interrupt_requested", payload: { runId: active.runId } }],
      effects: [
        {
          effectId,
          kind: "turn.interrupt",
          payload: {
            taskId,
            threadId: active.threadId,
            runId: active.runId,
            providerTurnId: active.providerTurnId,
          },
          leaseEpoch: task.leaseEpoch,
        },
      ],
    });
    return { runId: active.runId, effectId };
  }

  /**
   * Rewind a task: the provider thread goes back to the checkpoint and the
   * workspace is restored from it, in one command so the two cannot drift.
   */
  rollback(taskId: string, checkpointId: string): { effectIds: string[] } {
    const task = this.getTask(taskId);
    const active = this.activeRun(taskId);
    const restoreId = newEffectId();
    const rollbackId = newEffectId();
    const effects: Array<Record<string, unknown>> = [
      {
        effectId: restoreId,
        kind: "checkpoint.restore",
        payload: { taskId, checkpointId, cleanUntracked: true },
        leaseEpoch: task.leaseEpoch,
      },
    ];
    if (active?.providerThreadId) {
      effects.push({
        effectId: rollbackId,
        kind: "provider.thread.rollback",
        payload: {
          taskId,
          threadId: active.threadId,
          providerThreadId: active.providerThreadId,
          checkpointId,
        },
        leaseEpoch: task.leaseEpoch,
      });
    }
    this.store.submitCommand({
      commandId: newCommandId(),
      taskId,
      kind: "task.rollback",
      payload: { checkpointId },
      events: [{ type: "task.rollback_requested", payload: { checkpointId } }],
      effects: effects as never,
    });
    return { effectIds: effects.map((e) => String(e.effectId)) };
  }

  /**
   * The provider-side view of a task: thread, turns, messages, pending runtime
   * requests and what the worker's provider can actually do.
   *
   * A remote client (the T3 fork) resumes from this instead of replaying the
   * whole event log.
   */
  snapshot(taskId: string): Record<string, unknown> {
    const task = this.getTask(taskId);
    const events = this.store.eventsSince(taskId, 0, 10_000);
    const turns: Array<Record<string, unknown>> = [];
    const messages: Array<Record<string, unknown>> = [];
    const runtimeRequests: Array<Record<string, unknown>> = [];
    let providerThreadId: string | null = null;
    let providerSessionId: string | null = null;
    let title: string | null = null;

    for (const event of events) {
      const payload = event.payload;
      if (event.type === "session.updated" && typeof payload.providerSessionId === "string") {
        providerSessionId = payload.providerSessionId;
      }
      const thread = payload.providerThread as Record<string, unknown> | undefined;
      if (event.type === "thread.updated" && thread) {
        if (typeof thread.providerThreadId === "string") providerThreadId = thread.providerThreadId;
        if (typeof thread.title === "string") title = thread.title;
      }
      const turn = payload.providerTurn as Record<string, unknown> | undefined;
      if (event.type === "turn.updated" && turn) {
        const id = String(turn.providerTurnId);
        const existing = turns.findIndex((t) => t.providerTurnId === id);
        const merged = { ...(existing >= 0 ? turns[existing] : {}), ...turn };
        if (existing >= 0) turns[existing] = merged;
        else turns.push(merged);
      }
      if (event.type === "turn.terminal") {
        const id = String(payload.providerTurnId ?? "");
        const existing = turns.findIndex((t) => t.providerTurnId === id);
        const terminal = {
          providerTurnId: id,
          runId: payload.runId,
          status: payload.status,
          completedAt: event.ts,
        };
        if (existing >= 0) turns[existing] = { ...turns[existing], ...terminal };
        else if (id) turns.push(terminal);
      }
      const message = payload.message as Record<string, unknown> | undefined;
      if (event.type === "message.accepted") {
        // The user's own message belongs in the provider view too: a client
        // resuming from a snapshot should see the turn it is resuming.
        messages.push({
          messageId: `user_${String(payload.runId ?? event.seq)}`,
          role: "user",
          text: String(payload.text ?? ""),
          runId: payload.runId,
          seq: event.seq,
          createdAt: event.ts,
        });
      }
      if (event.type === "message.updated" && message) {
        const id = String(message.messageId);
        const existing = messages.findIndex((m) => m.messageId === id);
        const merged = {
          ...(existing >= 0 ? messages[existing] : {}),
          ...message,
          // The run belongs to the event, not the chunk: it is what groups the
          // chunks of one reply back into one message.
          runId: payload.runId ?? message.runId,
          seq: event.seq,
        };
        if (existing >= 0) messages[existing] = merged;
        else messages.push(merged);
      }
      const request = payload.runtimeRequest as Record<string, unknown> | undefined;
      if (event.type === "runtime_request.updated" && request) {
        const id = String(request.requestId);
        const existing = runtimeRequests.findIndex((r) => r.requestId === id);
        const merged = { ...(existing >= 0 ? runtimeRequests[existing] : {}), ...request };
        if (existing >= 0) runtimeRequests[existing] = merged;
        else runtimeRequests.push(merged);
      }
    }

    // Assistant text arrives in chunks. A snapshot is a view to resume from, so
    // the chunks of one run are reported as one message with the full text.
    const assistantByRun = new Map<string, Record<string, unknown>>();
    const coherent: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      if (message.role !== "assistant") {
        coherent.push(message);
        continue;
      }
      const key = String(message.runId ?? message.messageId);
      const existing = assistantByRun.get(key);
      if (!existing) {
        const merged: Record<string, unknown> = { ...message, text: String(message.text ?? "") };
        assistantByRun.set(key, merged);
        coherent.push(merged);
        continue;
      }
      existing.text = `${String(existing.text ?? "")}${String(message.text ?? "")}`;
      existing.streaming = message.streaming;
      existing.seq = message.seq;
    }

    return {
      taskId,
      state: task.state,
      threadId: task.threadId,
      providerThreadId,
      providerSessionId,
      title,
      driver: task.provider,
      model: task.model,
      permissionMode: task.permissionMode,
      lastSeq: task.lastEventSequence,
      turns,
      messages: coherent,
      runtimeRequests,
      approvals: this.store.listApprovals(taskId),
      checkpoints: this.store.listCheckpoints(taskId),
      /** What the worker's provider advertises; absent until a worker attaches. */
      capabilities: this.registry.providersFor(taskId),
      worker: this.registry.connection(taskId),
    };
  }

  // -- remote workspace passthroughs --------------------------------------

  async gitStatus(taskId: string): Promise<GitStatus> {
    return await this.workspace.gitStatus(taskId);
  }

  async gitDiff(taskId: string, options?: { staged?: boolean; ref?: string }): Promise<string> {
    return await this.workspace.gitDiff(taskId, options);
  }

  async listDir(taskId: string, path: string): Promise<WorkspaceEntry[]> {
    return await this.workspace.listDir(taskId, path);
  }

  async execute(taskId: string, command: string): Promise<{ exitCode: number; output: string }> {
    return await this.workspace.execute(taskId, command);
  }

  // -- projections ---------------------------------------------------------

  /**
   * Provider events update task projections (state machine) as they are
   * persisted, keeping the GUI's task list consistent with the agent's actual
   * progress without polling the sandbox.
   */
  private projectProviderEvents(): void {
    this.registry.onEvents((events) => {
      for (const event of events) {
        const task = this.store.getTask(event.taskId);
        if (!task) continue;
        try {
          if (event.type === "runtime_request.updated") {
            const request = (event.payload as { runtimeRequest?: { status?: string } })
              .runtimeRequest;
            if (request?.status === "pending" && task.state === "running") {
              this.states.transition(task.taskId, "waiting", { reason: "runtime_request" });
            }
          }
          if (event.type === "turn.terminal") {
            const payload = event.payload as { status?: string };
            if (task.state === "running" || task.state === "waiting") {
              this.states.transition(task.taskId, "ready", {
                reason: "turn.terminal",
                status: payload.status,
              });
            }
          }
        } catch {
          // Projection updates must never break event delivery.
        }
      }
    });
  }
}
