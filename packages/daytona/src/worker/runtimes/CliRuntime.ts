/**
 * CLI provider runtime: launches a real CLI coding agent inside the sandbox.
 *
 * This is the adapter slot where Codex, Claude Code, OpenCode and Pi plug in:
 * each gets an isolated configuration directory (CODEX_HOME,
 * CLAUDE_CONFIG_DIR, OPENCODE_CONFIG_DIR, PI_HOME), runs in the task's
 * workspace, and its output is normalized into protocol events.
 *
 * The runtime is honest about capabilities: a plain CLI process has no
 * steering, no native rollback and no native fork, so those flags are false
 * and the VPS-side adapter rejects the operations instead of faking them.
 */

import { spawn, type ChildProcess } from "node:child_process";
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
import { CapabilityUnsupportedError, ExecutionError } from "../../contracts/errors.js";
import type { EmitEvent, WorkerProviderRuntime } from "../ProviderRuntimeHost.js";

export interface CliRuntimeConfig {
  driver: string;
  /**
   * Shell command template. `$PROMPT` is substituted with the shell-quoted
   * user message, `$CWD` with the task working directory.
   */
  command: string;
  /** Isolated configuration directories exported to the agent process. */
  configEnv?: Record<string, string>;
  /** Extra environment (non-secret values only). */
  env?: Record<string, string>;
  stateDir?: string;
  stripPrefix?: string;
  version?: string;
}

export class CliRuntime implements WorkerProviderRuntime {
  readonly driver: string;
  readonly version: string;

  private readonly config: CliRuntimeConfig;
  private readonly emit: EmitEvent;
  private readonly threads = new Map<string, { providerThreadId: string; cwd: string }>();
  private readonly pendingApprovals = new Map<
    string,
    { runId: string; providerTurnId: string; threadId: string; resolve: (ok: boolean) => void }
  >();
  private readonly running = new Map<string, ChildProcess>();
  /** Runs the user interrupted, so their terminal status is not "failed". */
  private readonly interruptedRuns = new Set<string>();

  constructor(options: { config: CliRuntimeConfig; emit: EmitEvent }) {
    this.config = options.config;
    this.driver = options.config.driver;
    this.version = options.config.version ?? "cli";
    this.emit = options.emit;
  }

  capabilities(): ProviderCapabilities {
    return {
      fork: false,
      rollback: false,
      steer: false,
      subagents: false,
      background: false,
      nativeResume: false,
      approvals: false,
    };
  }

  async openSession(payload: SessionOpenPayload): Promise<void> {
    this.emit({
      type: "session.updated",
      driver: this.driver,
      providerSession: {
        providerSessionId: payload.providerSessionId,
        threadId: payload.threadId,
        status: "ready",
        configDirs: this.config.configEnv ?? {},
      },
    });
  }

  async closeSession(): Promise<void> {
    for (const child of this.running.values()) child.kill("SIGKILL");
    this.running.clear();
  }

  async ensureThread(payload: ThreadEnsurePayload): Promise<{ providerThreadId: string }> {
    const existing = this.threads.get(payload.threadId);
    if (existing) return { providerThreadId: existing.providerThreadId };
    const entry = {
      providerThreadId: `${this.driver}_${payload.threadId}`,
      cwd: payload.runtimePolicy.cwd ?? process.cwd(),
    };
    this.threads.set(payload.threadId, entry);
    this.emit({ type: "thread.updated", driver: this.driver, providerThread: entry });
    return { providerThreadId: entry.providerThreadId };
  }

  async resumeThread(): Promise<void> {
    // CLI processes are not resumable; a resume re-runs with explicit context.
  }

  async startTurn(payload: TurnStartPayload): Promise<void> {
    const thread = this.threads.get(payload.threadId);
    if (!thread)
      throw new ExecutionError("task_not_found", `thread ${payload.threadId} not ensured`);

    const providerTurnId = `${this.driver}_turn_${payload.runId}`;
    this.emit({
      type: "turn.updated",
      driver: this.driver,
      threadId: payload.threadId,
      providerTurn: { providerTurnId, runId: payload.runId, status: "running" },
    });

    const prompt = payload.message.text;
    const command = this.config.command
      .split("$PROMPT")
      .join(shellQuote(prompt))
      .split("$CWD")
      .join(shellQuote(thread.cwd));

    const child = spawn("bash", ["-c", command], {
      cwd: thread.cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...(this.config.configEnv ?? {}),
        ...(this.config.env ?? {}),
        T3X_PROVIDER: this.driver,
      },
      // Own process group: the agent is a tree (bash → codex → its children),
      // and an interrupt has to reach the whole tree, not just the outer shell.
      detached: true,
    });
    this.running.set(payload.runId, child);

    let messageId = 0;
    const emitLine = (line: string) => {
      const text =
        this.config.stripPrefix && line.startsWith(this.config.stripPrefix)
          ? line.slice(this.config.stripPrefix.length)
          : line;
      this.emit({
        type: "message.updated",
        driver: this.driver,
        threadId: payload.threadId,
        runId: payload.runId,
        message: {
          messageId: `${providerTurnId}_m${messageId++}`,
          role: "assistant",
          text,
          streaming: true,
        },
      });
    };

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) emitLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) {
          this.emit({ type: "worker.log", level: "debug", message: `[${this.driver}] ${line}` });
        }
      }
    });

    // `turn.start` completes once the agent process is running: the turn's
    // outcome arrives later as `turn.terminal` on the event stream. Blocking
    // here would hold the control plane's effect loop for the whole turn, so
    // steer and interrupt could not be delivered until it was over.
    let finished = false;
    const finish = (emit: () => void) => {
      if (finished) return;
      finished = true;
      this.running.delete(payload.runId);
      emit();
    };
    child.on("close", (code) => {
      finish(() => {
        if (buffer.trim()) emitLine(buffer.trim());
        this.emit({
          type: "turn.terminal",
          driver: this.driver,
          providerThreadId: thread.providerThreadId,
          providerTurnId,
          runId: payload.runId,
          runOrdinal: 1,
          status: this.interruptedRuns.has(payload.runId)
            ? "interrupted"
            : code === 0
              ? "completed"
              : "failed",
          threadDisposition: "reusable",
          ...(code === 0 || this.interruptedRuns.has(payload.runId)
            ? {}
            : { failure: { kind: "process_exit", exitCode: code ?? 1 } }),
        });
      });
    });
    child.on("error", (err) => {
      finish(() =>
        this.emit({
          type: "turn.terminal",
          driver: this.driver,
          providerThreadId: thread.providerThreadId,
          providerTurnId,
          runId: payload.runId,
          runOrdinal: 1,
          status: "failed",
          threadDisposition: "broken",
          failure: { kind: "spawn_error", message: String(err) },
        }),
      );
    });
  }

  async interrupt(payload: TurnInterruptPayload): Promise<void> {
    const child = this.running.get(payload.runId);
    if (!child?.pid) return;
    this.interruptedRuns.add(payload.runId);
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
  }

  async steer(_payload: TurnSteerPayload): Promise<void> {
    throw new CapabilityUnsupportedError(this.driver, "steer");
  }

  async respondRuntimeRequest(payload: RuntimeRequestRespondPayload): Promise<void> {
    const pending = this.pendingApprovals.get(payload.requestId);
    if (!pending) return;
    this.pendingApprovals.delete(payload.requestId);
    pending.resolve(payload.decision === "approved");
    this.emit({
      type: "runtime_request.updated",
      driver: this.driver,
      threadId: pending.threadId,
      runtimeRequest: {
        requestId: payload.requestId,
        kind: "approval",
        summary: "approval resolved",
        status: "resolved",
      },
    });
  }

  async rollbackThread(_payload: ThreadRollbackPayload): Promise<void> {
    throw new CapabilityUnsupportedError(this.driver, "rollback");
  }

  async forkThread(_payload: ThreadForkPayload): Promise<void> {
    throw new CapabilityUnsupportedError(this.driver, "fork");
  }

  stateSnapshot(): unknown {
    return { threads: Object.fromEntries(this.threads) };
  }

  restoreState(snapshot: unknown): void {
    const state = snapshot as {
      threads?: Record<string, { providerThreadId: string; cwd: string }>;
    };
    for (const [key, value] of Object.entries(state.threads ?? {})) {
      this.threads.set(key, value);
    }
  }

  async close(): Promise<void> {
    await this.closeSession();
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
