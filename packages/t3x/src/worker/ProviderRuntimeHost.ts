/**
 * Provider runtime host.
 *
 * Hosts provider runtimes *inside* the sandbox. In the target architecture
 * these are T3's real provider adapters (Codex App Server, Claude Code,
 * OpenCode, Pi, generic ACP) running in the sandbox's own filesystem; the two
 * built-in runtimes here cover the two ends of the integration surface:
 *
 *  - `echo`: a fully deterministic provider with real session semantics
 *    (native thread state, approvals, interrupts, rollback, fork, steering,
 *    persisted native sessions) used to validate the whole control path;
 *  - `cli`: launches an arbitrary CLI agent (codex / claude / opencode / pi)
 *    with an isolated configuration directory (CODEX_HOME, CLAUDE_CONFIG_DIR,
 *    OPENCODE_CONFIG_DIR) and normalizes its output into protocol events.
 *
 * Capability flags are explicit: we must not claim every provider supports
 * every action, so the VPS-side adapter refuses unsupported operations instead
 * of pretending.
 */

import type {
  ProviderCapabilities,
  ProviderEventPayload,
  ProviderInventoryEntry,
  SessionOpenPayload,
  ThreadEnsurePayload,
  TurnStartPayload,
  TurnInterruptPayload,
  TurnSteerPayload,
  RuntimeRequestRespondPayload,
  ThreadRollbackPayload,
  TextGeneratePayload,
  ThreadForkPayload,
} from "../contracts/workerProtocol.js";
import { CapabilityUnsupportedError, ExecutionError } from "../contracts/errors.js";
import { EchoRuntime } from "./runtimes/EchoRuntime.js";
import { CliRuntime, type CliRuntimeConfig } from "./runtimes/CliRuntime.js";

export type EmitEvent = (event: ProviderEventPayload) => void;

export interface WorkerProviderRuntime {
  readonly driver: string;
  readonly version: string;
  capabilities(): ProviderCapabilities;
  openSession(payload: SessionOpenPayload): Promise<void>;
  closeSession(payload: { providerSessionId: string }): Promise<void>;
  ensureThread(payload: ThreadEnsurePayload): Promise<{ providerThreadId: string }>;
  resumeThread(payload: { threadId: string; providerThreadId: string }): Promise<void>;
  startTurn(payload: TurnStartPayload): Promise<void>;
  interrupt(payload: TurnInterruptPayload): Promise<void>;
  steer(payload: TurnSteerPayload): Promise<void>;
  respondRuntimeRequest(payload: RuntimeRequestRespondPayload): Promise<void>;
  rollbackThread(payload: ThreadRollbackPayload): Promise<void>;
  forkThread(payload: ThreadForkPayload): Promise<void>;
  /**
   * Answer one prompt with no conversation attached. A runtime whose agent CLI
   * cannot be driven one-shot refuses rather than guessing.
   */
  textGenerate(payload: TextGeneratePayload): Promise<{ text: string }>;
  /** Persisted native session state, used for restore-vs-resume semantics. */
  stateSnapshot(): unknown;
  restoreState(snapshot: unknown): void;
  close(): Promise<void>;
}

export interface ProviderRuntimeHostOptions {
  stateDir: string;
  emit: EmitEvent;
  /** Extra CLI agent definitions for the `cli` runtime family. */
  cliAgents?: Record<string, CliRuntimeConfig>;
  /** Home directory holding isolated provider configs. */
  configHome: string;
}

export class ProviderRuntimeHost {
  private readonly runtimes = new Map<string, WorkerProviderRuntime>();

  constructor(private readonly options: ProviderRuntimeHostOptions) {
    this.register(new EchoRuntime({ stateDir: options.stateDir, emit: options.emit }));

    const agents: Record<string, CliRuntimeConfig> = {
      codex: {
        driver: "codex",
        // `--skip-git-repo-check`: codex refuses to run outside a repository it
        // trusts ("Not inside a trusted directory") unless the flag is given,
        // and a task may be scoped to a scratch workspace with no repository at
        // all. The sandbox is the isolation boundary here — the CLI runs as the
        // only tenant of a throwaway container — so the check buys nothing and
        // costs every repository-less task its turn.
        command: 'codex exec --skip-git-repo-check "$PROMPT"',
        configEnv: { CODEX_HOME: `${options.configHome}/.codex` },
      },
      claude: {
        driver: "claude",
        command: 'claude -p "$PROMPT"',
        configEnv: { CLAUDE_CONFIG_DIR: `${options.configHome}/.claude` },
      },
      opencode: {
        driver: "opencode",
        command: 'opencode run "$PROMPT"',
        configEnv: { OPENCODE_CONFIG_DIR: `${options.configHome}/.config/opencode` },
      },
      pi: {
        driver: "pi",
        command: 'pi --prompt "$PROMPT"',
        configEnv: { PI_HOME: `${options.configHome}/.pi` },
      },
      ...(options.cliAgents ?? {}),
    };
    for (const config of Object.values(agents)) {
      this.register(
        new CliRuntime({
          config: { ...config, stateDir: options.stateDir },
          emit: options.emit,
        }),
      );
    }
  }

  register(runtime: WorkerProviderRuntime): void {
    this.runtimes.set(runtime.driver, runtime);
  }

  get(driver: string): WorkerProviderRuntime {
    const runtime = this.runtimes.get(driver);
    if (!runtime) {
      throw new ExecutionError("capability_unsupported", `unknown provider ${driver}`, { driver });
    }
    return runtime;
  }

  inventory(): ProviderInventoryEntry[] {
    return [...this.runtimes.values()].map((runtime) => ({
      driver: runtime.driver,
      capabilities: runtime.capabilities(),
      version: runtime.version,
    }));
  }

  requireCapability(driver: string, capability: keyof ProviderCapabilities): WorkerProviderRuntime {
    const runtime = this.get(driver);
    if (!runtime.capabilities()[capability]) {
      throw new CapabilityUnsupportedError(driver, capability);
    }
    return runtime;
  }

  snapshotAll(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [driver, runtime] of this.runtimes) out[driver] = runtime.stateSnapshot();
    return out;
  }

  restoreAll(snapshot: Record<string, unknown>): void {
    for (const [driver, runtime] of this.runtimes) {
      if (snapshot[driver] !== undefined) runtime.restoreState(snapshot[driver]);
    }
  }

  async close(): Promise<void> {
    for (const runtime of this.runtimes.values()) await runtime.close();
  }
}

export type {
  ProviderCapabilities,
  ProviderEventPayload,
  SessionOpenPayload,
  ThreadEnsurePayload,
  TurnStartPayload,
  TurnInterruptPayload,
  TurnSteerPayload,
  RuntimeRequestRespondPayload,
  ThreadRollbackPayload,
  ThreadForkPayload,
};
