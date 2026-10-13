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
      if (existing.state === "suspended") await client.resume(existing.taskId);
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
      let providerThreadIdentity: string | null = null;
      const adoptProviderThread = (existing: { id: unknown } | undefined): void => {
        if (existing?.id !== undefined) providerThreadIdentity = String(existing.id);
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

      const mapper = new ProviderEventMapper({
        driver: OPENSANDBOX_DRIVER_KIND,
        instanceId: options.instanceId as unknown as string,
        providerSessionId: input.providerSessionId,
        appThreadId,
        cwd,
        capabilities,
        runContext,
        providerThreadId: () => providerThreadIdentity,
      });

      const taskIdFor = (threadId: string): string | null => tasks.get(threadId)?.taskId ?? null;

      // The control plane's stream is the session's event stream: it replays
      // from the sequence the client last saw, so a reconnect loses nothing.
      const streamController = new AbortController();
      yield* Effect.forkScoped(
        Effect.tryPromise({
          try: async () => {
            let cursor = 0;
            while (!streamController.signal.aborted) {
              const watched = [...tasks.values()];
              if (watched.length === 0) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
              }
              for (const task of watched) {
                for await (const event of client.events(
                  task.taskId,
                  cursor,
                  streamController.signal,
                )) {
                  cursor = Math.max(cursor, event.seq);
                  if (event.type === "turn.updated") {
                    const payload = event.payload.providerTurn as
                      | { runId?: string; providerTurnId?: string }
                      | undefined;
                    if (payload?.runId && payload.providerTurnId) {
                      turnsByRun.set(payload.runId, payload.providerTurnId);
                    }
                  }
                  for (const mapped of mapper.map(event)) {
                    await Effect.runPromise(Queue.offer(events, mapped));
                  }
                }
              }
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

      const snapshotOf = async (taskId: string): Promise<OpenSandboxSnapshot> => {
        const snapshot = await client.snapshot(taskId);
        mapper.seed(snapshot);
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
              adoptProviderThread(ensureInput.existingProviderThread);
              const task = await ensureTask(
                ensureInput.threadId as unknown as string,
                ensureInput.modelSelection,
                ensureInput.title,
              );
              tasks.set(ensureInput.threadId as unknown as string, task);
              const snapshot = await snapshotOf(task.taskId);
              return threadFromSnapshot(
                mapperContext(
                  mapper,
                  cwd,
                  capabilities,
                  options,
                  input,
                  runContext,
                  () => providerThreadIdentity,
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
              adoptProviderThread(resumeInput.providerThread);
              const taskId = taskIdFor(appThreadId);
              if (!taskId) {
                const task = await ensureTask(appThreadId, input.modelSelection);
                tasks.set(appThreadId, task);
              }
              const snapshot = await snapshotOf(taskIdFor(appThreadId) ?? "");
              return threadFromSnapshot(
                mapperContext(
                  mapper,
                  cwd,
                  capabilities,
                  options,
                  input,
                  runContext,
                  () => providerThreadIdentity,
                ),
                snapshot,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: OPENSANDBOX_DRIVER_KIND,
                threadId: appThreadId as never,
                cause: defectOf(cause),
              }),
          }),

        startTurn: (turnInput) =>
          Effect.tryPromise({
            try: async () => {
              const threadId = turnInput.threadId as unknown as string;
              let task = tasks.get(threadId);
              if (!task) {
                task = await ensureTask(threadId, turnInput.modelSelection);
                tasks.set(threadId, task);
              }
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
              const task = tasks.get(appThreadId);
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
              const task = tasks.get(appThreadId);
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
              const task = tasks.get(appThreadId);
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
              const taskId =
                taskIdFor(snapshotInput.providerThread.appThreadId as unknown as string) ??
                tasks.get(appThreadId)?.taskId;
              if (!taskId) throw new Error("no sandbox is bound to this session");
              const snapshot = await snapshotOf(taskId);
              const context = mapperContext(mapper, cwd, capabilities, options, input);
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
              const task = tasks.get(appThreadId);
              if (!task) throw new Error("no sandbox is bound to this session");
              const checkpointId = rollbackInput.target.checkpointId;
              await client.rollback(task.taskId, checkpointId as unknown as string);
              await waitForSettled(client, task.taskId, config.pollIntervalMs ?? 250);
              const snapshot = await snapshotOf(task.taskId);
              const context = mapperContext(mapper, cwd, capabilities, options, input);
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
              const source = tasks.get(appThreadId);
              if (!source) throw new Error("no sandbox is bound to this session");
              const targetThreadId = forkInput.targetThreadId as unknown as string;
              const forked = await client.forkTask(source.taskId, targetThreadId);
              tasks.set(targetThreadId, forked);
              await waitForReady(client, forked.taskId, config.readyTimeoutMs ?? 300_000);
              await refreshCapabilities(forked.taskId);
              const snapshot = await snapshotOf(forked.taskId);
              return threadFromSnapshot(
                mapperContext(
                  mapper,
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
