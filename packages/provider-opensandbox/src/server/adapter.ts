/**
 * A T3 provider that runs in a OpenSandbox sandbox.
 *
 * The adapter is a proxy, and deliberately a thin one: the control plane owns
 * the sandbox, the repository, the environment profile, the agent process and
 * the conversation's durable log; T3 owns the app thread, the run bookkeeping
 * and the UI. Everything here is translation — a T3 thread becomes a task, a T3
 * turn becomes a message, control-plane events become T3 provider events — plus
 * the one thing the control plane cannot decide for T3: whether this sandbox is
 * still the right place for the work.
 */
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import { capabilitiesFromWorker, workerCapabilitiesForAgent } from "./capabilities.ts";
import { normalizeControlPlaneUrl, type OpenSandboxProviderConfig } from "./config.ts";
import {
  OpenSandboxControlPlane,
  OpenSandboxControlPlaneError,
  type OpenSandboxEvent,
  type OpenSandboxSnapshot,
  type OpenSandboxTask,
} from "./controlPlane.ts";
import {
  ProviderEventMapper,
  threadFromSnapshot,
  turnsFromSnapshot,
  type MapperContext,
} from "./events.ts";

export const OPENSANDBOX_DRIVER_KIND = ProviderDriverKind.make("opensandbox");

/** A cause shaped for T3's typed provider errors. */
const defectOf = (cause: unknown): Error =>
  cause instanceof OpenSandboxControlPlaneError
    ? new Error(`${cause.code}: ${cause.message}`)
    : cause instanceof Error
      ? cause
      : new Error(String(cause));

export interface OpenSandboxAdapterOptions {
  instanceId: ProviderInstanceId;
  config: OpenSandboxProviderConfig;
  client?: OpenSandboxControlPlane;
}

export const makeAdapter = (
  options: OpenSandboxAdapterOptions,
): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const config = options.config;
  const client =
    options.client ??
    new OpenSandboxControlPlane({
      url: normalizeControlPlaneUrl(config.controlPlaneUrl),
      token: config.apiToken,
    });
  const agent = config.agent ?? "codex";
  let capabilities: OrchestrationV2ProviderCapabilities = capabilitiesFromWorker(
    workerCapabilitiesForAgent(agent),
    agent,
  );

  /** Ask the sandbox what it can do, and believe it over the config. */
  const refreshCapabilities = async (taskId: string): Promise<void> => {
    const snapshot = await client.snapshot(taskId);
    const inventory = snapshot.capabilities.find((entry) => entry.driver === agent);
    if (inventory) {
      capabilities = capabilitiesFromWorker(inventory.capabilities, agent, snapshot.runtimeModeCap);
    }
  };

  const ensureTask = async (
    threadId: string,
    modelSelection: ModelSelection,
    title?: string,
  ): Promise<OpenSandboxTask> => {
    const existing = await client.findTaskByThread(threadId);
    if (existing) {
      if (existing.state === "suspended") {
        // A suspended task refuses messages, and the resume is an *effect* on
        // the control plane: it answers before the worker is attached again.
        // Dispatching the turn without waiting is what made the first message
        // after an idle-stop fail — `task_state_invalid: Task … in state
        // suspended: task does not accept messages` — while the control plane
        // went on to resume the task a moment later, leaving the run failed in
        // the UI and the sandbox resumed underneath it.
        await client.resume(existing.taskId);
        await waitForReady(client, existing.taskId, config.readyTimeoutMs ?? 300_000);
        return await client.task(existing.taskId);
      }
      if (existing.state === "pending" || existing.state === "provisioning") {
        // Provisioned but not up yet: wait rather than hand the turn to a state
        // machine that would refuse it.
        await waitForReady(client, existing.taskId, config.readyTimeoutMs ?? 300_000);
        return await client.task(existing.taskId);
      }
      return existing;
    }
    const task = await client.createTask({
      profileId: config.profileId,
      ...(config.repositoryUrl ? { repositoryUrl: config.repositoryUrl } : {}),
      ...(config.branch ? { branch: config.branch } : {}),
      ...(config.projectId ? { projectId: config.projectId } : {}),
      provider: agent,
      model: modelSelection.model,
      ...(config.sandboxScope ? { scope: config.sandboxScope } : {}),
      threadId,
    });
    await waitForReady(client, task.taskId, config.readyTimeoutMs ?? 300_000);
    await refreshCapabilities(task.taskId);
    void title;
    return await client.task(task.taskId);
  };

  return {
    instanceId: options.instanceId,
    driver: OPENSANDBOX_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),

    openSession: Effect.fn("OpenSandboxAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | import("effect/Cause").Done
      >();
      const appThreadId = input.threadId as unknown as string;
      const cwd = input.runtimePolicy.cwd ?? "/workspace/project";
      const tasks = new Map<string, OpenSandboxTask>();
      /** Control-plane turn id per control-plane run id, learned from events. */
      const turnsByRun = new Map<string, string>();
      /**
       * Which app run T3 is executing for a control-plane run.
       *
       * T3 routes a provider event to the run whose id it recognizes, so every
       * mapped message and turn has to carry T3's run id and attempt id — the
       * ids `startTurn` was handed — rather than the control plane's own.
       */
      const appRunsByRun = new Map<string, { runId: string; attemptId: string; nodeId: string }>();
      /**
       * The provider-thread row T3 holds for this session.
       *
       * T3 opens a run with a provisional row and passes it to `ensureThread`
       * as `existingProviderThread`; adopting that identity is what keeps one
       * row per app thread instead of two that alternate as the active thread.
       */
      const providerThreadIdentities = new Map<string, string>();
      const adoptProviderThread = (
        threadId: string,
        existing: { id: unknown } | undefined,
      ): void => {
        if (existing?.id !== undefined) {
          providerThreadIdentities.set(threadId, String(existing.id));
        }
      };

      const runContext = (runId: string | undefined) => {
        const providerTurnId = runId ? turnsByRun.get(runId) : undefined;
        const app = runId ? appRunsByRun.get(runId) : undefined;
        return {
          ...(providerTurnId ? { providerTurnId } : {}),
          ...(app
            ? { runId: app.runId, attemptId: app.attemptId, nodeId: NodeId.make(app.nodeId) }
            : {}),
        };
      };

      /**
       * One mapper per app thread.
       *
       * T3 derives one session per provider instance (`…:shared`), so this
       * adapter serves every thread of the instance at once. A single mapper
       * held one provider-thread identity and one set of turns, and mapped every
       * task's events through it — so the second thread's events were recorded
       * on the first thread's row.
       */
      const mappers = new Map<string, ProviderEventMapper>();
      const mapperFor = (threadId: string): ProviderEventMapper => {
        const existing = mappers.get(threadId);
        if (existing !== undefined) return existing;
        const created = new ProviderEventMapper({
          driver: OPENSANDBOX_DRIVER_KIND,
          instanceId: options.instanceId as unknown as string,
          providerSessionId: input.providerSessionId,
          appThreadId: threadId,
          cwd,
          capabilities,
          runContext,
          providerThreadId: () => providerThreadIdentities.get(threadId) ?? null,
        });
        mappers.set(threadId, created);
        return created;
      };

      /** The app thread a provider-thread reference belongs to. */
      const appThreadOf = (providerThread: { appThreadId?: unknown } | undefined): string =>
        providerThread?.appThreadId === undefined
          ? appThreadId
          : String(providerThread.appThreadId);

      const taskIdFor = (threadId: string): string | null => tasks.get(threadId)?.taskId ?? null;

      // The control plane's stream is the session's event stream: it replays
      // from the sequence the client last saw, so a reconnect loses nothing.
      //
      // One stream per task, each in its own fiber. A task's stream does not end
      // on its own, so reading the tasks one after another — which is what this
      // did — parks on the first task forever and starves every task after it.
      // The session is shared across app threads, and T3 only learns a thread's
      // state from its own task's events, so a second thread never got any: it
      // sat at "Thinking" while its turn completed on the control plane.
      const streamController = new AbortController();
      const streaming = new Set<string>();
      const cursors = new Map<string, number>();
      /**
       * Which app thread asked for a runtime request.
       *
       * `respondToRuntimeRequest` is handed a request id and nothing else, and
       * the session serves every thread of the instance, so the thread that owns
       * the request has to be learned from the stream that carried it.
       */
      const requestThreads = new Map<string, string>();
      const watch = (task: OpenSandboxTask, threadId: string): void => {
        if (streaming.has(task.taskId)) return;
        streaming.add(task.taskId);
        const mapper = mapperFor(threadId);
        void (async () => {
          while (!streamController.signal.aborted) {
            let cursor = cursors.get(task.taskId) ?? 0;
            // Only the transport is guarded: the cursor makes a reconnect
            // lossless, but a mapping defect has to fail the session loudly.
            const stream = client
              .events(task.taskId, cursor, streamController.signal)
              [Symbol.asyncIterator]();
            for (;;) {
              let step: IteratorResult<OpenSandboxEvent>;
              try {
                step = await stream.next();
              } catch {
                break;
              }
              if (step.done || streamController.signal.aborted) break;
              const event = step.value;
              cursor = Math.max(cursor, event.seq);
              cursors.set(task.taskId, cursor);
              if (event.type === "turn.updated") {
                const payload = event.payload.providerTurn as
                  | { runId?: string; providerTurnId?: string }
                  | undefined;
                if (payload?.runId && payload.providerTurnId) {
                  turnsByRun.set(payload.runId, payload.providerTurnId);
                }
              }
              if (event.type === "runtime_request.updated") {
                const payload = event.payload.runtimeRequest as { requestId?: string } | undefined;
                if (payload?.requestId !== undefined) {
                  requestThreads.set(String(payload.requestId), threadId);
                }
              }
              for (const mapped of mapper.map(event)) {
                await Effect.runPromise(Queue.offer(events, mapped));
              }
            }
            if (streamController.signal.aborted) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        })();
      };
      yield* Effect.forkScoped(
        Effect.tryPromise({
          try: async () => {
            while (!streamController.signal.aborted) {
              for (const [threadId, task] of tasks) watch(task, threadId);
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          },
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver: OPENSANDBOX_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause: defectOf(cause),
            }),
        }),
      );

      const snapshotOf = async (taskId: string, threadId: string): Promise<OpenSandboxSnapshot> => {
        const snapshot = await client.snapshot(taskId);
        mapperFor(threadId).seed(snapshot);
        return snapshot;
      };

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: OPENSANDBOX_DRIVER_KIND,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: OPENSANDBOX_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd,
          model: input.modelSelection.model,
          capabilities,
          // T3 stores this payload as a `provider-session.attached` event, and
          // its schema wants a `DateTime.Utc`, not a JavaScript `Date`.
          createdAt: DateTime.makeUnsafe(Date.now()),
          updatedAt: DateTime.makeUnsafe(Date.now()),
          lastError: null,
        },
        events: Stream.fromQueue(events),

        ensureThread: (ensureInput) =>
          Effect.tryPromise({
            try: async () => {
              const threadId = String(ensureInput.threadId);
              adoptProviderThread(threadId, ensureInput.existingProviderThread);
              const task = await ensureTask(
                threadId,
                ensureInput.modelSelection,
                ensureInput.title,
              );
              tasks.set(threadId, task);
              const snapshot = await snapshotOf(task.taskId, threadId);
              return threadFromSnapshot(
                mapperContext(
                  mapperFor(threadId),
                  cwd,
                  capabilities,
                  options,
                  { providerSessionId: input.providerSessionId, threadId: ensureInput.threadId },
                  runContext,
                  () => providerThreadIdentities.get(threadId) ?? null,
                ),
                snapshot,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: OPENSANDBOX_DRIVER_KIND,
                threadId: ensureInput.threadId,
                cause: defectOf(cause),
              }),
          }),

        resumeThread: (resumeInput) =>
          Effect.tryPromise({
            try: async () => {
              const threadId = appThreadOf(resumeInput.providerThread);
              adoptProviderThread(threadId, resumeInput.providerThread);
              if (!taskIdFor(threadId)) {
                const task = await ensureTask(threadId, input.modelSelection);
                tasks.set(threadId, task);
              }
              const snapshot = await snapshotOf(taskIdFor(threadId) ?? "", threadId);
              return threadFromSnapshot(
                mapperContext(
                  mapperFor(threadId),
                  cwd,
                  capabilities,
                  options,
                  { providerSessionId: input.providerSessionId, threadId: threadId as never },
                  runContext,
                  () => providerThreadIdentities.get(threadId) ?? null,
                ),
                snapshot,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: OPENSANDBOX_DRIVER_KIND,
                threadId: appThreadOf(resumeInput.providerThread) as never,
                cause: defectOf(cause),
              }),
          }),

        startTurn: (turnInput) =>
          Effect.tryPromise({
            try: async () => {
              const threadId = turnInput.threadId as unknown as string;
              // Re-check the task on every turn, even when this session already
              // holds one: the control plane owns the task's state and the idle
              // policy may have suspended it since the last turn. A cached task
              // skips that check, and the message then hits the state machine —
              // `task_state_invalid: Task … in state suspended: task does not
              // accept messages` — while the control plane resumes the task a
              // moment later, leaving the run failed in the UI. `ensureTask`
              // resumes a suspended task and waits until it is ready again.
              const task = await ensureTask(threadId, turnInput.modelSelection);
              tasks.set(threadId, task);
              const started = await client.sendMessage(
                task.taskId,
                turnInput.message.text,
                turnInput.modelSelection.model,
                {
                  // T3 decides the mode per turn; the control plane caps it
                  // against the task's pinned profile and refuses a stronger
                  // one, so this is a request, not an instruction.
                  runtimeMode: turnInput.runtimePolicy.runtimeMode,
                  interactionMode: turnInput.runtimePolicy.interactionMode,
                },
              );
              // Remember which app run this sandbox run is, so the events the
              // control plane emits for it can be addressed back to T3's run.
              appRunsByRun.set(started.runId, {
                runId: String(turnInput.runId),
                attemptId: String(turnInput.attemptId),
                nodeId: String(turnInput.rootNodeId),
              });
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: OPENSANDBOX_DRIVER_KIND,
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                runId: turnInput.runId,
                cause: defectOf(cause),
              }),
          }),

        steerTurn: (steerInput) =>
          Effect.tryPromise({
            try: async () => {
              const task = tasks.get(appThreadOf(steerInput.providerThread));
              if (!task) throw new Error("no sandbox is bound to this session");
              await client.steer(task.taskId, steerInput.message.text);
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterSteerRunError({
                driver: OPENSANDBOX_DRIVER_KIND,
                providerThreadId: steerInput.providerThread.id,
                providerTurnId: steerInput.providerTurnId,
                cause: defectOf(cause),
              }),
          }),

        interruptTurn: (interruptInput) =>
          Effect.tryPromise({
            try: async () => {
              const task = tasks.get(appThreadOf(interruptInput.providerThread));
              if (!task) throw new Error("no sandbox is bound to this session");
              await client.interrupt(task.taskId);
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterInterruptError({
                driver: OPENSANDBOX_DRIVER_KIND,
                providerThreadId: interruptInput.providerThread.id,
                providerTurnId: interruptInput.providerTurnId,
                cause: defectOf(cause),
              }),
          }),

        respondToRuntimeRequest: (requestInput) =>
          Effect.tryPromise({
            try: async () => {
              const task = tasks.get(
                requestThreads.get(String(requestInput.requestId)) ?? appThreadId,
              );
              if (!task) throw new Error("no sandbox is bound to this session");
              await client.respondToApproval(
                task.taskId,
                requestInput.requestId as unknown as string,
                requestInput.decision === "decline"
                  ? "rejected"
                  : requestInput.decision === "cancel"
                    ? "cancelled"
                    : "approved",
                requestInput.answers ?? requestInput.response,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: OPENSANDBOX_DRIVER_KIND,
                requestId: requestInput.requestId,
                cause: defectOf(cause),
              }),
          }),

        readThreadSnapshot: (snapshotInput) =>
          Effect.tryPromise({
            try: async (): Promise<ProviderAdapter.ProviderAdapterV2ThreadSnapshot> => {
              const threadId = appThreadOf(snapshotInput.providerThread);
              const taskId = taskIdFor(threadId);
              if (!taskId) throw new Error("no sandbox is bound to this session");
              const snapshot = await snapshotOf(taskId, threadId);
              const context = mapperContext(
                mapperFor(threadId),
                cwd,
                capabilities,
                options,
                { providerSessionId: input.providerSessionId, threadId: threadId as never },
                runContext,
                () => providerThreadIdentities.get(threadId) ?? null,
              );
              return {
                providerThread: threadFromSnapshot(context, snapshot),
                providerTurns: turnsFromSnapshot(context, snapshot),
                messages: snapshot.messages.map((message) => {
                  // The snapshot's own timestamp when the log carried one; a
                  // read of a message the log has no time for is stamped now.
                  const at = DateTime.makeUnsafe(message.createdAt ?? Date.now());
                  return {
                    id: MessageId.make(message.messageId),
                    threadId: input.threadId,
                    runId:
                      message.runId === undefined
                        ? null
                        : (() => {
                            const app = appRunsByRun.get(message.runId);
                            return app ? RunId.make(app.runId) : null;
                          })(),
                    nodeId: null,
                    role: message.role === "user" ? "user" : "assistant",
                    text: message.text,
                    attachments: [],
                    streaming: message.streaming === true,
                    createdBy: message.role === "user" ? "user" : "agent",
                    creationSource: "provider",
                    createdAt: at,
                    updatedAt: at,
                  };
                }),
                runtimeRequests: snapshot.runtimeRequests.map((request) => {
                  const at = DateTime.makeUnsafe(request.createdAt ?? Date.now());
                  return {
                    id: RuntimeRequestId.make(request.requestId),
                    nodeId: NodeId.make(`node_${request.requestId}`),
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: request.kind === "approval" ? "permission" : "user_input",
                    status: request.status === "pending" ? "pending" : "resolved",
                    responseCapability: { type: "message" },
                    createdAt: at,
                    resolvedAt:
                      request.status === "pending"
                        ? null
                        : DateTime.makeUnsafe(
                            request.resolvedAt ?? request.createdAt ?? Date.now(),
                          ),
                  };
                }),
              };
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver: OPENSANDBOX_DRIVER_KIND,
                providerThreadId: snapshotInput.providerThread.id,
                cause: defectOf(cause),
              }),
          }),

        rollbackThread: (rollbackInput) =>
          Effect.tryPromise({
            try: async (): Promise<ProviderAdapter.ProviderAdapterV2ThreadSnapshot> => {
              const threadId = appThreadOf(rollbackInput.providerThread);
              const task = tasks.get(threadId);
              if (!task) throw new Error("no sandbox is bound to this session");
              const checkpointId = rollbackInput.target.checkpointId;
              await client.rollback(task.taskId, checkpointId as unknown as string);
              await waitForSettled(client, task.taskId, config.pollIntervalMs ?? 250);
              const snapshot = await snapshotOf(task.taskId, threadId);
              const context = mapperContext(
                mapperFor(threadId),
                cwd,
                capabilities,
                options,
                { providerSessionId: input.providerSessionId, threadId: threadId as never },
                runContext,
                () => providerThreadIdentities.get(threadId) ?? null,
              );
              return {
                providerThread: threadFromSnapshot(context, snapshot),
                providerTurns: turnsFromSnapshot(context, snapshot),
                messages: [],
                runtimeRequests: [],
              };
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: OPENSANDBOX_DRIVER_KIND,
                providerThreadId: rollbackInput.providerThread.id,
                cause: defectOf(cause),
              }),
          }),

        forkThread: (forkInput) =>
          Effect.tryPromise({
            try: async () => {
              // The worker decides: an agent whose runtime has no native fork
              // reports the capability as false, and asking anyway would be a
              // lie to the client that reads capabilities.
              if (!capabilities.threads.canForkThread) {
                throw new Error(`the sandbox worker does not support forking ${agent} threads`);
              }
              const source = tasks.get(appThreadOf(forkInput.sourceProviderThread));
              if (!source) throw new Error("no sandbox is bound to this session");
              const targetThreadId = forkInput.targetThreadId as unknown as string;
              const forked = await client.forkTask(source.taskId, targetThreadId);
              tasks.set(targetThreadId, forked);
              await waitForReady(client, forked.taskId, config.readyTimeoutMs ?? 300_000);
              await refreshCapabilities(forked.taskId);
              const snapshot = await snapshotOf(forked.taskId, targetThreadId);
              return threadFromSnapshot(
                mapperContext(
                  mapperFor(targetThreadId),
                  cwd,
                  capabilities,
                  options,
                  {
                    providerSessionId: input.providerSessionId,
                    threadId: forkInput.targetThreadId,
                  },
                  runContext,
                  // A fork is a new provider thread: its identity comes from
                  // the target thread, not from this session's row.
                  () => null,
                ),
                snapshot,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: OPENSANDBOX_DRIVER_KIND,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause: defectOf(cause),
              }),
          }),
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          streamController.abort();
          Queue.endUnsafe(events);
        }),
      );

      return runtime;
    }),
  };
};

const mapperContext = (
  _mapper: ProviderEventMapper,
  cwd: string,
  capabilities: OrchestrationV2ProviderCapabilities,
  options: OpenSandboxAdapterOptions,
  input: { providerSessionId: ProviderSessionId; threadId: ThreadId },
  runContext: MapperContext["runContext"] = () => ({}),
  providerThreadId: MapperContext["providerThreadId"] = () => null,
) => ({
  driver: OPENSANDBOX_DRIVER_KIND,
  instanceId: options.instanceId as unknown as string,
  providerSessionId: input.providerSessionId,
  appThreadId: input.threadId as unknown as string,
  cwd,
  capabilities,
  runContext,
  providerThreadId,
});

const waitForReady = async (
  client: OpenSandboxControlPlane,
  taskId: string,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await client.task(taskId);
    if (task.state === "ready") return;
    if (task.state === "failed" || task.state === "destroyed") {
      throw new Error(`sandbox for task ${taskId} ended in state ${task.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`sandbox for task ${taskId} was not ready within ${timeoutMs} ms`);
};

const waitForSettled = async (
  client: OpenSandboxControlPlane,
  taskId: string,
  intervalMs: number,
): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const task = await client.task(taskId);
    if (task.state !== "running" && task.state !== "provisioning") return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
