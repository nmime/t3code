/**
 * Worker transport.
 *
 * Runs inside the task sandbox and dials *out* to the control plane over an
 * authenticated WebSocket. Guarantees:
 *
 *  - single-use credentials with rotation: the token is spent on hello and
 *    replaced by `nextToken` for the next connection;
 *  - monotonic event sequence numbers, acked by the control plane, with a
 *    bounded buffer that survives worker restarts (JSONL spool) — an unacked
 *    event is never silently lost;
 *  - idempotent command execution via the processed-effect ledger;
 *  - lease fencing: a command or event for a superseded lease epoch is
 *    refused, so a stale worker cannot act after its replacement attached;
 *  - heartbeats and reconnect with bounded backoff.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import {
  decodeEnvelope,
  encodeEnvelope,
  helloEnvelope,
  resultEnvelope,
  eventEnvelope,
  errorEnvelope,
  SUPPORTED_PROTOCOL_VERSIONS,
  MAX_BUFFERED_EVENTS_DEFAULT,
  HEARTBEAT_INTERVAL_MS_DEFAULT,
  PROTOCOL_VERSION,
  type Envelope,
  type ProviderEventPayload,
  type WorkerHelloPayload,
} from "../contracts/workerProtocol.js";
import { errorPayload } from "../contracts/errors.js";
import { CommandDedupe } from "./CommandDedupe.js";
import { ProviderRuntimeHost } from "./ProviderRuntimeHost.js";
import { WorkspaceRuntimeHost } from "./WorkspaceRuntimeHost.js";

export interface WorkerTransportOptions {
  workerUrl: string;
  token: string;
  taskId: string;
  sandboxId: string;
  workspaceRoot: string;
  /**
   * Roots commands may name. A shared project sandbox holds a base checkout
   * plus one worktree per task, so the worker accepts any root inside its
   * sandbox workspace tree and refuses everything else.
   */
  allowedRoots?: string[];
  stateDir: string;
  configHome?: string;
  workerVersion?: string;
  /**
   * Give up after this long without a successful connection. A worker whose
   * control plane is gone (a CLI invocation that exited, a replaced VPS) must
   * not retry forever; the control plane reattaches a fresh worker instead.
   */
  maxDisconnectedMs?: number;
  /** Test hook: called when the lease is fenced. */
  onFenced?: () => void;
}

interface TransportState {
  seq: number;
  lastAckedSeq: number;
  token: string;
  leaseEpoch: number;
}

interface BufferedEvent {
  envelope: Envelope;
  at: number;
}

export class WorkerTransport {
  private readonly options: WorkerTransportOptions;
  private readonly stateFile: string;
  private readonly bufferFile: string;
  private readonly dedupe: CommandDedupe;
  private readonly startedAt = Date.now();
  private readonly providers: ProviderRuntimeHost;
  private readonly workspace: WorkspaceRuntimeHost;
  private state: TransportState;
  private buffer: BufferedEvent[] = [];
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private maxBufferedEvents = MAX_BUFFERED_EVENTS_DEFAULT;
  private droppedEvents = 0;
  private stopped = false;
  private connectAttempts = 0;
  private lastConnectedAt = 0;

  constructor(options: WorkerTransportOptions) {
    this.options = options;
    fs.mkdirSync(options.stateDir, { recursive: true });
    this.stateFile = path.join(options.stateDir, "transport.json");
    this.bufferFile = path.join(options.stateDir, "pending-events.jsonl");
    this.dedupe = new CommandDedupe(options.stateDir);

    this.state = { seq: 0, lastAckedSeq: 0, token: options.token, leaseEpoch: 0 };
    if (fs.existsSync(this.stateFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as TransportState;
        // A restarted worker keeps its rotated token and sequence numbering.
        this.state = { ...this.state, ...saved, token: options.token || saved.token };
      } catch {
        // keep defaults
      }
    }
    this.loadBuffer();

    // One worker serves every task of a sandbox, so a provider event has to be
    // attributed back to the task whose thread or run it belongs to — otherwise
    // the second task's turn looks like it never produced anything.
    const emit = (event: ProviderEventPayload) => this.emit(event, correlationOf(event));
    this.providers = new ProviderRuntimeHost({
      stateDir: options.stateDir,
      emit,
      configHome: options.configHome ?? options.workspaceRoot,
    });
    this.workspace = new WorkspaceRuntimeHost(options.workspaceRoot, options.allowedRoots);
  }

  /**
   * Which task a frame belongs to.
   *
   * One worker now serves every task of a sandbox, so a command's task id is
   * remembered against its thread and run; events the provider emits later are
   * attributed back to that task instead of to the worker's own default.
   */
  private readonly threadTasks = new Map<string, string>();
  private readonly runTasks = new Map<string, string>();

  private attribute(frame: Envelope): void {
    if (!frame.taskId) return;
    const payload = (frame.payload ?? {}) as { threadId?: string; runId?: string };
    const threadId = frame.threadId ?? payload.threadId;
    const runId = frame.runId ?? payload.runId;
    if (threadId) this.threadTasks.set(threadId, frame.taskId);
    if (runId) this.runTasks.set(runId, frame.taskId);
  }

  private taskFor(correlation: { threadId?: string; runId?: string }): string {
    if (correlation.runId) {
      const byRun = this.runTasks.get(correlation.runId);
      if (byRun) return byRun;
    }
    if (correlation.threadId) {
      const byThread = this.threadTasks.get(correlation.threadId);
      if (byThread) return byThread;
    }
    return this.options.taskId;
  }

  // -- lifecycle -----------------------------------------------------------

  async run(): Promise<void> {
    const maxDisconnectedMs = this.options.maxDisconnectedMs ?? 10 * 60_000;
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch {
        // connection failed; retry below
      }
      if (this.stopped) return;
      this.connectAttempts += 1;

      const since = this.lastConnectedAt || this.startedAt;
      if (Date.now() - since > maxDisconnectedMs) {
        console.error(
          `worker: no control plane connection for ${Math.round(
            (Date.now() - since) / 1000,
          )}s; exiting so the control plane can reattach a fresh worker`,
        );
        this.stop();
        return;
      }

      const backoff = Math.min(10_000, 200 * Math.pow(2, Math.min(this.connectAttempts, 6)));
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = null;
    this.persistState();
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.workerUrl);
      this.socket = socket;
      let settled = false;

      socket.on("open", () => {
        this.connectAttempts = 0;
        const hello: WorkerHelloPayload = {
          token: this.state.token,
          protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          sandboxId: this.options.sandboxId,
          taskId: this.options.taskId,
          workerVersion: this.options.workerVersion ?? "0.1.0",
          providers: this.providers.inventory(),
          workspaceRoot: this.options.workspaceRoot,
          resumeFromSeq: this.state.lastAckedSeq,
          processedEffectIds: [],
        };
        socket.send(
          encodeEnvelope(
            helloEnvelope(hello, {
              taskId: this.options.taskId,
              sandboxId: this.options.sandboxId,
              leaseEpoch: this.state.leaseEpoch,
            }),
          ),
        );
      });

      socket.on("message", (raw: Buffer) => {
        let frame: Envelope;
        try {
          frame = decodeEnvelope(raw);
        } catch {
          return;
        }
        // `connectOnce` stays pending until the socket closes: resolving on the
        // accepted frame would open a second connection while this one is live.
        this.handleFrame(frame, socket, () => undefined);
      });

      socket.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (!settled) {
          settled = true;
          reject(new Error("socket closed before handshake"));
        } else {
          resolve();
        }
      });
    });
  }

  // -- inbound frames ------------------------------------------------------

  private handleFrame(frame: Envelope, socket: WebSocket, onReady: () => void): void {
    if (frame.kind === "accepted") {
      const payload = frame.payload as unknown as {
        leaseEpoch: number;
        heartbeatIntervalMs: number;
        maxBufferedEvents: number;
        ackedUpToSeq: number;
        nextToken?: string;
      };
      this.state.leaseEpoch = payload.leaseEpoch;
      this.lastConnectedAt = Date.now();
      this.state.lastAckedSeq = Math.max(this.state.lastAckedSeq, payload.ackedUpToSeq);
      if (payload.nextToken) this.state.token = payload.nextToken;
      this.maxBufferedEvents = payload.maxBufferedEvents ?? MAX_BUFFERED_EVENTS_DEFAULT;
      this.persistState();

      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        this.sendRaw({
          v: PROTOCOL_VERSION,
          kind: "event",
          id: `hb_${Date.now()}`,
          ts: Date.now(),
          taskId: this.options.taskId,
          sandboxId: this.options.sandboxId,
          leaseEpoch: this.state.leaseEpoch,
          type: "worker.heartbeat",
          payload: { lastAckedSeq: this.state.lastAckedSeq },
        });
      }, payload.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS_DEFAULT);
      this.heartbeatTimer.unref?.();

      // Re-spool anything unacked from a previous incarnation.
      this.flushBuffer();
      onReady();
      return;
    }

    if (frame.kind === "ack") {
      const upToSeq = Number((frame.payload as { upToSeq?: number }).upToSeq ?? 0);
      this.state.lastAckedSeq = Math.max(this.state.lastAckedSeq, upToSeq);
      this.buffer = this.buffer.filter((entry) => (entry.envelope.seq ?? 0) > upToSeq);
      this.persistState();
      this.persistBuffer();
      return;
    }

    if (frame.kind === "error") {
      const error = (frame.payload as { error?: { code?: string } }).error;
      if (error?.code === "lease_fenced") {
        // A replacement worker owns this task now.
        this.stopped = true;
        this.options.onFenced?.();
        this.stop();
      }
      return;
    }

    if (frame.kind === "command") void this.handleCommand(frame, socket);
  }

  private async handleCommand(frame: Envelope, socket: WebSocket): Promise<void> {
    if (frame.leaseEpoch !== this.state.leaseEpoch) {
      socket.send(
        encodeEnvelope(
          errorEnvelope(
            {
              taskId: frame.taskId,
              sandboxId: frame.sandboxId,
              leaseEpoch: this.state.leaseEpoch,
              inReplyTo: frame.id,
              effectId: frame.effectId,
            },
            {
              code: "lease_fenced",
              message: `command carries epoch ${frame.leaseEpoch}, worker holds ${this.state.leaseEpoch}`,
            },
          ),
        ),
      );
      return;
    }

    try {
      const replay = this.dedupe.lookup(frame.effectId, {
        type: frame.type,
        payload: frame.payload,
      });
      if (replay.duplicate) {
        this.sendRaw(resultEnvelope(frame, { ok: true, value: replay.result }));
        return;
      }
      this.attribute(frame);
      const value = await this.dispatch(frame);
      this.dedupe.record(frame.effectId, { type: frame.type, payload: frame.payload }, value);
      this.sendRaw(resultEnvelope(frame, { ok: true, value }));
    } catch (err) {
      const error = errorPayload(err);
      this.sendRaw(
        resultEnvelope(frame, {
          ok: false,
          code: error.code,
          message: error.message,
          details: error.details,
        }),
      );
    }
  }

  private async dispatch(frame: Envelope): Promise<unknown> {
    const payload = frame.payload as never;
    const driver = (frame.payload as { driver?: string }).driver ?? "";
    // Provider runtimes inside the sandbox resolve relative working
    // directories against the task's own root (its worktree when the sandbox
    // is shared), not the worker's own cwd.
    const root = (frame.payload as { root?: string }).root ?? this.options.workspaceRoot;
    const policy = (frame.payload as { runtimePolicy?: { cwd?: string | null } }).runtimePolicy;
    if (policy?.cwd && !path.isAbsolute(policy.cwd)) {
      policy.cwd = path.resolve(root, policy.cwd);
    }
    switch (frame.type) {
      case "session.open":
        return void (await this.providers.get(driver).openSession(payload));
      case "session.close":
        return void (await this.providers.get(driver).closeSession(payload));
      case "thread.ensure":
        return await this.providers.get(driver).ensureThread(payload);
      case "thread.resume":
        return void (await this.providers.get(driver).resumeThread(payload));
      case "turn.start":
        return void (await this.providers.get(driver).startTurn(payload));
      case "turn.interrupt":
        return void (await this.providers.get(driver).interrupt(payload));
      case "turn.steer":
        return void (await this.providers.get(driver).steer(payload));
      case "runtime_request.respond":
        return void (await this.providers.get(driver).respondRuntimeRequest(payload));
      case "thread.rollback":
        return void (await this.providers.get(driver).rollbackThread(payload));
      case "thread.fork":
        return void (await this.providers.get(driver).forkThread(payload));
      case "workspace.exec":
        return await this.workspace.exec(payload);
      case "workspace.read":
        return await this.workspace.read(payload);
      case "workspace.write":
        return await this.workspace.write(payload);
      case "workspace.list":
        return await this.workspace.list(payload);
      case "workspace.git":
        return await this.workspace.git(payload);
      case "workspace.worktree":
        return await this.workspace.worktree(payload);
      case "checkpoint.capture":
        return await this.workspace.captureCheckpoint(payload);
      case "checkpoint.restore":
        return await this.workspace.restoreCheckpoint(payload);
      case "checkpoint.diff":
        return await this.workspace.diffCheckpoints(payload);
      case "worker.ping":
        return { pong: (payload as { nonce?: string }).nonce, epoch: this.state.leaseEpoch };
      case "worker.drain":
        this.stopped = true;
        return { draining: true };
      default:
        throw new Error(`unknown command ${frame.type}`);
    }
  }

  // -- outbound ------------------------------------------------------------

  /** Emit a normalized provider event (or worker log) to the control plane. */
  emit(
    event: ProviderEventPayload,
    correlation: { threadId?: string; runId?: string } = {},
  ): void {
    this.state.seq += 1;
    const envelope = eventEnvelope(event, {
      taskId: this.taskFor(correlation),
      sandboxId: this.options.sandboxId,
      leaseEpoch: this.state.leaseEpoch,
      seq: this.state.seq,
      ...correlation,
    });
    this.buffer.push({ envelope, at: Date.now() });

    // Bounded buffer: drop oldest unacked events and report the gap.
    if (this.buffer.length > this.maxBufferedEvents) {
      const overflow = this.buffer.length - this.maxBufferedEvents;
      this.buffer.splice(0, overflow);
      this.droppedEvents += overflow;
    }
    this.persistState();
    this.persistBuffer();
    this.flushBuffer();
    if (this.droppedEvents > 0) {
      this.sendRaw({
        v: PROTOCOL_VERSION,
        kind: "event",
        id: `gap_${Date.now()}`,
        ts: Date.now(),
        taskId: this.options.taskId,
        sandboxId: this.options.sandboxId,
        leaseEpoch: this.state.leaseEpoch,
        type: "worker.log",
        payload: {
          level: "warn",
          message: `bounded event buffer overflowed; ${this.droppedEvents} events dropped before ack`,
        },
      });
      this.droppedEvents = 0;
    }
  }

  private flushBuffer(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    for (const entry of this.buffer) this.sendRaw(entry.envelope);
  }

  private sendRaw(envelope: Envelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(encodeEnvelope(envelope));
    } catch {
      // socket died mid-send; the buffer keeps the event for the next connect
    }
  }

  // -- persistence ---------------------------------------------------------

  private persistState(): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state), "utf8");
  }

  private persistBuffer(): void {
    fs.writeFileSync(
      this.bufferFile,
      this.buffer.map((entry) => JSON.stringify(entry.envelope)).join("\n"),
      "utf8",
    );
  }

  private loadBuffer(): void {
    if (!fs.existsSync(this.bufferFile)) return;
    try {
      const lines = fs.readFileSync(this.bufferFile, "utf8").split("\n").filter(Boolean);
      this.buffer = lines.map((line) => ({
        envelope: JSON.parse(line) as Envelope,
        at: Date.now(),
      }));
      // Sequence numbering must not rewind after a restart.
      for (const entry of this.buffer) {
        if ((entry.envelope.seq ?? 0) > this.state.seq) this.state.seq = entry.envelope.seq!;
      }
    } catch {
      this.buffer = [];
    }
  }

  // -- test helpers --------------------------------------------------------

  get currentSeq(): number {
    return this.state.seq;
  }

  get currentEpoch(): number {
    return this.state.leaseEpoch;
  }

  get pendingEvents(): number {
    return this.buffer.length;
  }

  get runtimeHost(): ProviderRuntimeHost {
    return this.providers;
  }
}

/**
 * Task attribution for a provider event: the thread and run it belongs to.
 *
 * The control plane knows which task owns a thread or run; the worker only has
 * to hand back the identifiers it was given, so an event produced for the second
 * task of a shared sandbox is not booked against the first.
 */
function correlationOf(event: ProviderEventPayload): { threadId?: string; runId?: string } {
  const e = event as {
    threadId?: string;
    runId?: string;
    providerThread?: { threadId?: string };
  };
  const threadId = e.threadId ?? e.providerThread?.threadId;
  return {
    ...(threadId ? { threadId } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
  };
}
