/**
 * Driver configuration for a provider instance that runs inside a Daytona task
 * sandbox.
 *
 * A provider instance is a *route to a sandbox*: the control plane owns the
 * sandbox, the repository, the environment profile and the agent process, and
 * T3 talks to it as a provider. One instance can therefore serve many threads,
 * each in its own sandbox (or in its project's shared one).
 */
import * as Schema from "effect/Schema";

export const DaytonaProviderConfig = Schema.Struct({
  /** Base URL of the control plane, e.g. `https://t3x.example.com`. */
  controlPlaneUrl: Schema.String,
  /** Bearer token, when the control plane requires one. */
  apiToken: Schema.optional(Schema.String),
  /** Environment profile the sandbox is provisioned from. */
  profileId: Schema.String,
  /** Repository cloned into the sandbox. Omit for a scratch workspace. */
  repositoryUrl: Schema.optional(Schema.String),
  /** Branch checked out (and the base ref for per-task worktrees). */
  branch: Schema.optional(Schema.String),
  /**
   * `project` (default) shares one sandbox per repository and gives every task
   * its own git worktree; `task` provisions a sandbox per thread.
   */
  sandboxScope: Schema.optional(Schema.Literals(["project", "task"])),
  /** Existing project id on the control plane, when one is already registered. */
  projectId: Schema.optional(Schema.String),
  /** Agent to run inside the sandbox: codex, claude, opencode, pi or echo. */
  agent: Schema.optional(Schema.String),
  /** Default model passed to the agent. */
  model: Schema.optional(Schema.String),
  /** How often the adapter polls the control plane for a task's state. */
  pollIntervalMs: Schema.optional(Schema.Number),
  /** How long a provisioned task may take to become ready. */
  readyTimeoutMs: Schema.optional(Schema.Number),
});
export type DaytonaProviderConfig = typeof DaytonaProviderConfig.Type;

export const defaultConfig = (): DaytonaProviderConfig => ({
  controlPlaneUrl: "http://127.0.0.1:8087",
  profileId: "typescript-backend",
  agent: "codex",
});

/** The control plane is always reachable over HTTP(S); reject anything else. */
export const normalizeControlPlaneUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
};
