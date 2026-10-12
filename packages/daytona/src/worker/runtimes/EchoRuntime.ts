/**
 * Echo provider runtime: a deterministic agent with real provider semantics.
 *
 * It exercises the entire remote path — sessions, threads, turns, streaming
 * message chunks, approval runtime requests, interrupts, steering, rollback,
 * forks and *persisted native session state* — without depending on an
 * external agent binary. Everything the report says provider sessions must
 * survive (stop/start, worker restarts, recovery) is validated against this
 * runtime before any real provider is wired in.
 *
 * Turn semantics:
 *   - a normal message produces two streamed assistant chunks and a terminal
 *     `turn.terminal(completed)`;
 *   - a message containing `danger:` opens a pending approval runtime request
 *     and leaves the turn waiting — the supervised flow a real agent uses for
 *     privileged commands;
 *   - answering the request resumes and terminates the turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ProviderCapabilities,
  SessionOpenPayload,
  ThreadEnsurePayload,
  TurnStartPayload,
  TurnInterruptPayload,
  TurnSteerPayload,
  RuntimeRequestRespondPayload,
  ThreadRollbackPayload,
  ThreadForkPayload,
} from "../../contracts/workerProtocol.js";
import { ExecutionError } from "../../contracts/errors.js";
import type { EmitEvent, WorkerProviderRuntime } from "../ProviderRuntimeHost.js";

interface EchoMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

interface PendingRequest {
  requestId: string;
  runId: string;
  providerTurnId: string;
  threadId: string;
  prompt: string;
  startedAt: number;
}

interface EchoThread {
  providerThreadId: string;
  title: string;
  messages: EchoMessage[];
  pendingRequest: PendingRequest | null;
  runningTurn: { providerTurnId: string; runId: string } | null;
  turnCounter: number;
}

interface EchoState {
  threads: Record<string, EchoThread>;
  sessions: Record<string, { providerSessionId: string; openedAt: number }>;
}

const CAPABILITIES: ProviderCapabilities = {
  fork: true,
  rollback: true,
  steer: true,
  subagents: true,
  background: true,
  nativeResume: true,
  approvals: true,
};

export class EchoRuntime implements WorkerProviderRuntime {
  readonly driver = "echo";
  readonly version = "1.0.0";

  private readonly stateFile: string;
  private readonly emit: EmitEvent;
  private state: EchoState = { threads: {}, sessions: {} };

  constructor(options: { stateDir: string; emit: EmitEvent }) {
    this.stateFile = path.join(options.stateDir, "echo-runtime.json");
    this.emit = options.emit;
    fs.mkdirSync(options.stateDir, { recursive: true });
    if (fs.existsSync(this.stateFile)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as EchoState;
      } catch {
        this.state = { threads: {}, sessions: {} };
      }
    }
  }

  private persist(): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
  }

  capabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  async openSession(payload: SessionOpenPayload): Promise<void> {
    this.state.sessions[payload.threadId] = {
      providerSessionId: payload.providerSessionId,
      openedAt: Date.now(),
    };
    this.persist();
    this.emit({
      type: "session.updated",
      driver: this.driver,
      providerSession: {
        providerSessionId: payload.providerSessionId,
        threadId: payload.threadId,
        status: "ready",
      },
    });
  }

  async closeSession(payload: { providerSessionId: string }): Promise<void> {
    for (const [threadId, session] of Object.entries(this.state.sessions)) {
      if (session.providerSessionId === payload.providerSessionId) {
        delete this.state.sessions[threadId];
      }
    }
    this.persist();
    this.emit({
      type: "session.updated",
      driver: this.driver,
      providerSession: { providerSessionId: payload.providerSessionId, status: "stopped" },
    });
  }

  async ensureThread(payload: ThreadEnsurePayload): Promise<{ providerThreadId: string }> {
    const existing = this.state.threads[payload.threadId];
    if (existing) {
      this.emitThread(payload.threadId);
      return { providerThreadId: existing.providerThreadId };
    }
    const thread: EchoThread = {
      providerThreadId: `echo_${payload.threadId}`,
      title: payload.title ?? payload.threadId,
      messages: [],
      pendingRequest: null,
      runningTurn: null,
      turnCounter: 0,
    };
    this.state.threads[payload.threadId] = thread;
    this.persist();
    this.emitThread(payload.threadId);
    return { providerThreadId: thread.providerThreadId };
  }

  async resumeThread(payload: { threadId: string; providerThreadId: string }): Promise<void> {
    const thread = this.state.threads[payload.threadId];
    if (!thread) {
      throw new ExecutionError(
        "task_not_found",
        `native thread ${payload.providerThreadId} is gone`,
      );
    }
    this.emitThread(payload.threadId);
  }

  async startTurn(payload: TurnStartPayload): Promise<void> {
    const thread = this.state.threads[payload.threadId];
    if (!thread) {
      throw new ExecutionError("task_not_found", `thread ${payload.threadId} not ensured`);
    }
    const providerTurnId = `turn_${payload.runId}`;
    thread.turnCounter += 1;
    thread.runningTurn = { providerTurnId, runId: payload.runId };
    thread.messages.push({ role: "user", text: payload.message.text, at: Date.now() });
    this.persist();

    this.emit({
      type: "turn.updated",
      driver: this.driver,
      threadId: payload.threadId,
      providerTurn: {
        providerTurnId,
        runId: payload.runId,
        runOrdinal: payload.runOrdinal,
        status: "running",
      },
    });

    if (/danger:/i.test(payload.message.text)) {
      const requestId = `req_${payload.runId}`;
      thread.pendingRequest = {
        requestId,
        runId: payload.runId,
        providerTurnId,
        threadId: payload.threadId,
        prompt: payload.message.text,
        startedAt: Date.now(),
      };
      this.persist();
      this.emit({
        type: "runtime_request.updated",
        driver: this.driver,
        threadId: payload.threadId,
        runtimeRequest: {
          requestId,
          kind: "approval",
          summary: `Approve privileged action: ${payload.message.text.slice(0, 120)}`,
          detail: { prompt: payload.message.text },
          status: "pending",
        },
      });
      return;
    }

    await this.finishTurn(
      payload.threadId,
      providerTurnId,
      payload.runId,
      `echo: ${payload.message.text}`,
    );
  }

  private async finishTurn(
    threadId: string,
    providerTurnId: string,
    runId: string,
    text: string,
  ): Promise<void> {
    const thread = this.state.threads[threadId];
    if (!thread) return;

    // Two streamed chunks, like a real incremental provider.
    const half = Math.max(1, Math.floor(text.length / 2));
    for (const [index, chunk] of [text.slice(0, half), text.slice(half)].entries()) {
      this.emit({
        type: "message.updated",
        driver: this.driver,
        threadId,
        runId,
        message: {
          messageId: `${providerTurnId}_m${index}`,
          role: "assistant",
          text: chunk,
          streaming: index === 0,
        },
      });
    }

    thread.messages.push({ role: "assistant", text, at: Date.now() });
    thread.runningTurn = null;
    thread.pendingRequest = null;
    this.persist();

    this.emit({
      type: "turn.terminal",
      driver: this.driver,
      providerThreadId: thread.providerThreadId,
      providerTurnId,
      runId,
      runOrdinal: thread.turnCounter,
      status: "completed",
      threadDisposition: "reusable",
    });
  }

  async interrupt(payload: TurnInterruptPayload): Promise<void> {
    const thread = this.state.threads[payload.threadId];
    if (!thread || !thread.runningTurn) return;
    const { providerTurnId, runId } = thread.runningTurn;
    thread.runningTurn = null;
    thread.pendingRequest = null;
    this.persist();
    this.emit({
      type: "turn.terminal",
      driver: this.driver,
      providerThreadId: thread.providerThreadId,
      providerTurnId,
      runId,
      runOrdinal: thread.turnCounter,
      status: "interrupted",
      threadDisposition: "reusable",
    });
  }

  async steer(payload: TurnSteerPayload): Promise<void> {
    const thread = this.state.threads[payload.threadId];
    if (!thread?.runningTurn) return;
    this.emit({
      type: "message.updated",
      driver: this.driver,
      threadId: payload.threadId,
      runId: payload.runId,
      message: {
        messageId: `steer_${payload.runId}`,
        role: "user",
        text: payload.text,
        streaming: true,
      },
    });
  }

  async respondRuntimeRequest(payload: RuntimeRequestRespondPayload): Promise<void> {
    for (const [threadId, thread] of Object.entries(this.state.threads)) {
      if (thread.pendingRequest?.requestId !== payload.requestId) continue;
      const pending = thread.pendingRequest;
      thread.pendingRequest = null;
      this.persist();
      this.emit({
        type: "runtime_request.updated",
        driver: this.driver,
        threadId,
        runtimeRequest: {
          requestId: pending.requestId,
          kind: "approval",
          summary: "approval resolved",
          status: "resolved",
        },
      });

      if (payload.decision === "approved") {
        await this.finishTurn(
          threadId,
          pending.providerTurnId,
          pending.runId,
          `approved: ${pending.prompt}`,
        );
      } else {
        thread.runningTurn = null;
        this.persist();
        this.emit({
          type: "turn.terminal",
          driver: this.driver,
          providerThreadId: thread.providerThreadId,
          providerTurnId: pending.providerTurnId,
          runId: pending.runId,
          runOrdinal: thread.turnCounter,
          status: payload.decision === "rejected" ? "cancelled" : "interrupted",
          threadDisposition: "reusable",
        });
      }
      return;
    }
    throw new ExecutionError("task_not_found", `runtime request ${payload.requestId} not found`);
  }

  async rollbackThread(payload: ThreadRollbackPayload): Promise<void> {
    const thread = this.state.threads[payload.threadId];
    if (!thread) return;
    thread.messages.pop();
    this.persist();
    this.emitThread(payload.threadId);
  }

  async forkThread(payload: ThreadForkPayload): Promise<void> {
    const thread = this.state.threads[payload.threadId];
    if (!thread) return;
    const forked: EchoThread = {
      ...thread,
      providerThreadId: `${thread.providerThreadId}_fork`,
      messages: [...thread.messages],
      pendingRequest: null,
      runningTurn: null,
    };
    this.state.threads[`${payload.threadId}_fork`] = forked;
    this.persist();
    this.emit({
      type: "thread.updated",
      driver: this.driver,
      providerThread: {
        providerThreadId: forked.providerThreadId,
        forkedFrom: thread.providerThreadId,
      },
    });
  }

  private emitThread(threadId: string): void {
    const thread = this.state.threads[threadId];
    if (!thread) return;
    this.emit({
      type: "thread.updated",
      driver: this.driver,
      providerThread: {
        providerThreadId: thread.providerThreadId,
        threadId,
        title: thread.title,
        messageCount: thread.messages.length,
      },
    });
  }

  stateSnapshot(): unknown {
    return this.state;
  }

  restoreState(snapshot: unknown): void {
    this.state = snapshot as EchoState;
    this.persist();
  }

  async close(): Promise<void> {
    this.persist();
  }
}
