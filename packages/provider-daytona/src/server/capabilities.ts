/**
 * What a Daytona-backed provider can actually do.
 *
 * The honest source is the sandbox: the worker advertises a capability inventory
 * per agent (`echo`, `codex`, `claude`, `opencode`, `pi`), and the control plane
 * refuses operations the worker cannot perform. Those inventories are known
 * before a session exists, though, so this module derives the same answers from
 * the configured agent — and the adapter refines them from the live worker
 * inventory as soon as a task is ready.
 */
import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";

/** The subset of the worker's inventory this adapter maps. */
export interface WorkerCapabilities {
  fork: boolean;
  rollback: boolean;
  steer: boolean;
  subagents: boolean;
  background: boolean;
  nativeResume: boolean;
  approvals: boolean;
}

/**
 * Agents that run as a plain CLI process cannot be steered, rolled back or
 * forked: the sandbox has no native protocol to ask. `echo` is the deterministic
 * runtime the test suite drives and does all three.
 */
export const workerCapabilitiesForAgent = (agent: string | undefined): WorkerCapabilities => {
  switch (agent) {
    case "echo":
      return {
        fork: true,
        rollback: true,
        steer: true,
        subagents: true,
        background: false,
        nativeResume: true,
        approvals: true,
      };
    default:
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
};

export const capabilitiesFromWorker = (
  worker: Partial<WorkerCapabilities> | undefined,
  fallbackAgent?: string,
): OrchestrationV2ProviderCapabilities => {
  const base = workerCapabilitiesForAgent(fallbackAgent);
  const capabilities: WorkerCapabilities = { ...base, ...(worker ?? {}) };
  return {
    sessions: {
      supportsMultipleProviderThreadsPerSession: true,
      supportsModelSwitchInSession: false,
      supportsProviderSwitchingViaHandoff: false,
      supportsRuntimeModeSwitchInSession: false,
      // A parked approval lives in the control plane's event log, so it
      // survives a client restart.
      pendingRequestsSurviveRestart: true,
    },
    threads: {
      canCreateEmptyThread: true,
      canReadThreadSnapshot: true,
      canRollbackThread: capabilities.rollback,
      canForkThread: capabilities.fork,
      canForkFromTurn: capabilities.fork,
      canForkFromSubagentThread: false,
      exposesNativeThreadId: true,
    },
    turns: {
      exposesNativeTurnId: true,
      emitsTurnStarted: true,
      emitsTurnCompleted: true,
      supportsInterrupt: true,
      supportsActiveSteering: capabilities.steer,
      supportsSteeringByInterruptRestart: false,
      supportsQueuedMessages: false,
      terminalStatusQuality: "strong",
    },
    streaming: {
      streamsAssistantText: true,
      streamsReasoning: false,
      streamsToolOutput: false,
      streamsPlanText: false,
      emitsMessageCompleted: true,
    },
    tools: {
      exposesToolItemIds: false,
      emitsToolStarted: false,
      emitsToolCompleted: false,
      emitsToolOutput: false,
      supportsMcpTools: false,
      supportsDynamicToolCallbacks: false,
    },
    approvals: {
      supportsCommandApproval: capabilities.approvals,
      supportsFileReadApproval: false,
      supportsFileChangeApproval: false,
      supportsApplyPatchApproval: false,
      approvalsHaveNativeRequestIds: true,
      approvalCallbacksAreLiveOnly: true,
      approvalsCanOriginateFromSubagents: false,
    },
    planning: {
      emitsPlanUpdated: false,
      emitsTodoList: false,
      emitsProposedPlan: false,
      supportsStructuredQuestions: false,
      planDeltasHaveItemIds: false,
    },
    subagents: {
      supportsSubagents: capabilities.subagents,
      exposesSubagentThreadIds: false,
      emitsSubagentLifecycle: false,
      canWaitForSubagents: false,
      canCloseSubagents: false,
      canForkSubagentThread: false,
    },
    context: {
      acceptsSystemContext: false,
      acceptsDeveloperContext: false,
      acceptsSyntheticUserContext: false,
      canGenerateSummaries: false,
      canConsumeHandoffSummaries: false,
      supportsDeltaHandoff: false,
      supportsFullThreadHandoff: false,
      maxRecommendedHandoffChars: null,
    },
    checkpointing: {
      // Checkpoints are git refs in the sandbox's worktree: the app can capture
      // and restore them, and the provider can read the conversation back.
      appCanCheckpointFilesystem: true,
      supportsNestedCheckpointScopes: false,
      providerCanRollbackConversation: capabilities.rollback,
      providerRollbackReturnsSnapshot: false,
      providerCanReadConversationSnapshot: true,
    },
    identity: {
      nativeThreadIds: "strong",
      nativeTurnIds: "strong",
      nativeItemIds: "none",
      nativeRequestIds: "strong",
    },
    runtimePolicy: {
      // The agent runs inside a sandbox whose profile carries the environment,
      // but T3's runtime modes are enforced where T3 mediates the work.
      enforcement: "client-boundary",
    },
  };
};
