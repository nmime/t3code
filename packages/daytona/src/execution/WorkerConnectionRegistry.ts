/**
 * Worker connection registry (report §6 "Worker connectivity", §7 protocol).
 *
 * The sandbox worker dials *out* to the VPS over an authenticated WebSocket;
 * no worker port is exposed on the internet. Authentication uses a
 * short-lived, sandbox-scoped, single-use token issued while provisioning.
 *
 * With project-scoped sandboxes there is **one worker per sandbox**, serving
 * every task bound to it. The registry therefore keys connections by sandbox:
 *
 *  - a task resolves to its sandbox through its binding, so `sendCommand`
 *    routes to the right worker without the task owning a connection,
 *  - the fencing epoch belongs to the sandbox (one lease, many tasks): a new
 *    attachment fences the previous worker for all of its tasks at once,
 *  - events are attributed to the task the worker says they belong to, falling
 *    back to the sandbox's first task when a frame carries no task id.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ackEnvelope,
  acceptedEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  negotiateProtocol,
  errorEnvelope,
  commandEnvelope,
  HEARTBEAT_INTERVAL_MS_DEFAULT,
  MAX_BUFFERED_EVENTS_DEFAULT,
  COMMAND_TIMEOUT_MS_DEFAULT,
  type Envelope,
  type ProviderInventoryEntry,
  type CommandType,
  type CommandPayloadMap,
  type WorkerHelloPayload,
} from "../contracts/workerProtocol.js";
import {
  LeaseFencedError,
  ProtocolViolationError,
  WorkerUnavailableError,
  ExecutionError,
} from "../contracts/errors.js";
import { sha256Hex } from "../contracts/ids.js";
import type { EventStore, StoredEvent } from "./EventStore.js";
import type { ProjectSandboxStore } from "./ProjectSandboxStore.js";

interface Connection {
  sandboxId: string;
  /** Epoch shared by every task bound to this sandbox. */
  leaseEpoch: number;
  socket: WebSocket;
  providers: ProviderInventoryEntry[];
  workspaceRoot: string;
  lastSeenAt: number;
  workerVersion: string;
  protocolVersion: number;
  /** Task the token was minted for; the fallback for unattributed frames. */
  primaryTaskId: string;
}

export interface WorkerCommandContext {
  effectId: string;
  threadId?: string;
  runId?: string;
  timeoutMs?: number;
  /**
   * Whether the result is appended to the task's event log (default true).
   * A turn's commands belong in the log; a one-shot generation that is
   * explicitly *not* a turn does not, or the log would show a turn that never
   * happened.
   */
  recordResult?: boolean;
}

export interface WorkerConnectionRegistryOptions {
  /** Store used to resolve a task to the sandbox it is bound to. */
  projects?: ProjectSandboxStore;
  /**
   * Mints a rotated, single-use credential delivered to the worker on hello
   * (report §6: short-lived, sandbox-scoped connection credentials).
   */
  issueToken?: (taskId: string, sandboxId: string) => string;
}

type EventListener = (events: StoredEvent[]) => void;
type ConnectionListener = (taskId: string, connected: boolean) => void;

export class WorkerConnectionRegistry {
  private readonly bySandbox = new Map<string, Connection>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
      recordResult: boolean;
    }
  >();
  private readonly eventListeners = new Set<EventListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly store: EventStore,
    private readonly options: WorkerConnectionRegistryOptions = {},
  ) {}

  attach(httpServer: HttpServer, path = "/worker"): void {
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (request, socket, head) => {
      if (!request.url || !request.url.startsWith(path)) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws));
    });
  }

  onEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** Sandbox a task's commands must be routed to. */
  sandboxForTask(taskId: string): string | null {
    return (
      this.options.projects?.sandboxForTask(taskId) ?? this.store.getTask(taskId)?.sandboxId ?? null
    );
  }

  isConnected(taskId: string): boolean {
    const sandboxId = this.sandboxForTask(taskId);
    return sandboxId ? this.bySandbox.has(sandboxId) : false;
  }

  isSandboxConnected(sandboxId: string): boolean {
    return this.bySandbox.has(sandboxId);
  }

  connection(taskId: string): {
    sandboxId: string;
    leaseEpoch: number;
    providers: ProviderInventoryEntry[];
    workspaceRoot: string;
    lastSeenAt: number;
  } | null {
    const sandboxId = this.sandboxForTask(taskId);
    const conn = sandboxId ? this.bySandbox.get(sandboxId) : undefined;
    if (!conn) return null;
    return {
      sandboxId: conn.sandboxId,
      leaseEpoch: conn.leaseEpoch,
      providers: conn.providers,
      workspaceRoot: conn.workspaceRoot,
      lastSeenAt: conn.lastSeenAt,
    };
  }

  providersFor(taskId: string): ProviderInventoryEntry[] {
    const sandboxId = this.sandboxForTask(taskId);
    return (sandboxId ? this.bySandbox.get(sandboxId)?.providers : undefined) ?? [];
  }

  /** Tasks currently served by one worker; used for lifecycle and fan-out. */
  tasksForSandbox(sandboxId: string): string[] {
    return (this.options.projects?.listBindings(sandboxId) ?? []).map((b) => b.taskId);
  }

  /** Wait (bounded) for a task's worker to appear, e.g. right after provisioning. */
  async waitForConnection(taskId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnected(taskId)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new WorkerUnavailableError(taskId, `worker did not connect within ${timeoutMs}ms`);
  }

  // -- commands ------------------------------------------------------------

  async sendCommand<T extends CommandType>(
    taskId: string,
    type: T,
    payload: CommandPayloadMap[T],
    ctx: WorkerCommandContext,
  ): Promise<unknown> {
    const sandboxId = this.sandboxForTask(taskId);
    const conn = sandboxId ? this.bySandbox.get(sandboxId) : undefined;
    if (!conn) throw new WorkerUnavailableError(taskId, "no live worker connection");
    const task = this.store.getTask(taskId);
    if (!task) throw new ExecutionError("task_not_found", `Task ${taskId} not found`);
    // The epoch is shared by every task of the sandbox, so a stale task record
    // can only disagree with a *newer* lease, which is exactly what fencing is.
    if (task.leaseEpoch > conn.leaseEpoch) {
      throw new LeaseFencedError(taskId, conn.leaseEpoch, task.leaseEpoch);
    }

    const envelope = commandEnvelope(type, payload, {
      taskId,
      sandboxId: conn.sandboxId,
      leaseEpoch: conn.leaseEpoch,
      effectId: ctx.effectId,
      threadId: ctx.threadId,
      runId: ctx.runId,
    });

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(
          new WorkerUnavailableError(
            taskId,
            `command ${type} timed out after ${ctx.timeoutMs ?? COMMAND_TIMEOUT_MS_DEFAULT}ms`,
          ),
        );
      }, ctx.timeoutMs ?? COMMAND_TIMEOUT_MS_DEFAULT);
      this.pending.set(envelope.id, {
        resolve,
        reject,
        timer,
        recordResult: ctx.recordResult !== false,
      });
      conn.socket.send(encodeEnvelope(envelope), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(envelope.id);
          reject(new WorkerUnavailableError(taskId, `send failed: ${err.message}`));
        }
      });
    });
  }

  /** Retire a wedged connection (used by recovery). */
  dropConnection(taskId: string, reason: string): void {
    const sandboxId = this.sandboxForTask(taskId);
    if (sandboxId) this.dropSandboxConnection(sandboxId, reason);
  }

  /** Retire the worker serving a sandbox, fencing every task bound to it. */
  dropSandboxConnection(sandboxId: string, reason: string): void {
    const conn = this.bySandbox.get(sandboxId);
    const tasks = this.tasksForSandbox(sandboxId);
    if (conn) {
      try {
        conn.socket.send(
          encodeEnvelope(
            errorEnvelope(
              { taskId: conn.primaryTaskId, sandboxId, leaseEpoch: conn.leaseEpoch },
              { code: "internal", message: reason },
            ),
          ),
        );
        conn.socket.close();
      } catch {
        // socket already gone
      }
      this.bySandbox.delete(sandboxId);
    }
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new WorkerUnavailableError(key, reason));
      this.pending.delete(key);
    }
    for (const taskId of tasks) this.emitConnectionChange(taskId, false);
  }

  close(): void {
    for (const sandboxId of [...this.bySandbox.keys()]) {
      this.dropSandboxConnection(sandboxId, "control plane shutting down");
    }
    this.wss?.close();
  }

  // -- inbound -------------------------------------------------------------

  private handleConnection(socket: WebSocket): void {
    let connection: Connection | null = null;

    socket.on("message", (raw: Buffer) => {
      let frame: Envelope;
      try {
        frame = decodeEnvelope(raw);
      } catch (err) {
        socket.send(
          encodeEnvelope(
            errorEnvelope(
              { taskId: "unknown", sandboxId: "unknown", leaseEpoch: 0 },
              { code: "protocol_violation", message: (err as Error).message },
            ),
          ),
        );
        return;
      }

      if (frame.kind === "hello") {
        try {
          connection = this.acceptHello(frame, socket);
        } catch (err) {
          socket.send(
            encodeEnvelope(
              errorEnvelope(
                {
                  taskId: frame.taskId,
                  sandboxId: frame.sandboxId,
                  leaseEpoch: 0,
                  inReplyTo: frame.id,
                },
                {
                  code: err instanceof ExecutionError ? err.code : "unauthorized",
                  message: (err as Error).message,
                },
              ),
            ),
          );
          socket.close();
        }
        return;
      }

      if (!connection) {
        socket.send(
          encodeEnvelope(
            errorEnvelope(
              {
                taskId: frame.taskId,
                sandboxId: frame.sandboxId,
                leaseEpoch: 0,
                inReplyTo: frame.id,
              },
              { code: "protocol_violation", message: "hello must be the first frame" },
            ),
          ),
        );
        socket.close();
        return;
      }

      this.handleFrame(frame, connection);
    });

    socket.on("close", () => {
      if (connection && this.bySandbox.get(connection.sandboxId) === connection) {
        this.bySandbox.delete(connection.sandboxId);
        for (const taskId of this.tasksForSandbox(connection.sandboxId)) {
          this.emitConnectionChange(taskId, false);
        }
      }
    });

    socket.on("error", () => socket.close());
  }

  private acceptHello(frame: Envelope, socket: WebSocket): Connection {
    const payload = frame.payload as unknown as WorkerHelloPayload;
    if (!payload?.token) throw new ProtocolViolationError("hello without token");
    const [tokenId, secret] = String(payload.token).split(".", 2);
    if (!tokenId || !secret) throw new ProtocolViolationError("malformed worker token");

    const consumed = this.store.consumeWorkerToken(tokenId, sha256Hex(secret));
    if (!consumed) {
      throw new ExecutionError("unauthorized", "worker token is invalid, expired or already used");
    }
    if (consumed.sandboxId !== frame.sandboxId) {
      throw new ExecutionError("unauthorized", "worker token does not match the sandbox it claims");
    }

    // A token is minted for one task bound to the sandbox; the worker may
    // announce any task of that sandbox, but never another sandbox's task.
    const bound = this.tasksForSandbox(frame.sandboxId);
    const announced = frame.taskId;
    if (bound.length > 0 && !bound.includes(announced) && !bound.includes(consumed.taskId)) {
      throw new ExecutionError(
        "unauthorized",
        "worker token does not belong to any task bound to this sandbox",
      );
    }
    if (bound.length === 0 && consumed.taskId !== announced) {
      throw new ExecutionError("unauthorized", "worker token does not match the task it claims");
    }

    const protocolVersion = negotiateProtocol(payload.protocolVersions ?? []);

    // Fence out any previous worker for this sandbox, for every bound task.
    const epoch = this.store.db.tx(() => {
      let current = this.options.projects?.getSandbox(frame.sandboxId)?.leaseEpoch ?? 0;
      for (const taskId of bound) {
        const task = this.store.getTask(taskId);
        if (task && task.leaseEpoch > current) current = task.leaseEpoch;
      }
      const next = current + 1;
      for (const taskId of bound) this.store.updateTask(taskId, { leaseEpoch: next });
      this.options.projects?.updateSandbox(frame.sandboxId, { leaseEpoch: next });
      return next;
    });

    const existing = this.bySandbox.get(frame.sandboxId);
    if (existing) {
      try {
        existing.socket.send(
          encodeEnvelope(
            errorEnvelope(
              {
                taskId: existing.primaryTaskId,
                sandboxId: frame.sandboxId,
                leaseEpoch: existing.leaseEpoch,
              },
              {
                code: "lease_fenced",
                message: `lease epoch ${existing.leaseEpoch} superseded by ${epoch}`,
              },
            ),
          ),
        );
        existing.socket.close();
      } catch {
        // ignore
      }
    }

    const primaryTaskId = bound.includes(announced) ? announced : (bound[0] ?? announced);
    const connection: Connection = {
      sandboxId: frame.sandboxId,
      leaseEpoch: epoch,
      socket,
      providers: payload.providers ?? [],
      workspaceRoot: payload.workspaceRoot,
      lastSeenAt: Date.now(),
      workerVersion: payload.workerVersion,
      protocolVersion,
      primaryTaskId,
    };
    this.bySandbox.set(frame.sandboxId, connection);

    const nextToken = this.options.issueToken?.(primaryTaskId, frame.sandboxId);
    socket.send(
      encodeEnvelope(
        acceptedEnvelope(
          {
            protocolVersion,
            leaseEpoch: epoch,
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS_DEFAULT,
            maxBufferedEvents: MAX_BUFFERED_EVENTS_DEFAULT,
            ackedUpToSeq: this.store.lastEventSeq(primaryTaskId),
            ...(nextToken ? { nextToken } : {}),
          },
          { taskId: primaryTaskId, sandboxId: frame.sandboxId, leaseEpoch: epoch },
        ),
      ),
    );

    this.store.appendEvents(primaryTaskId, "worker", [
      {
        type: "worker.attached",
        payload: {
          sandboxId: frame.sandboxId,
          leaseEpoch: epoch,
          protocolVersion,
          workerVersion: payload.workerVersion,
          providers: payload.providers,
          sharedTasks: bound,
        },
      },
    ]);
    for (const taskId of bound) this.emitConnectionChange(taskId, true);
    return connection;
  }

  /** Task a worker frame belongs to. */
  private taskForFrame(frame: Envelope, connection: Connection): string {
    const bound = this.tasksForSandbox(connection.sandboxId);
    if (bound.includes(frame.taskId)) return frame.taskId;
    if (bound.length > 0) return bound[0]!;
    return connection.primaryTaskId;
  }

  private handleFrame(frame: Envelope, connection: Connection): void {
    const currentEpoch = connection.leaseEpoch;

    if (frame.leaseEpoch !== currentEpoch) {
      connection.socket.send(
        encodeEnvelope(
          errorEnvelope(
            {
              taskId: connection.primaryTaskId,
              sandboxId: connection.sandboxId,
              leaseEpoch: currentEpoch,
              inReplyTo: frame.id,
              effectId: frame.effectId,
            },
            {
              code: "lease_fenced",
              message: `frame carries epoch ${frame.leaseEpoch}, current is ${currentEpoch}`,
            },
          ),
        ),
      );
      return;
    }

    connection.lastSeenAt = Date.now();
    if (frame.type === "worker.heartbeat") return;
    const taskId = this.taskForFrame(frame, connection);

    if (frame.kind === "result") {
      const payload = frame.payload as Record<string, unknown>;
      const commandId = String(payload.commandId ?? "");
      const entry = this.pending.get(commandId);
      // A command that asked not to be recorded is answered to its caller and
      // leaves no trace in the task's log.
      const record = entry ? entry.recordResult : true;
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(commandId);
        if (payload.ok === true) entry.resolve(payload.value);
        else {
          entry.reject(
            new ExecutionError(
              (payload.code as never) ?? "internal",
              String(payload.message ?? "worker command failed"),
              (payload.details as Record<string, unknown>) ?? {},
            ),
          );
        }
      }
      if (record) {
        const stored = this.store.appendEvents(taskId, "worker", [
          { type: "command.result", eventId: frame.id, payload },
        ]);
        if (stored.length > 0) {
          this.ack(connection, stored[stored.length - 1]!.seq);
          this.emitEvents(stored);
        }
      }
      return;
    }

    if (frame.kind === "event") {
      const stored = this.store.appendEvents(taskId, "worker", [
        { type: frame.type, eventId: frame.id, payload: frame.payload },
      ]);
      if (frame.type === "runtime_request.updated") {
        const request = (frame.payload as { runtimeRequest?: Record<string, unknown> })
          .runtimeRequest;
        if (request) {
          this.store.recordApproval({
            requestId: String(request.requestId),
            taskId,
            kind: String(request.kind ?? "approval"),
            summary: String(request.summary ?? "approval requested"),
            detail: request.detail,
            status: request.status === "resolved" ? "approved" : "pending",
          });
        }
      }
      if (stored.length > 0) {
        this.ack(connection, stored[stored.length - 1]!.seq);
        this.emitEvents(stored);
      }
      return;
    }

    if (frame.kind === "error") {
      const payload = frame.payload as Record<string, unknown>;
      const inReplyTo = payload.inReplyTo ? String(payload.inReplyTo) : null;
      const entry = inReplyTo ? this.pending.get(inReplyTo) : undefined;
      if (entry && inReplyTo) {
        clearTimeout(entry.timer);
        this.pending.delete(inReplyTo);
        const error = payload.error as Record<string, unknown> | undefined;
        entry.reject(
          new ExecutionError(
            (error?.code as never) ?? "internal",
            String(error?.message ?? "worker error"),
          ),
        );
      }
    }
  }

  private ack(connection: Connection, upToSeq: number): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(
      encodeEnvelope(
        ackEnvelope(upToSeq, {
          taskId: connection.primaryTaskId,
          sandboxId: connection.sandboxId,
          leaseEpoch: connection.leaseEpoch,
        }),
      ),
    );
  }

  private emitEvents(events: StoredEvent[]): void {
    for (const listener of this.eventListeners) listener(events);
  }

  private emitConnectionChange(taskId: string, connected: boolean): void {
    for (const listener of this.connectionListeners) listener(taskId, connected);
  }
}
