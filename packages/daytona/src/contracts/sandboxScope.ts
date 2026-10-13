/**
 * Sandbox scope: one shared sandbox per project, or one dedicated sandbox per
 * task.
 *
 * The original design gave every task its own sandbox. That is the strictest
 * isolation, but it also reinstalls dependencies, re-warms caches and restarts
 * development services for every thread. The revised default is therefore
 *
 *   - **project scope (default)**: one Daytona sandbox per project/repository,
 *     shared by its tasks, each of which works in its *own git worktree*;
 *   - **task scope (opt-in)**: a dedicated sandbox for one task.
 *
 * A sandbox and a worktree are different concepts. Sharing a sandbox shares
 * the base snapshot, runtimes, caches, dev services and environment
 * configuration; it never shares a working directory, because every task gets
 * its own branch and checkout.
 *
 * Reuse is only safe when the environments are compatible, so a project
 * sandbox carries a *compatibility key* (repository + resolved profile digest +
 * snapshot/platform + working directory + the credential trust domain). A task
 * whose key differs is automatically given a dedicated sandbox instead of being
 * dropped into a sandbox whose dependencies or credentials it does not share —
 * separate worktrees are not a security boundary.
 */

import type { ResolvedProfile } from "./environmentProfile.js";
import { canonicalize } from "./canonical.js";
import { sha256Hex } from "./ids.js";

export type SandboxScope = "project" | "task";

/** Global default: a shared sandbox per project/repository. */
export const DEFAULT_SANDBOX_SCOPE: SandboxScope = "project";

/**
 * Per-project execution policy. The project default may be left null so the
 * global default (the profile's `sandbox.isolation`) applies.
 */
export interface ProjectExecutionPolicy {
  projectId: string;
  name: string;
  /** Repository the project's sandbox is based on; "" for repository-less work. */
  repositoryUrl: string;
  defaultScope: SandboxScope | null;
  environmentProfileId: string | null;
  /** Tasks allowed to share one project sandbox before spilling to dedicated ones. */
  maxConcurrentTasks: number;
  createdAt: number;
  updatedAt: number;
}

/** A sandbox that belongs to a project rather than to a single task. */
export interface ProjectSandboxRecord {
  sandboxId: string;
  /**
   * The project this sandbox serves, or null for a sandbox that belongs to a
   * single task (a task with no repository, or one that opted out). Dedicated
   * sandboxes are recorded too, so clients can list and stop them.
   */
  projectId: string | null;
  backend: "local" | "opensandbox";
  profileId: string;
  profileDigest: string;
  compatibilityKey: string;
  snapshot: string;
  repositoryUrl: string;
  branch: string;
  /** Sandbox-absolute working directory of the base checkout. */
  workspaceRoot: string;
  state: "creating" | "running" | "stopped" | "deleted";
  /** Whether this sandbox is shared by a project's tasks or belongs to one task. */
  scope: SandboxScope;
  /** Fencing epoch of the worker lease for this sandbox (shared by its tasks). */
  leaseEpoch: number;
  /** Reference count: how many tasks currently need this sandbox. */
  taskCount: number;
  createdAt: number;
  lastUsedAt: number;
}

/** Where a task's execution was actually bound. */
export interface TaskExecutionBinding {
  taskId: string;
  threadId: string;
  sandboxId: string | null;
  scope: SandboxScope;
  projectId: string | null;
  /** Sandbox-absolute path the task's agent works in (its worktree, or the checkout). */
  worktreePath: string;
  worktreeBranch: string;
  /** Sandbox-absolute directory of the base checkout the worktree belongs to. */
  workspaceRoot: string;
  profileId: string;
  profileDigest: string;
  resolvedProfileDigest: string;
  repositoryUrl: string;
  branch: string;
  state: string;
  /** Fencing epoch of the worker lease (shared with the sandbox's other tasks). */
  leaseEpoch: number;
  lastEventSequence: number;
}

export type SandboxScopeReason =
  | "task_override"
  | "project_default"
  | "global_default"
  | "policy_requires_task_isolation"
  | "no_repository"
  | "incompatible_environment"
  | "concurrency_limit"
  | "shared_project_sandbox";

export interface SandboxScopeResolution {
  scope: SandboxScope;
  reason: SandboxScopeReason;
  projectId: string | null;
  compatibilityKey: string | null;
}

/**
 * The task's explicit preference wins, then the project default, then the
 * global default. Changing a default never migrates a running task: the
 * decision is made once, when the task is created.
 */
export function resolveSandboxScope(input: {
  requested?: SandboxScope | undefined;
  project?: ProjectExecutionPolicy | null;
  profile: ResolvedProfile;
  repositoryUrl: string;
  globalDefault?: SandboxScope;
}): SandboxScopeResolution {
  const globalDefault = input.globalDefault ?? DEFAULT_SANDBOX_SCOPE;
  const projectId = input.project?.projectId ?? null;

  // Administrators may forbid shared sandboxes outright; nothing overrides it.
  if (input.profile.policy.requireTaskIsolation) {
    return {
      scope: "task",
      reason: "policy_requires_task_isolation",
      projectId,
      compatibilityKey: null,
    };
  }

  let scope: SandboxScope;
  let reason: SandboxScopeReason;
  if (input.requested) {
    scope = input.requested;
    reason = "task_override";
  } else if (input.project?.defaultScope) {
    scope = input.project.defaultScope;
    reason = "project_default";
  } else {
    // The profile's `isolation` names the global default; the project default
    // above it, and an explicit task request above that.
    scope =
      input.profile.body.sandbox.isolation === "per-task"
        ? "task"
        : (globalDefault ?? DEFAULT_SANDBOX_SCOPE);
    reason = "global_default";
  }

  // Without a repository there is no base checkout, so there is nothing a
  // worktree could branch from and nothing worth sharing.
  if (scope === "project" && input.repositoryUrl.trim() === "") {
    return { scope: "task", reason: "no_repository", projectId, compatibilityKey: null };
  }

  return {
    scope,
    reason,
    projectId,
    compatibilityKey:
      scope === "project"
        ? sandboxCompatibilityKey({
            profile: input.profile,
            repositoryUrl: input.repositoryUrl,
          })
        : null,
  };
}

/**
 * Everything two tasks must agree on before they may share one sandbox:
 * repository, resolved Environment Profile (digest pins snapshot, platform,
 * working directory, resources, setup and agent configuration), and the
 * credential trust domain — a task with a different secret set is never placed
 * in a sandbox whose processes could read those credentials.
 */
export function sandboxCompatibilityKey(input: {
  profile: ResolvedProfile;
  repositoryUrl: string;
  secretNames?: string[];
}): string {
  const secretNames = [...(input.secretNames ?? input.profile.body.secrets.map((s) => s.name))];
  secretNames.sort();
  return sha256Hex(
    canonicalize({
      repositoryUrl: input.repositoryUrl,
      profileDigest: input.profile.digest,
      profileId: input.profile.profileId,
      // An image-backed profile has no snapshot; "" keeps the key stable.
      snapshot: input.profile.body.runtime.snapshot ?? "",
      platform: input.profile.body.runtime.platform,
      workingDirectory: input.profile.body.project.workingDirectory,
      resources: input.profile.body.runtime.resources,
      secrets: secretNames,
      requireTaskIsolation: input.profile.policy.requireTaskIsolation,
    }),
  ).slice(0, 32);
}

/** Sandbox-absolute path of a task's worktree inside a shared project sandbox. */
export function worktreePathFor(workingDirectory: string, taskId: string): string {
  const parent = workingDirectory.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
  return `${parent === "/" ? "" : parent}/worktrees/${taskId}`;
}

/** Branch a task's worktree is created on. */
export function worktreeBranchFor(taskId: string): string {
  return `t3x/${taskId}`;
}

/**
 * A project is identified by its repository: tasks that name no project but
 * share a repository end up in the same project sandbox, which is what "one
 * sandbox per project/repo" means to a user who never configured anything.
 */
export function projectIdForRepository(repositoryUrl: string): string {
  if (!repositoryUrl.trim()) return "prj_unversioned";
  return `prj_${sha256Hex(repositoryUrl.trim()).slice(0, 16)}`;
}
