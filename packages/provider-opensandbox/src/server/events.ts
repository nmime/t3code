/**
 * Control-plane events → T3 provider events.
 *
 * The control plane speaks a normalized protocol of its own (`thread.updated`,
 * `turn.updated`, `message.updated`, `runtime_request.updated`, `turn.terminal`)
 * where a reply arrives as a series of text chunks. T3 wants its own shapes, and
 * wants one *coherent* assistant message per run, so this module keeps the small
 * amount of state that translation needs: the current provider thread and the
 * accumulated text of the run in flight.
 */
import {
  type OrchestrationV2ProviderCapabilities,
  ChatAttachment,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import type { OpenSandboxEvent, OpenSandboxSnapshot } from "./controlPlane.ts";

/** Everything the mapper needs that only the adapter knows. */
export interface MapperContext {
  driver: ProviderDriverKind;
  instanceId: string;
  providerSessionId: ProviderSessionId;
  /** The app thread this session serves. */
  appThreadId: string;
  /**
   * The identity T3 already holds for this provider thread, when it has one.
   *
   * T3 starts a run with a provisional provider-thread row and hands it to the
   * adapter through `existingProviderThread`; an adapter that mints its own row
   * instead leaves two rows per app thread. Read through a function because the
   * row is only known once the run's thread has been ensured.
   */
  providerThreadId: () => string | null;
  /** Working directory reported to T3 (the sandbox worktree). */
  cwd: string;
  /**
   * The turn a run belongs to, for events that arrive without turn context.
   *
   * The control plane names its runs its own way; T3 owns the run it is
   * executing, and its ingestor routes an event to the run whose id it
   * recognizes. `runId` and `attemptId` are that translation: without them a
   * mapped message or turn is addressed to a run T3 does not know and is
   * dropped.
   */
  runContext: (runId: string | undefined) => {
    providerTurnId?: string;
    nodeId?: NodeId;
    runId?: string;
    attemptId?: string;
  };
  /** Reported with session events; the adapter owns the real values. */
  capabilities: OrchestrationV2ProviderCapabilities;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * Turn control-plane events into T3 events.
 *
 * Returns an empty array for events T3 has no use for (worker logs, effect
 * bookkeeping): the adapter is allowed to be quiet, not to invent.
 */
export class ProviderEventMapper {
  private thread: OrchestrationV2ProviderThread | null = null;
  private readonly turns = new Map<string, OrchestrationV2ProviderTurn>();
  /** Accumulated assistant text per run, because chunks arrive separately. */
  private readonly streaming = new Map<
    string,
    { messageId: string; text: string; startedAt: number }
  >();

  private readonly context: MapperContext;

  constructor(context: MapperContext) {
    this.context = context;
  }

  /** Seed from a snapshot so a resumed session starts with the real thread. */
  seed(snapshot: OpenSandboxSnapshot): void {
    this.thread = threadFromSnapshot(this.context, snapshot);
    this.turns.clear();
    for (const turn of turnsFromSnapshot(this.context, snapshot)) {
      this.turns.set(turn.id, turn);
    }
  }

  currentThread(): OrchestrationV2ProviderThread | null {
    return this.thread;
  }

  map(event: OpenSandboxEvent): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> {
    const payload = event.payload;
    switch (event.type) {
      case "session.updated": {
        const session = record(payload.providerSession);
        return [
          {
            type: "provider_session.updated",
            driver: this.context.driver,
            providerSession: {
              id: this.context.providerSessionId,
              driver: this.context.driver,
              providerInstanceId: this.context.instanceId as never,
              status: (text(session.status) || "ready") as never,
              cwd: text(session.cwd) || this.context.cwd,
              model: session.model ? String(session.model) : null,
              capabilities: this.context.capabilities,
              createdAt: DateTime.makeUnsafe(event.ts),
              updatedAt: DateTime.makeUnsafe(event.ts),
              lastError: null,
            },
          },
        ];
      }

      case "thread.updated": {
        const reported = record(payload.providerThread);
        // The thread keeps the identity T3 already has for it; what the worker
        // reports is its *native* id, which belongs in `nativeThreadRef`.
        // Re-keying here would record the same thread twice.
        const thread: OrchestrationV2ProviderThread = {
          ...(this.thread ?? emptyThread(this.context)),
          nativeThreadRef: {
            driver: this.context.driver,
            nativeId: text(reported.providerThreadId) || null,
            strength: "strong",
          },
          status: "idle",
        };
        this.thread = thread;
        return [
          { type: "provider_thread.updated", driver: this.context.driver, providerThread: thread },
        ];
      }

      case "turn.updated": {
        const reported = record(payload.providerTurn);
        const runId = text(reported.runId);
        const context = this.context.runContext(runId);
        const providerTurnId = ProviderTurnId.make(
          text(reported.providerTurnId) || `turn_${runId || event.seq}`,
        );
        const turn: OrchestrationV2ProviderTurn = {
          id: providerTurnId,
          providerThreadId: this.thread?.id ?? ProviderThreadId.make(this.context.appThreadId),
          nodeId: context.nodeId ?? NodeId.make(`node_${runId || event.seq}`),
          // T3 recognizes its own root turn by the attempt it started.
          runAttemptId: (context.attemptId ?? null) as never,
          nativeTurnRef: {
            driver: this.context.driver,
            nativeId: text(reported.providerTurnId) || null,
            strength: "strong",
          },
          ordinal: Math.max(1, Number(reported.runOrdinal ?? this.turns.size + 1)),
          status: (text(reported.status) || "running") as OrchestrationV2ProviderTurn["status"],
          startedAt: DateTime.makeUnsafe(event.ts),
          completedAt: null,
        };
        this.turns.set(turn.id, turn);
        return [{ type: "provider_turn.updated", driver: this.context.driver, providerTurn: turn }];
      }

      case "message.updated": {
        const reported = record(payload.message);
        const runId = text(payload.runId);
        const role = text(reported.role) === "user" ? "user" : "assistant";
        const chunk = text(reported.text);
        // The user's own message is T3's: the app thread created it, and the
        // control plane is echoing it back. Mapping it would duplicate it.
        if (role === "user") return [];
        // Assistant text streams: accumulate, and update the same message.
        const key = runId || text(reported.messageId) || String(event.seq);
        const existing = this.streaming.get(key);
        const accumulated = {
          messageId: existing?.messageId ?? (text(reported.messageId) || `assistant_${key}`),
          text: `${existing?.text ?? ""}${chunk}`,
          startedAt: existing?.startedAt ?? event.ts,
        };
        this.streaming.set(key, accumulated);
        return [
          {
            type: "message.updated",
            driver: this.context.driver,
            message: this.message({
              messageId: accumulated.messageId,
              role: "assistant",
              text: accumulated.text,
              // The run T3 is executing, not the control plane's own run id.
              runId: this.context.runContext(runId).runId ?? null,
              at: event.ts,
              streaming: reported.streaming === true,
            }),
          },
        ];
      }

      case "runtime_request.updated": {
        const reported = record(payload.runtimeRequest);
        const request: OrchestrationV2RuntimeRequest = {
          id: String(reported.requestId) as never,
          nodeId: this.turns.values().next().value?.nodeId ?? NodeId.make(`node_${event.seq}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: text(reported.kind) === "approval" ? "permission" : "user_input",
          status: text(reported.status) === "pending" ? "pending" : "resolved",
          responseCapability: { type: "message" },
          createdAt: DateTime.makeUnsafe(event.ts),
          resolvedAt: text(reported.status) === "pending" ? null : DateTime.makeUnsafe(event.ts),
        };
        return [
          { type: "runtime_request.updated", driver: this.context.driver, runtimeRequest: request },
        ];
      }

      case "turn.terminal": {
        const runId = text(payload.runId);
        const context = this.context.runContext(runId);
        const providerTurnId = ProviderTurnId.make(
          text(payload.providerTurnId) || context.providerTurnId || `turn_${runId || event.seq}`,
        );
        const raw = text(payload.status);
        const status =
          raw === "failed" ? "failed" : raw === "interrupted" ? "interrupted" : "completed";
        const existing = this.turns.get(providerTurnId);
        if (existing) {
          this.turns.set(providerTurnId, {
            ...existing,
            status: status === "failed" ? "failed" : status,
            completedAt: DateTime.makeUnsafe(event.ts),
          });
        }
        const providerThreadId = this.thread?.id ?? ProviderThreadId.make(this.context.appThreadId);
        const runOrdinal = Math.max(1, existing?.ordinal ?? 1);
        if (status === "failed") {
          return [
            {
              type: "turn.terminal",
              driver: this.context.driver,
              providerThreadId,
              providerTurnId,
              runOrdinal,
              failureItemOrdinal: 1,
              status: "failed",
              failure: {
                kind: "provider_error",
                message: text(record(payload.failure).message) || "the agent failed",
              } as never,
              threadDisposition: "reusable",
            },
          ];
        }
        return [
          {
            type: "turn.terminal",
            driver: this.context.driver,
            providerThreadId,
            providerTurnId,
            runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          },
        ];
      }

      default:
        return [];
    }
  }

  private message(input: {
    messageId: string;
    role: "user" | "assistant";
    text: string;
    runId: string | null;
    at: number;
    streaming: boolean;
  }): OrchestrationV2ConversationMessage {
    return {
      id: input.messageId as never,
      threadId: this.context.appThreadId as never,
      runId: (input.runId ?? null) as never,
      nodeId: null,
      role: input.role,
      text: input.text,
      attachments: [] as ReadonlyArray<typeof ChatAttachment.Type>,
      streaming: input.streaming,
      createdBy: input.role === "user" ? "user" : "agent",
      creationSource: "provider",
      createdAt: DateTime.makeUnsafe(input.at),
      updatedAt: DateTime.makeUnsafe(input.at),
    };
  }
}

const emptyThread = (context: MapperContext): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(context.providerThreadId() ?? context.appThreadId),
  driver: context.driver,
  providerInstanceId: context.instanceId as never,
  providerSessionId: context.providerSessionId,
  appThreadId: context.appThreadId as never,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: DateTime.makeUnsafe(Date.now()),
  updatedAt: DateTime.makeUnsafe(Date.now()),
});

export const threadFromSnapshot = (
  context: MapperContext,
  snapshot: OpenSandboxSnapshot,
): OrchestrationV2ProviderThread => {
  const turns = turnsFromSnapshot(context, snapshot);
  return {
    ...emptyThread(context),
    // One identity per provider thread: the id derived from the app thread, so
    // a snapshot read and a `thread.updated` event agree and T3 records the
    // thread once. The worker's own id lives in `nativeThreadRef`.
    providerSessionId: (snapshot.providerSessionId ?? context.providerSessionId) as never,
    nativeThreadRef: snapshot.providerThreadId
      ? { driver: context.driver, nativeId: snapshot.providerThreadId, strength: "strong" }
      : null,
    nativeConversationHeadRef: null,
    status: snapshot.state === "running" ? "active" : "idle",
    firstRunOrdinal: turns.length ? 1 : null,
    lastRunOrdinal: turns.length ? turns.length : null,
  };
};

export const turnsFromSnapshot = (
  context: MapperContext,
  snapshot: OpenSandboxSnapshot,
): ReadonlyArray<OrchestrationV2ProviderTurn> =>
  snapshot.turns.map((turn, index) => ({
    id: ProviderTurnId.make(turn.providerTurnId),
    providerThreadId: ProviderThreadId.make(snapshot.providerThreadId ?? context.appThreadId),
    nodeId: NodeId.make(`node_${turn.runId ?? turn.providerTurnId}`),
    runAttemptId: null,
    nativeTurnRef: {
      driver: context.driver,
      nativeId: turn.providerTurnId,
      strength: "strong",
    },
    ordinal: Math.max(1, turn.runOrdinal ?? index + 1),
    status: (turn.status ?? "completed") as OrchestrationV2ProviderTurn["status"],
    startedAt: null,
    completedAt: turn.completedAt ? DateTime.makeUnsafe(turn.completedAt) : null,
  }));
