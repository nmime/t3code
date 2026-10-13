/**
 * Worker protocol (report §7 "Remote protocol requirements").
 *
 * A versioned command/event protocol between the VPS control plane and the
 * execution worker inside a task sandbox:
 *
 *  - correlation ids: taskId, threadId, runId, effectId, sandboxId
 *  - monotonic worker event sequence numbers + acknowledgements
 *  - idempotent commands: every command carries an `effectId`; the worker
 *    keeps a processed-effect ledger and replays the original result for a
 *    duplicate instead of executing twice
 *  - worker leases with fencing epochs
 *  - heartbeats, bounded event buffers, explicit version and capability
 *    negotiation
 *
 * Transport is one WebSocket per task-sandbox, opened *outbound* from the
 * sandbox to the VPS.
 */

import { z } from "zod";
import { ProtocolViolationError, type ExecutionErrorCode } from "./errors.js";
import { newCommandId, newEventId, sha256Hex } from "./ids.js";
import { canonicalize } from "./canonical.js";

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/**
 * Provider capability flags: fork, rollback, steering, subagents, background
 * execution and native session recovery vary by provider, and we must not
 * claim otherwise.
 */
export interface ProviderCapabilities {
  fork: boolean;
  rollback: boolean;
  steer: boolean;
  subagents: boolean;
  background: boolean;
  nativeResume: boolean;
  approvals: boolean;
}

export interface ProviderInventoryEntry {
  driver: string;
  capabilities: ProviderCapabilities;
  version: string;
}

export interface WorkerHelloPayload {
  token: string;
  protocolVersions: number[];
  sandboxId: string;
  taskId: string;
  workerVersion: string;
  providers: ProviderInventoryEntry[];
  workspaceRoot: string;
  resumeFromSeq: number;
  processedEffectIds: string[];
}

export interface WorkerAcceptedPayload {
  protocolVersion: number;
  leaseEpoch: number;
  heartbeatIntervalMs: number;
  maxBufferedEvents: number;
  ackedUpToSeq: number;
  /**
   * Rotated credential for the next connection: worker tokens are single-use,
   * so each successful hello mints a replacement.
   */
  nextToken?: string;
}

export interface SessionOpenPayload {
  driver: string;
  providerSessionId: string;
  threadId: string;
  model: string;
  runtimePolicy: {
    runtimeMode: string;
    interactionMode: string;
    cwd: string | null;
    reasoningEffort?: string;
    approvalPolicy?: unknown;
    sandboxPolicy?: unknown;
  };
  resumeFromSession?: unknown;
}

export interface ThreadEnsurePayload {
  driver: string;
  threadId: string;
  title?: string;
  providerSessionId?: string;
  existingProviderThread?: unknown;
  model: string;
  runtimePolicy: SessionOpenPayload["runtimePolicy"];
}

export interface TurnStartPayload {
  driver: string;
  threadId: string;
  runId: string;
  runOrdinal: number;
  providerTurnOrdinal: number;
  attemptId: string;
  message: {
    messageId: string;
    text: string;
    attachments: unknown[];
    createdBy: string;
    creationSource: string;
    scheduledTaskId?: string | null;
    senderThreadId?: string | null;
  };
  model: string;
  runtimePolicy: SessionOpenPayload["runtimePolicy"];
}

export interface TurnInterruptPayload {
  driver: string;
  threadId: string;
  runId: string;
  providerTurnId: string;
}

export interface TurnSteerPayload {
  driver: string;
  threadId: string;
  runId: string;
  providerTurnId: string;
  text: string;
}

export interface RuntimeRequestRespondPayload {
  driver: string;
  requestId: string;
  decision: "approved" | "rejected" | "cancelled";
  answer?: unknown;
}

export interface ThreadRollbackPayload {
  driver: string;
  threadId: string;
  providerThreadId: string;
  checkpointId?: string;
}

export interface ThreadForkPayload {
  driver: string;
  threadId: string;
  providerThreadId: string;
}

/**
 * One prompt for the agent to answer, with no thread and no conversation: the
 * sandbox-side half of T3's text generation (commit messages, titles, branch
 * names). Nothing is written to a task's event log, so a generated commit
 * message never appears as a turn in the thread that asked for it.
 */
export interface TextGeneratePayload {
  /** The provider runtime in the sandbox that answers. */
  driver: string;
  /** Where the agent runs. The control plane resolves the task's worktree. */
  cwd?: string;
  prompt: string;
  model?: string;
}

export interface CheckpointCapturePayload {
  checkpointId: string;
  label?: string;
}

export interface CheckpointRestorePayload {
  checkpointId: string;
  cleanUntracked?: boolean;
}

export interface CheckpointDiffPayload {
  fromCheckpointId: string | null;
  toCheckpointId: string | null;
}

export interface WorkspaceExecPayload {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Worker-path root this command applies to. A shared project sandbox hosts
   * several tasks, each in its own git worktree, so the control plane names the
   * root explicitly instead of relying on the worker's default.
   */
  root?: string;
}

export interface WorkspaceReadPayload {
  path: string;
  encoding?: "utf8" | "base64";
  root?: string;
}

export interface WorkspaceWritePayload {
  path: string;
  dataBase64: string;
  mode?: number;
  root?: string;
}

export interface WorkspaceListPayload {
  path: string;
  root?: string;
}

export interface WorkspaceGitPayload {
  operation: "status" | "diff" | "log" | "branch" | "commit" | "show-ref";
  args?: string[];
  root?: string;
}

/**
 * Git worktree management inside a shared sandbox. A worktree is not a thread:
 * T3 models both, and the sandbox scope decides only *where* the checkout
 * lives.
 */
export interface WorkspaceWorktreePayload {
  operation: "create" | "remove" | "list";
  /** Base checkout the worktree belongs to; defaults to the worker's root. */
  projectRoot?: string;
  /** Worktree path (create/remove). */
  path?: string;
  branch?: string;
  baseRef?: string;
  force?: boolean;
}

export type CommandPayloadMap = {
  "session.open": SessionOpenPayload;
  "session.close": { driver: string; providerSessionId: string };
  "thread.ensure": ThreadEnsurePayload;
  "thread.resume": { driver: string; threadId: string; providerThreadId: string };
  "turn.start": TurnStartPayload;
  "turn.interrupt": TurnInterruptPayload;
  "turn.steer": TurnSteerPayload;
  "runtime_request.respond": RuntimeRequestRespondPayload;
  "thread.rollback": ThreadRollbackPayload;
  "thread.fork": ThreadForkPayload;
  "text.generate": TextGeneratePayload;
  "checkpoint.capture": CheckpointCapturePayload;
  "checkpoint.restore": CheckpointRestorePayload;
  "checkpoint.diff": CheckpointDiffPayload;
  "workspace.exec": WorkspaceExecPayload;
  "workspace.read": WorkspaceReadPayload;
  "workspace.write": WorkspaceWritePayload;
  "workspace.list": WorkspaceListPayload;
  "workspace.git": WorkspaceGitPayload;
  "workspace.worktree": WorkspaceWorktreePayload;
  "worker.drain": { reason: string };
  "worker.ping": { nonce: string };
};

export type CommandType = keyof CommandPayloadMap;

export const COMMAND_TYPES = [
  "session.open",
  "session.close",
  "thread.ensure",
  "thread.resume",
  "turn.start",
  "turn.interrupt",
  "turn.steer",
  "runtime_request.respond",
  "thread.rollback",
  "thread.fork",
  "text.generate",
  "checkpoint.capture",
  "checkpoint.restore",
  "checkpoint.diff",
  "workspace.exec",
  "workspace.read",
  "workspace.write",
  "workspace.list",
  "workspace.git",
  "workspace.worktree",
  "worker.drain",
  "worker.ping",
] as const satisfies readonly CommandType[];

/**
 * Normalized provider events, shaped after T3's `ProviderAdapterV2Event` union
 * so the remote adapter forwards them unchanged into T3's event ingestor.
 */
export type ProviderEventPayload =
  | { type: "session.updated"; driver: string; providerSession: unknown }
  | {
      type: "thread.updated";
      driver: string;
      providerThread: unknown;
      retainedNativeTurnIds?: string[];
    }
  | { type: "turn.updated"; driver: string; threadId?: string; providerTurn: unknown }
  | {
      type: "message.updated";
      driver: string;
      threadId: string;
      runId: string;
      message: unknown;
    }
  | { type: "node.updated"; driver: string; node: unknown }
  | {
      type: "runtime_request.updated";
      driver: string;
      threadId?: string;
      runtimeRequest: {
        requestId: string;
        kind: "approval" | "input" | "selection";
        summary: string;
        detail?: unknown;
        status: "pending" | "resolved";
      };
    }
  | { type: "plan.updated"; driver: string; plan: unknown }
  | {
      type: "turn.terminal";
      driver: string;
      providerThreadId: string;
      providerTurnId: string;
      runId: string;
      runOrdinal: number;
      status: "completed" | "interrupted" | "cancelled" | "failed";
      threadDisposition: "reusable" | "broken";
      failure?: unknown;
    }
  | {
      type: "worker.log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      detail?: unknown;
    };

export const EnvelopeBaseSchema = z.object({
  v: z.number().int().positive(),
  kind: z.enum(["hello", "accepted", "command", "result", "event", "ack", "error"]),
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  sandboxId: z.string().min(1),
  leaseEpoch: z.number().int().nonnegative(),
  type: z.string().min(1),
  effectId: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  runId: z.string().optional(),
  threadId: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
});

export type Envelope = z.infer<typeof EnvelopeBaseSchema> & {
  payload: Record<string, unknown>;
};

export interface CommandContext {
  taskId: string;
  sandboxId: string;
  leaseEpoch: number;
  effectId: string;
  threadId?: string;
  runId?: string;
}

export function commandEnvelope<T extends CommandType>(
  type: T,
  payload: CommandPayloadMap[T],
  ctx: CommandContext,
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "command",
    id: newCommandId(),
    ts: Date.now(),
    taskId: ctx.taskId,
    sandboxId: ctx.sandboxId,
    leaseEpoch: ctx.leaseEpoch,
    type,
    effectId: ctx.effectId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    payload: payload as unknown as Record<string, unknown>,
  };
}

export function helloEnvelope(
  payload: WorkerHelloPayload,
  ctx: { taskId: string; sandboxId: string; leaseEpoch: number },
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "hello",
    id: newEventId(),
    ts: Date.now(),
    taskId: ctx.taskId,
    sandboxId: ctx.sandboxId,
    leaseEpoch: ctx.leaseEpoch,
    type: "worker.hello",
    payload: payload as unknown as Record<string, unknown>,
  };
}

export function acceptedEnvelope(
  payload: WorkerAcceptedPayload,
  ctx: { taskId: string; sandboxId: string; leaseEpoch: number },
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "accepted",
    id: newCommandId(),
    ts: Date.now(),
    taskId: ctx.taskId,
    sandboxId: ctx.sandboxId,
    leaseEpoch: ctx.leaseEpoch,
    type: "worker.accepted",
    payload: payload as unknown as Record<string, unknown>,
  };
}

export function resultEnvelope(
  command: Envelope,
  result:
    | { ok: true; value: unknown }
    | {
        ok: false;
        code: ExecutionErrorCode | "unknown";
        message: string;
        details?: Record<string, unknown>;
      },
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "result",
    id: newEventId(),
    ts: Date.now(),
    taskId: command.taskId,
    sandboxId: command.sandboxId,
    leaseEpoch: command.leaseEpoch,
    type: "command.result",
    effectId: command.effectId,
    threadId: command.threadId,
    runId: command.runId,
    payload: { commandId: command.id, commandType: command.type, ...result },
  };
}

export function eventEnvelope(
  event: ProviderEventPayload,
  ctx: {
    taskId: string;
    sandboxId: string;
    leaseEpoch: number;
    seq: number;
    effectId?: string;
    threadId?: string;
    runId?: string;
  },
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "event",
    id: newEventId(),
    ts: Date.now(),
    taskId: ctx.taskId,
    sandboxId: ctx.sandboxId,
    leaseEpoch: ctx.leaseEpoch,
    type: event.type,
    seq: ctx.seq,
    effectId: ctx.effectId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    payload: event as unknown as Record<string, unknown>,
  };
}

export function ackEnvelope(
  upToSeq: number,
  ctx: { taskId: string; sandboxId: string; leaseEpoch: number },
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "ack",
    id: newCommandId(),
    ts: Date.now(),
    taskId: ctx.taskId,
    sandboxId: ctx.sandboxId,
    leaseEpoch: ctx.leaseEpoch,
    type: "events.ack",
    payload: { upToSeq },
  };
}

export function errorEnvelope(
  ctx: {
    taskId: string;
    sandboxId: string;
    leaseEpoch: number;
    inReplyTo?: string;
    effectId?: string;
  },
  error: { code: string; message: string; details?: Record<string, unknown> },
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "error",
    id: newEventId(),
    ts: Date.now(),
    taskId: ctx.taskId,
    sandboxId: ctx.sandboxId,
    leaseEpoch: ctx.leaseEpoch,
    type: "protocol.error",
    effectId: ctx.effectId,
    payload: { inReplyTo: ctx.inReplyTo, error },
  };
}

export function decodeEnvelope(raw: string | Buffer): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new ProtocolViolationError(`frame is not JSON: ${(err as Error).message}`);
  }
  const result = EnvelopeBaseSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProtocolViolationError("frame failed schema validation", {
      issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return result.data as Envelope;
}

export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

/** Version negotiation: highest version both sides support. */
export function negotiateProtocol(
  workerVersions: number[],
  controlVersions: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): number {
  const shared = workerVersions.filter((v) => controlVersions.includes(v));
  if (shared.length === 0) {
    throw new ProtocolViolationError("no shared protocol version", {
      workerVersions,
      controlVersions: [...controlVersions],
    });
  }
  return Math.max(...shared);
}

/** Stable hash of a command payload, used to detect effect replays with drift. */
export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalize(payload));
}

export const MAX_BUFFERED_EVENTS_DEFAULT = 1000;
export const HEARTBEAT_INTERVAL_MS_DEFAULT = 15_000;
export const COMMAND_TIMEOUT_MS_DEFAULT = 60_000;
