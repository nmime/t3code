/**
 * A T3 provider that runs in a Daytona sandbox.
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
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import { capabilitiesFromWorker, workerCapabilitiesForAgent } from "./capabilities.ts";
import { normalizeControlPlaneUrl, type DaytonaProviderConfig } from "./config.ts";
import {
  DaytonaControlPlane,
  DaytonaControlPlaneError,
  type DaytonaSnapshot,
  type DaytonaTask,
} from "./controlPlane.ts";
import { ProviderEventMapper, threadFromSnapshot, turnsFromSnapshot } from "./events.ts";

export const DAYTONA_DRIVER_KIND = ProviderDriverKind.make("daytona");

/** A cause shaped for T3's typed provider errors. */
const defectOf = (cause: unknown): Error =>
  cause instanceof DaytonaControlPlaneError
    ? new Error(`${cause.code}: ${cause.message}`)
    : cause instanceof Error
      ? cause
      : new Error(String(cause));

export interface DaytonaAdapterOptions {
  instanceId: ProviderInstanceId;
  config: DaytonaProviderConfig;
  client?: DaytonaControlPlane;
}

export const makeAdapter = (
  options: DaytonaAdapterOptions,
): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const config = options.config;
  const client =
    options.client ??
    new DaytonaControlPlane({
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
    if (inventory) capabilities = capabilitiesFromWorker(inventory.capabilities, agent);
  };

  const ensureTask = async (
    threadId: string,
    modelSelection: ModelSelection,
    title?: string,
  ): Promise<DaytonaTask> => {
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
    driver: DAYTONA_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),

    openSession: Effect.fn("DaytonaAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | import("effect/Cause").Done
      >();
      const appThreadId = input.threadId as unknown as string;
      const cwd = input.runtimePolicy.cwd ?? "/workspace/project";
      const tasks = new Map<string, DaytonaTask>();
      const turnsByRun = new Map<string, string>();

      const mapper = new ProviderEventMapper({
        driver: DAYTONA_DRIVER_KIND,
        instanceId: options.instanceId as unknown as string,
        providerSessionId: input.providerSessionId,
        appThreadId,
        cwd,
        capabilities,
        runContext: (runId) => {
          const providerTurnId = runId ? turnsByRun.get(runId) : undefined;
          return providerTurnId ? { providerTurnId } : {};
        },
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
              driver: DAYTONA_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause: defectOf(cause),
            }),
        }),
      );

      const snapshotOf = async (taskId: string): Promise<DaytonaSnapshot> => {
        const snapshot = await client.snapshot(taskId);
        mapper.seed(snapshot);
        return snapshot;
      };

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: DAYTONA_DRIVER_KIND,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: DAYTONA_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd,
          model: input.modelSelection.model,
          capabilities,
          createdAt: new Date() as never,
          updatedAt: new Date() as never,
          lastError: null,
        },
        events: Stream.fromQueue(events),

        ensureThread: (ensureInput) =>
          Effect.tryPromise({
            try: async () => {
              const task = await ensureTask(
                ensureInput.threadId as unknown as string,
                ensureInput.modelSelection,
                ensureInput.title,
              );
              tasks.set(ensureInput.threadId as unknown as string, task);
              const snapshot = await snapshotOf(task.taskId);
              return threadFromSnapshot(
                mapperContext(mapper, cwd, capabilities, options, input),
                snapshot,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: DAYTONA_DRIVER_KIND,
                threadId: ensureInput.threadId,
                cause: defectOf(cause),
              }),
          }),

        resumeThread: (resumeInput) =>
          Effect.tryPromise({
            try: async () => {
              const taskId = taskIdFor(appThreadId);
              if (!taskId) {
                const task = await ensureTask(appThreadId, input.modelSelection);
                tasks.set(appThreadId, task);
              }
              const snapshot = await snapshotOf(taskIdFor(appThreadId) ?? "");
              return threadFromSnapshot(
                mapperContext(mapper, cwd, capabilities, options, input),
                snapshot,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: DAYTONA_DRIVER_KIND,
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
              await client.sendMessage(
                task.taskId,
                turnInput.message.text,
                turnInput.modelSelection.model,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: DAYTONA_DRIVER_KIND,
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
                driver: DAYTONA_DRIVER_KIND,
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
                driver: DAYTONA_DRIVER_KIND,
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
                driver: DAYTONA_DRIVER_KIND,
                requestId: requestInput.requestId,
                cause: defectOf(cause),
              }),
          }),

        readThreadSnapshot: (snapshotInput) =>
          Effect.tryPromise({
            try: async () => {
              const taskId =
                taskIdFor(snapshotInput.providerThread.appThreadId as unknown as string) ??
                tasks.get(appThreadId)?.taskId;
              if (!taskId) throw new Error("no sandbox is bound to this session");
              const snapshot = await snapshotOf(taskId);
              const context = mapperContext(mapper, cwd, capabilities, options, input);
              return {
                providerThread: threadFromSnapshot(context, snapshot),
                providerTurns: turnsFromSnapshot(context, snapshot),
                messages: snapshot.messages.map((message) => ({
                  id: message.messageId as never,
                  threadId: appThreadId as never,
                  runId: (message.runId ?? null) as never,
                  nodeId: null,
                  role: message.role === "user" ? "user" : "assistant",
                  text: message.text,
                  attachments: [],
                  streaming: message.streaming === true,
                  createdBy: message.role === "user" ? "user" : "agent",
                  creationSource: "provider",
                  createdAt: new Date() as never,
                  updatedAt: new Date() as never,
                })),
                runtimeRequests: snapshot.runtimeRequests.map((request) => ({
                  id: request.requestId as never,
                  nodeId: `node_${request.requestId}` as never,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: request.kind === "approval" ? "permission" : "user_input",
                  status: request.status === "pending" ? "pending" : "resolved",
                  responseCapability: { type: "message" },
                  createdAt: new Date() as never,
                  resolvedAt: request.status === "pending" ? null : (new Date() as never),
                })),
              } as never;
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver: DAYTONA_DRIVER_KIND,
                providerThreadId: snapshotInput.providerThread.id,
                cause: defectOf(cause),
              }),
          }),

        rollbackThread: (rollbackInput) =>
          Effect.tryPromise({
            try: async () => {
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
              } as never;
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: DAYTONA_DRIVER_KIND,
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
                mapperContext(mapper, cwd, capabilities, options, {
                  providerSessionId: input.providerSessionId,
                  threadId: forkInput.targetThreadId,
                }),
                snapshot,
              );
            },
            catch: (cause) =>
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: DAYTONA_DRIVER_KIND,
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
  options: DaytonaAdapterOptions,
  input: { providerSessionId: ProviderSessionId; threadId: ThreadId },
) => ({
  driver: DAYTONA_DRIVER_KIND,
  instanceId: options.instanceId as unknown as string,
  providerSessionId: input.providerSessionId,
  appThreadId: input.threadId as unknown as string,
  cwd,
  capabilities,
  runContext: () => ({}),
});

const waitForReady = async (
  client: DaytonaControlPlane,
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
  client: DaytonaControlPlane,
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
