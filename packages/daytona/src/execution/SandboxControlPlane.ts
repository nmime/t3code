/**
 * SandboxControlPlane (report §7, revised for sandbox scope).
 *
 * Runs on the VPS and owns task scheduling, configuration resolution, sandbox
 * lifecycle, cost controls, secret references, worker authentication and
 * recovery. It never executes repository work itself — that happens in the
 * task's sandbox worker.
 *
 * Sandbox allocation follows the revised model:
 *
 *  - **project scope (default)** — one sandbox per project/repository, created
 *    lazily with the first task, reused while its compatibility key matches,
 *    with one git worktree per task;
 *  - **task scope** — a dedicated sandbox for one task (explicit request,
 *    incompatible environment, or a credential trust domain of its own);
 *  - the sandbox is **reference counted**: it is only stopped or destroyed when
 *    the last task bound to it has been stopped or destroyed, never on
 *    infrastructure idleness alone.
 *
 * All lifecycle operations are effect-driven and idempotent: provisioning a
 * task that already has a live sandbox is a no-op, so a retry after a crash
 * cannot create a second sandbox or a second worker.
 */

import { spawn } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type {
  SandboxControlPlane as SandboxControlPlanePort,
  ReconcileReport,
  TaskRecord,
} from "../contracts/execution.js";
import {
  DEFAULT_SANDBOX_SCOPE,
  resolveSandboxScope,
  sandboxCompatibilityKey,
  worktreeBranchFor,
  worktreePathFor,
  type ProjectSandboxRecord,
  type SandboxScope,
  type SandboxScopeReason,
} from "../contracts/sandboxScope.js";
import type { SandboxBackend, SandboxSpec } from "./backends/SandboxBackend.js";
import { LocalBackend } from "./backends/local/LocalBackend.js";

import { ExecutionError, WorkerUnavailableError, TaskNotFoundError } from "../contracts/errors.js";
import { newTaskId, newThreadId, newTokenId, sha256Hex, newEffectId } from "../contracts/ids.js";
import type { EventStore } from "./EventStore.js";
import type { ProjectSandboxStore } from "./ProjectSandboxStore.js";
import type { WorkerConnectionRegistry } from "./WorkerConnectionRegistry.js";
import type { EnvironmentProfileService } from "./EnvironmentProfileService.js";
import type { SecretsBroker } from "./SecretsBroker.js";
import type { ConfigBundleStore } from "../config-importer/ConfigBundle.js";
import type { WorkerPathMapper } from "./WorkerPathMapper.js";
import { workerPathMapper } from "./WorkerPathMapper.js";
import { TaskStateMachine } from "./TaskStateMachine.js";

/**
 * Where `t3x worker bundle` output is extracted inside a remote sandbox, and
 * the entry the control plane runs there.
 *
 * The default lives under the sandbox user's home, which is the one path a
 * task is guaranteed to be able to write to; `/workspace` exists on some
 * images and is read-only on others. `--worker-entry-in-sandbox` overrides it.
 */
export const DEFAULT_SANDBOX_WORKER_DIRNAME = ".t3x-worker";
export const DEFAULT_SANDBOX_WORKER_ROOT = `/home/daytona/${DEFAULT_SANDBOX_WORKER_DIRNAME}`;
export const DEFAULT_SANDBOX_WORKER_ENTRY = `${DEFAULT_SANDBOX_WORKER_ROOT}/worker/index.js`;

export interface CreateTaskInput {
  profileId: string;
  /**
   * The repository the task works on. Optional: a client with no repository (a
   * scratch thread) omits it, and the task gets an empty workspace root. It is
   * bound into SQLite, so it is normalized rather than left undefined.
   */
  repositoryUrl?: string;
  branch?: string;
  /**
   * The agent to run. Optional: omitted means the profile's own default
   * (`agents.defaults.provider`), then the first agent the profile allows.
   */
  provider?: string;
  providerInstanceId?: string;
  model?: string;
  permissionMode?: "supervised" | "auto";
  taskOverrides?: Record<string, unknown>;
  projectPatch?: Record<string, unknown>;
  budgetCents?: number | null;
  /**
   * Sandbox scope for this task. Omitted means "inherit the project default,
   * then the global default" — the resolver decides once, at creation.
   */
  scope?: SandboxScope;
  /** Existing project to attach to; otherwise derived from the repository. */
  projectId?: string;
  projectName?: string;
  /**
   * The client's own thread identity for this task.
   *
   * T3 passes its app thread id, so that a restarted client can find the task
   * again by thread instead of provisioning a second sandbox for a
   * conversation that already has one. Omitted means the control plane mints
   * an id; a thread that already has a task is refused rather than duplicated.
   */
  threadId?: string;
}

export interface WorkerLauncher {
  launch(input: {
    taskId: string;
    sandboxId: string;
    command: string;
    env: Record<string, string>;
    cwd: string;
  }): Promise<void>;
  /** Test hook: terminate a launched worker. */
  terminate?(taskId: string): void;
}

export interface SandboxControlPlaneDeps {
  store: EventStore;
  backend: SandboxBackend;
  registry: WorkerConnectionRegistry;
  profiles: EnvironmentProfileService;
  secrets: SecretsBroker;
  bundles: ConfigBundleStore;
  projects: ProjectSandboxStore;
  stateDir: string;
  /** http:// URL of the control plane's /worker endpoint. */
  workerUrl: string;
  /** Entry script of the execution worker, e.g. dist/src/worker/index.js. */
  workerEntry: string;
  /**
   * Tarball of the worker (entry + production dependencies), produced by
   * `t3x worker bundle`. Remote backends have no access to the control
   * plane's filesystem, so the worker has to be shipped into the sandbox;
   * with this set, every remote sandbox gets it extracted before launch and
   * `workerEntryInSandbox` becomes the entry that is executed.
   */
  workerBundle?: string;
  /** Where the bundle is extracted inside a remote sandbox. */
  workerEntryInSandbox?: string;
  launcher?: WorkerLauncher;
  workerAttachTimeoutMs?: number;
  /** Global default scope when neither the task nor the project sets one. */
  globalDefaultScope?: SandboxScope;
}

export class SandboxControlPlane implements SandboxControlPlanePort {
  private readonly store: EventStore;
  private readonly backend: SandboxBackend;
  private readonly registry: WorkerConnectionRegistry;
  private readonly profiles: EnvironmentProfileService;
  private readonly secrets: SecretsBroker;
  private readonly bundles: ConfigBundleStore;
  private readonly projects: ProjectSandboxStore;
  private readonly stateDir: string;
  private readonly workerEntry: string;
  private readonly workerBundle: string | null;
  private readonly workerEntryInSandbox: string;
  private readonly workerEntryInSandboxExplicit: boolean;
  private readonly launcher: WorkerLauncher;
  private readonly workerAttachTimeoutMs: number;
  private readonly paths: WorkerPathMapper;
  private readonly globalDefaultScope: SandboxScope;
  /** Rebound to the actually bound port when the server listens on port 0. */
  workerUrl: string;

  constructor(deps: SandboxControlPlaneDeps) {
    this.store = deps.store;
    this.backend = deps.backend;
    this.registry = deps.registry;
    this.profiles = deps.profiles;
    this.secrets = deps.secrets;
    this.bundles = deps.bundles;
    this.projects = deps.projects;
    this.stateDir = deps.stateDir;
    this.workerUrl = deps.workerUrl;
    this.workerEntry = deps.workerEntry;
    this.workerBundle = deps.workerBundle ?? null;
    this.workerEntryInSandbox = deps.workerEntryInSandbox ?? DEFAULT_SANDBOX_WORKER_ENTRY;
    this.workerEntryInSandboxExplicit = deps.workerEntryInSandbox !== undefined;
    this.paths = workerPathMapper(deps.backend);
    this.globalDefaultScope = deps.globalDefaultScope ?? DEFAULT_SANDBOX_SCOPE;
    this.launcher =
      deps.launcher ??
      (deps.backend.kind === "opensandbox"
        ? new SandboxWorkerLauncher(deps.backend)
        : new ProcessWorkerLauncher());
    this.workerAttachTimeoutMs = deps.workerAttachTimeoutMs ?? 30_000;
  }

  private states(): TaskStateMachine {
    return new TaskStateMachine(this.store);
  }

  // -- credential issuance -------------------------------------------------

  /**
   * Mint a short-lived, sandbox-scoped, single-use connection credential. With
   * shared sandboxes the token names the sandbox and one of its tasks; the
   * registry accepts it for any task bound to that sandbox.
   */
  issueWorkerToken(taskId: string, sandboxId: string, ttlMs = 24 * 60 * 60_000): string {
    const tokenId = newTokenId();
    const secret = sha256Hex(`${tokenId}:${Math.random()}:${Date.now()}`).slice(0, 32);
    this.store.issueWorkerToken({
      tokenId,
      tokenHash: sha256Hex(secret),
      taskId,
      sandboxId,
      expiresAt: Date.now() + ttlMs,
    });
    return `${tokenId}.${secret}`;
  }

  // -- task creation -------------------------------------------------------

  createTask(input: CreateTaskInput): TaskRecord {
    // Normalize before anything is resolved or written: `undefined` reaches
    // SQLite as a bind error ("cannot be bound to SQLite parameter"), not as a
    // default, and both of these are genuinely optional at the API boundary.
    const repositoryUrl = input.repositoryUrl ?? "";
    const resolved = this.profiles.resolveForTask({
      profileId: input.profileId,
      repositoryUrl,
      ...(input.projectPatch
        ? { projectPatch: input.projectPatch as never, projectName: "project" }
        : {}),
      ...(input.taskOverrides ? { taskOverrides: input.taskOverrides as never } : {}),
    });
    const provider =
      input.provider ??
      resolved.body.agents.defaults.provider ??
      resolved.body.agents.allowed[0] ??
      "echo";

    // Scope is decided once, here, so a later change of any default cannot
    // migrate a task that is already running.
    const knownProject =
      (input.projectId ? this.projects.getProject(input.projectId) : null) ??
      this.projects.findProjectByRepository(repositoryUrl);
    const resolution = resolveSandboxScope({
      requested: input.scope,
      project: knownProject,
      profile: resolved,
      repositoryUrl,
      globalDefault: this.globalDefaultScope,
    });

    let projectId: string | null = null;
    if (resolution.scope === "project") {
      const project = this.projects.upsertProject({
        ...(knownProject ? { projectId: knownProject.projectId } : {}),
        ...(input.projectName ? { name: input.projectName } : {}),
        repositoryUrl,
        environmentProfileId: knownProject?.environmentProfileId ?? input.profileId,
      });
      projectId = project.projectId;
    }

    const taskId = newTaskId();
    const threadId = input.threadId ?? newThreadId();
    if (
      input.threadId !== undefined &&
      this.store.listTasks().some((candidate) => candidate.threadId === input.threadId)
    ) {
      throw new ExecutionError(
        "idempotency_conflict",
        `A task already exists for thread ${input.threadId}`,
        { threadId: input.threadId },
      );
    }
    const now = Date.now();
    const record: TaskRecord = {
      taskId,
      threadId,
      state: "pending",
      resumeKind: "fresh",
      sandboxScope: resolution.scope,
      projectId,
      profileId: input.profileId,
      profileDigest: resolved.digest,
      profile: resolved,
      provider,
      providerInstanceId: input.providerInstanceId ?? `${provider}-default`,
      model: input.model ?? "default",
      permissionMode:
        input.permissionMode ?? resolved.body.agents.defaults.permissionMode ?? "supervised",
      executionTarget: { kind: "local" },
      sandboxId: null,
      workspaceRoot: resolved.body.project.workingDirectory,
      worktreePath: "",
      worktreeBranch: "",
      repositoryUrl,
      branch: input.branch ?? "main",
      leaseEpoch: 0,
      lastEventSequence: 0,
      createdAt: now,
      updatedAt: now,
      idleSince: null,
      completedAt: null,
      budgetCents: input.budgetCents ?? null,
      spentCents: 0,
    };

    this.store.insertTask(record);
    this.store.submitCommand({
      commandId: `create_${taskId}`,
      taskId,
      kind: "task.create",
      payload: {
        profileId: input.profileId,
        repositoryUrl,
        scope: resolution.scope,
        projectId,
      },
      events: [
        {
          type: "task.created",
          payload: {
            taskId,
            threadId,
            profileDigest: resolved.digest,
            provider: record.provider,
            providerInstanceId: record.providerInstanceId,
            model: record.model,
            executionTarget: "sandbox",
            sandboxScope: resolution.scope,
            scopeReason: resolution.reason,
            projectId,
            compatibilityKey: resolution.compatibilityKey,
            warnings: resolved.warnings,
          },
        },
      ],
      effects: [
        {
          effectId: `provision_${taskId}`,
          kind: "task.provision",
          payload: { taskId },
          leaseEpoch: 0,
        },
      ],
    });
    return record;
  }

  /**
   * Fork a task's provider thread into a new task in the same project.
   *
   * The fork carries the *conversation*: the new task's worktree is based on
   * the source's branch head, so committed work comes with it, and the agent
   * starts from the source thread's messages. Uncommitted work does not travel
   * — a worktree belongs to one task, and two agents must not write the same
   * files — which a client should say out loud rather than imply otherwise.
   *
   * The source has to be project-scoped: a dedicated sandbox keeps its
   * conversation inside a worker no other task can reach, so there is nothing
   * to fork from.
   */
  forkTask(input: { sourceTaskId: string; threadId: string }): TaskRecord {
    const source = this.store.requireTask(input.sourceTaskId);
    if (source.sandboxScope !== "project" || !source.projectId) {
      throw new ExecutionError(
        "capability_unsupported",
        `Task ${source.taskId} runs in a sandbox of its own; its provider thread cannot be forked. Run the source task in the project's shared sandbox first.`,
        { taskId: source.taskId, sandboxScope: source.sandboxScope },
      );
    }

    const forked = this.createTask({
      profileId: source.profileId,
      repositoryUrl: source.repositoryUrl,
      branch: source.worktreeBranch || source.branch,
      provider: source.provider,
      providerInstanceId: source.providerInstanceId,
      model: source.model,
      permissionMode: source.permissionMode,
      scope: "project",
      projectId: source.projectId,
      threadId: input.threadId,
    });

    // A source thread that never ran a turn has no native conversation yet;
    // the new task then simply starts empty, which is what ensuring a thread
    // would have produced anyway.
    const sourceProviderThreadId = this.providerThreadIdOf(source.taskId);
    const effects: Array<Record<string, unknown>> = [
      {
        effectId: newEffectId(),
        kind: "task.ensure_ready",
        payload: { taskId: forked.taskId },
        leaseEpoch: forked.leaseEpoch,
      },
    ];
    if (sourceProviderThreadId) {
      effects.push({
        effectId: newEffectId(),
        kind: "provider.thread.fork",
        payload: {
          taskId: forked.taskId,
          threadId: forked.threadId,
          providerThreadId: sourceProviderThreadId,
        },
        leaseEpoch: forked.leaseEpoch,
      });
    }

    this.store.submitCommand({
      commandId: `fork_${forked.taskId}`,
      taskId: forked.taskId,
      kind: "task.fork",
      payload: { sourceTaskId: source.taskId },
      events: [
        {
          type: "task.forked",
          payload: {
            taskId: forked.taskId,
            threadId: forked.threadId,
            forkedFromTaskId: source.taskId,
            forkedFromThreadId: sourceProviderThreadId,
            baseBranch: forked.branch,
          },
        },
      ],
      effects: effects as never,
    });
    return forked;
  }

  /**
   * The native provider thread a task's conversation lives in, as the worker
   * last reported it. `null` before the task's first turn.
   */
  providerThreadIdOf(taskId: string): string | null {
    let providerThreadId: string | null = null;
    for (const event of this.store.eventsSince(taskId, 0, 10_000)) {
      const thread = event.payload.providerThread as Record<string, unknown> | undefined;
      if (event.type === "thread.updated" && typeof thread?.providerThreadId === "string") {
        providerThreadId = thread.providerThreadId;
      }
    }
    return providerThreadId;
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Provision the task's sandbox. Idempotent: a task that already has a live
   * sandbox is left alone, so effect retries cannot fork the environment.
   */
  async provision(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);

    if (task.sandboxId) {
      const existing = await this.backend.status(task.sandboxId).catch(() => null);
      if (existing && existing.state !== "deleted") return;
    }

    // A restore already moved the task to `restoring`; provisioning it again
    // must not attempt an illegal `restoring -> provisioning` transition.
    if (this.store.requireTask(taskId).state !== "restoring") {
      this.states().transition(taskId, "provisioning", { reason: "sandbox.create" });
    }

    const current = this.store.requireTask(taskId);
    const profile = current.profile;
    // Credentials are materialized per task, never copied wholesale.
    const secrets = this.secrets.materialize(profile.body.secrets, profile.profileId);
    const resolvedSources = this.bundles.resolveSources(
      profile.body.configuration.sources as never,
      {},
    );
    const spec: SandboxSpec = {
      taskId,
      // "" means "build from the deployment's default image".
      snapshot: profile.body.runtime.snapshot ?? "",
      platform: profile.body.runtime.platform,
      resources: {
        cpu: profile.body.runtime.resources.cpu,
        memoryGiB: profile.body.runtime.resources.memoryGiB,
        diskGiB: profile.body.runtime.resources.diskGiB,
      },
      env: { ...profile.body.environment, ...resolvedSources.env },
      setup: profile.body.project.setup,
      workingDirectory: profile.body.project.workingDirectory,
      ...(current.repositoryUrl
        ? { repository: { url: current.repositoryUrl, branch: current.branch } }
        : {}),
      secrets: secrets.map((s) => ({
        name: s.name,
        value: s.value,
        inject: s.inject,
        hostAllowlist: s.hostAllowlist,
      })),
      stopAfterIdleMinutes: profile.body.sandbox.stopAfterIdleMinutes,
    };
    const secretNames = secrets.map((s) => s.name);

    if (current.sandboxScope === "project" && current.repositoryUrl.trim() !== "") {
      await this.provisionProjectSandbox(current, spec, resolvedSources, secretNames);
      return;
    }
    await this.provisionDedicatedSandbox(current, spec, resolvedSources, secretNames, null);
  }

  /**
   * Project scope: reuse a compatible sandbox, otherwise create one. The
   * sandbox is created lazily — with the first task that needs it — and every
   * task works in its own worktree inside it.
   */
  private async provisionProjectSandbox(
    task: TaskRecord,
    spec: SandboxSpec,
    resolvedSources: {
      files: Array<{ path: string; content: string; mode?: number }>;
      warnings: string[];
    },
    secretNames: string[],
  ): Promise<void> {
    const project =
      (task.projectId ? this.projects.getProject(task.projectId) : null) ??
      this.projects.upsertProject({
        repositoryUrl: task.repositoryUrl,
        environmentProfileId: task.profileId,
      });
    if (task.projectId !== project.projectId) {
      this.store.updateTask(task.taskId, { projectId: project.projectId });
    }

    const compatibilityKey = sandboxCompatibilityKey({
      profile: task.profile,
      repositoryUrl: task.repositoryUrl,
      secretNames,
    });
    const maxConcurrent = Math.max(
      1,
      Math.min(project.maxConcurrentTasks, task.profile.body.sandbox.maxConcurrentTasks),
    );

    let reusable = this.projects.findReusableSandbox(project.projectId, compatibilityKey);
    if (reusable) {
      const status = await this.backend.status(reusable.sandboxId).catch(() => null);
      if (!status || status.state === "deleted") {
        this.projects.updateSandbox(reusable.sandboxId, { state: "deleted" });
        reusable = null;
      } else if (reusable.taskCount >= maxConcurrent) {
        // The shared sandbox is at its concurrency limit: spill to a dedicated
        // sandbox instead of overloading the shared environment.
        await this.provisionDedicatedSandbox(
          task,
          spec,
          resolvedSources,
          secretNames,
          "concurrency_limit",
        );
        return;
      } else {
        if (status.state === "stopped") await this.backend.start(reusable.sandboxId);
        await this.reuseProjectSandbox(task, reusable);
        return;
      }
    }

    // No sandbox with this compatibility key exists yet. Reuse is only safe
    // when the environment matches, so a task with a different profile,
    // snapshot or credential domain gets a sandbox of its own for that
    // environment rather than being dropped into an incompatible one.
    const otherEnvironments = this.projects
      .listProjectSandboxes(project.projectId)
      .filter(
        (sandbox) => sandbox.state !== "deleted" && sandbox.compatibilityKey !== compatibilityKey,
      );

    await this.createSandbox(task, spec, resolvedSources, secretNames, {
      projectId: project.projectId,
      compatibilityKey,
      shared: true,
      reason: otherEnvironments.length > 0 ? "incompatible_environment" : "shared_project_sandbox",
    });
  }

  /** Attach a task to an existing, compatible project sandbox. */
  private async reuseProjectSandbox(
    task: TaskRecord,
    sandbox: ProjectSandboxRecord,
  ): Promise<void> {
    this.store.updateTask(task.taskId, {
      sandboxId: sandbox.sandboxId,
      workspaceRoot: sandbox.workspaceRoot,
      executionTarget: {
        kind: "sandbox",
        taskId: task.taskId,
        sandboxId: sandbox.sandboxId,
        environmentProfileVersion: `${task.profileId}#${task.profileDigest.slice(0, 12)}`,
      },
    });
    this.store.appendEvents(task.taskId, "task", [
      {
        type: "task.sandbox_reused",
        payload: {
          sandboxId: sandbox.sandboxId,
          projectId: sandbox.projectId,
          scope: "project",
          taskCount: sandbox.taskCount + 1,
          compatibilityKey: sandbox.compatibilityKey,
        },
      },
    ]);
    // Worktrees of long-dead tasks are pruned before a new one is added.
    await this.backend
      .exec(sandbox.sandboxId, "git worktree prune", {
        cwd: sandbox.workspaceRoot,
        timeoutMs: 30_000,
      })
      .catch(() => undefined);
    await this.assignWorkspace(task, sandbox.sandboxId, true);
    this.projects.attachTask({
      taskId: task.taskId,
      sandboxId: sandbox.sandboxId,
      projectId: sandbox.projectId,
      scope: "project",
      worktreePath: this.store.requireTask(task.taskId).worktreePath,
      branch: this.store.requireTask(task.taskId).worktreeBranch,
    });
    this.projects.updateSandbox(sandbox.sandboxId, { lastUsedAt: Date.now() });
    await this.ensureSandboxWorker(sandbox.sandboxId);
    this.states().transition(task.taskId, "ready", { resumeKind: "resumed" });
    this.store.updateTask(task.taskId, { idleSince: Date.now() });
  }

  /** Task scope: a sandbox of its own, never shared. */
  private async provisionDedicatedSandbox(
    task: TaskRecord,
    spec: SandboxSpec,
    resolvedSources: {
      files: Array<{ path: string; content: string; mode?: number }>;
      warnings: string[];
    },
    secretNames: string[],
    forcedBy: SandboxScopeReason | null,
  ): Promise<void> {
    if (forcedBy && task.sandboxScope === "project") {
      // The task asked for (or inherited) the shared sandbox but could not use
      // it. Record the truth: the task runs in a sandbox of its own.
      this.store.updateTask(task.taskId, { sandboxScope: "task" });
      this.store.appendEvents(task.taskId, "task", [
        {
          type: "task.sandbox_scope_overridden",
          payload: { requestedScope: "project", effectiveScope: "task", reason: forcedBy },
        },
      ]);
    }
    await this.createSandbox(task, spec, resolvedSources, secretNames, {
      // A task that opted out (or was pushed out) of its project sandbox still
      // belongs to its project: the sandbox is dedicated, not anonymous.
      projectId: task.projectId ?? null,
      compatibilityKey: null,
      shared: false,
      reason: forcedBy ?? "task_override",
    });
  }

  /** Create the sandbox, clone the repository, assign the workspace and attach. */
  private async createSandbox(
    task: TaskRecord,
    spec: SandboxSpec,
    resolvedSources: {
      files: Array<{ path: string; content: string; mode?: number }>;
      warnings: string[];
    },
    secretNames: string[],
    options: {
      projectId: string | null;
      compatibilityKey: string | null;
      shared: boolean;
      reason: SandboxScopeReason;
    },
  ): Promise<void> {
    const handle = await this.backend.create(spec);
    const projectDir = task.profile.body.project.workingDirectory;

    // A remote sandbox starts empty; the working directory has to exist before
    // anything is cloned into it.
    await this.backend.exec(handle.id, `mkdir -p ${shellQuote(projectDir)}`);

    this.store.db.tx(() => {
      this.store.updateTask(task.taskId, {
        sandboxId: handle.id,
        workspaceRoot: projectDir,
        executionTarget: {
          kind: "sandbox",
          taskId: task.taskId,
          sandboxId: handle.id,
          environmentProfileVersion: `${task.profileId}#${task.profileDigest.slice(0, 12)}`,
        },
      });
      this.store.appendEvents(task.taskId, "task", [
        {
          type: "task.sandbox_created",
          payload: {
            sandboxId: handle.id,
            backend: handle.backend,
            scope: options.shared ? "project" : "task",
            projectId: options.projectId,
            scopeReason: options.reason,
            compatibilityKey: options.compatibilityKey,
            snapshot: task.profile.body.runtime.snapshot ?? null,
            resources: spec.resources,
            secretNames,
          },
        },
      ]);
      // Every sandbox is recorded, project or dedicated: the settings page
      // lists them and the lifecycle routes have to find them.
      this.projects.insertSandbox({
        sandboxId: handle.id,
        projectId: options.projectId,
        backend: handle.backend,
        profileId: task.profileId,
        profileDigest: task.profileDigest,
        compatibilityKey: options.compatibilityKey ?? "",
        // "" when the sandbox is image-backed rather than built from a snapshot.
        snapshot: task.profile.body.runtime.snapshot ?? "",
        repositoryUrl: task.repositoryUrl,
        branch: task.branch,
        workspaceRoot: projectDir,
        state: "running",
        scope: options.shared ? "project" : "task",
        leaseEpoch: 0,
        taskCount: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      });
    });

    if (spec.repository) {
      const clone = await this.backend.exec(
        handle.id,
        `git clone --branch ${shellQuote(task.branch)} ${shellQuote(task.repositoryUrl)} .`,
        { cwd: projectDir, timeoutMs: 300_000 },
      );
      if (clone.exitCode !== 0) {
        throw new ExecutionError(
          "internal",
          `Repository clone failed: ${clone.stderr.slice(-500)}`,
          { taskId: task.taskId, sandboxId: handle.id },
        );
      }
    }

    if (resolvedSources.files.length > 0) {
      await this.backend.writeConfigFiles(handle.id, resolvedSources.files);
      this.store.appendEvents(task.taskId, "task", [
        {
          type: "task.configuration_applied",
          payload: {
            files: resolvedSources.files.map((f) => f.path),
            warnings: resolvedSources.warnings,
          },
        },
      ]);
    }

    await this.assignWorkspace(task, handle.id, options.shared);
    this.projects.attachTask({
      taskId: task.taskId,
      sandboxId: handle.id,
      projectId: options.projectId,
      scope: options.shared ? "project" : "task",
      worktreePath: this.store.requireTask(task.taskId).worktreePath,
      branch: this.store.requireTask(task.taskId).worktreeBranch,
    });

    // Worker authentication: single-use, sandbox-scoped, rotated on each connect.
    await this.ensureSandboxWorker(handle.id);
    this.states().transition(task.taskId, "ready", { resumeKind: "fresh" });
    this.store.updateTask(task.taskId, { idleSince: Date.now() });
  }

  /**
   * Give the task its own working directory: a worktree inside a shared project
   * sandbox, or the sandbox's checkout when the sandbox is its own.
   */
  private async assignWorkspace(
    task: TaskRecord,
    sandboxId: string,
    shared: boolean,
  ): Promise<void> {
    const projectDir = task.profile.body.project.workingDirectory;
    if (!shared) {
      this.store.updateTask(task.taskId, {
        worktreePath: projectDir,
        worktreeBranch: task.branch,
      });
      return;
    }

    const worktreePath = worktreePathFor(projectDir, task.taskId);
    const branch = worktreeBranchFor(task.taskId);
    // The command runs in *backend* space: on the local backend a sandbox path
    // is a directory under the state dir, on Daytona it is the sandbox itself.
    // Only the task record and the events keep the sandbox-absolute path.
    const backendWorktree = this.paths(sandboxId, worktreePath);
    const result = await this.backend.exec(
      sandboxId,
      `mkdir -p ${shellQuote(path.posix.dirname(backendWorktree))} && ` +
        `git worktree add -b ${shellQuote(branch)} ${shellQuote(backendWorktree)} HEAD`,
      { cwd: projectDir, timeoutMs: 180_000 },
    );
    if (result.exitCode !== 0) {
      throw new ExecutionError(
        "internal",
        `Worktree creation failed: ${result.stderr.slice(-500)}`,
        { taskId: task.taskId, sandboxId, worktreePath },
      );
    }
    this.store.updateTask(task.taskId, { worktreePath, worktreeBranch: branch });
    this.store.appendEvents(task.taskId, "task", [
      {
        type: "task.worktree_created",
        payload: { sandboxId, worktreePath, branch, sharedSandbox: true },
      },
    ]);
  }

  /** Best-effort removal of a task's worktree before its sandbox is reused. */
  private async removeWorktree(task: TaskRecord): Promise<void> {
    if (!task.sandboxId || !task.worktreePath) return;
    if (task.worktreePath === task.profile.body.project.workingDirectory) return;
    await this.backend
      .exec(
        task.sandboxId,
        `git worktree remove --force ${shellQuote(this.paths(task.sandboxId, task.worktreePath))} || true`,
        { cwd: task.profile.body.project.workingDirectory, timeoutMs: 60_000 },
      )
      .catch(() => undefined);
  }

  async ensureReady(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (task.state === "ready" && this.registry.isConnected(taskId)) return;
    if (task.state === "suspended") {
      await this.resume(taskId);
      return;
    }
    if (!task.sandboxId) {
      await this.provision(taskId);
      return;
    }
    await this.reattachWorker(taskId);
    this.states().transition(taskId, "ready", { reason: "ensure_ready" });
  }

  /** Re-launch the worker for an existing sandbox (crash / restart path). */
  async reattachWorker(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    const sandboxId = this.registry.sandboxForTask(taskId) ?? task.sandboxId;
    if (!sandboxId) throw new TaskNotFoundError(taskId);
    if (this.registry.isSandboxConnected(sandboxId)) {
      this.rebindTask(taskId, sandboxId);
      return;
    }
    await this.ensureSandboxWorker(sandboxId);
    this.store.appendEvents(taskId, "task", [
      {
        type: "task.worker_reattached",
        payload: {
          sandboxId,
          leaseEpoch: this.store.requireTask(taskId).leaseEpoch,
        },
      },
    ]);
  }

  /** Make sure a task's claim on a live sandbox is recorded (resume path). */
  private rebindTask(taskId: string, sandboxId: string): void {
    const task = this.store.requireTask(taskId);
    if (this.projects.bindingFor(taskId)?.sandboxId === sandboxId) return;
    this.projects.attachTask({
      taskId,
      sandboxId,
      projectId: task.projectId,
      scope: task.sandboxScope,
      worktreePath: task.worktreePath || task.workspaceRoot,
      branch: task.worktreeBranch || task.branch,
    });
  }

  /** Start (or reuse) the single worker that serves a sandbox's tasks. */
  private async ensureSandboxWorker(sandboxId: string): Promise<void> {
    const bindings = this.projects.listBindings(sandboxId);
    const primary =
      bindings[0]?.taskId ?? this.store.listTasks().find((t) => t.sandboxId === sandboxId)?.taskId;
    if (!primary) {
      throw new WorkerUnavailableError(sandboxId, "no task is bound to this sandbox");
    }
    if (this.registry.isSandboxConnected(sandboxId)) return;
    const token = this.issueWorkerToken(primary, sandboxId);
    await this.launchWorker(sandboxId, primary, token);
    try {
      await this.registry.waitForConnection(primary, this.workerAttachTimeoutMs);
    } catch (err) {
      this.store.appendEvents(primary, "task", [
        { type: "task.worker_attach_failed", payload: { message: (err as Error).message } },
      ]);
      throw err;
    }
  }

  /**
   * Build the worker launch for a sandbox and start it. The worker's own root
   * is the sandbox's base checkout; each task's commands name their worktree.
   */
  private async launchWorker(
    sandboxId: string,
    primaryTaskId: string,
    token: string,
  ): Promise<void> {
    const task = this.store.requireTask(primaryTaskId);
    const projectDir = task.profile.body.project.workingDirectory;
    const workdir = this.paths(sandboxId, projectDir);
    // The worker's state lives under the sandbox user's home: it is the one
    // path a remote sandbox is guaranteed to allow writing to.
    const stateDir = this.paths(sandboxId, `${this.backend.homeDir(sandboxId)}/.t3x-state`);

    if (this.backend instanceof LocalBackend) {
      // The worker is spawned with the sandbox's checkout as its cwd, so the
      // directory must exist before spawn (a missing cwd is an ENOENT).
      await fsPromises.mkdir(workdir, { recursive: true });
    }

    const entry = await this.ensureRemoteWorker(sandboxId, workdir);

    const command = [
      "node",
      shellQuote(entry),
      "--worker-url",
      shellQuote(this.workerUrl),
      "--token",
      shellQuote(token),
      "--task-id",
      shellQuote(primaryTaskId),
      "--sandbox-id",
      shellQuote(sandboxId),
      "--workspace-root",
      shellQuote(workdir),
      "--state-dir",
      shellQuote(stateDir),
    ].join(" ");

    await this.launcher.launch({
      taskId: primaryTaskId,
      sandboxId,
      command,
      env: { T3X_TASK_ID: primaryTaskId, T3X_SANDBOX_ID: sandboxId },
      cwd: workdir,
    });
  }

  /**
   * Make sure the worker exists inside a remote sandbox and return the entry
   * to run. The bundle is uploaded once per sandbox (later launches find it
   * already extracted); the local backend runs the control plane's own copy.
   */
  private async ensureRemoteWorker(sandboxId: string, workdir: string): Promise<string> {
    if (!this.workerBundle || this.backend.kind === "local") return this.workerEntry;
    const root = this.workerRootInSandbox(sandboxId);
    const entry = this.workerEntryInSandboxExplicit
      ? this.workerEntryInSandbox
      : `${root}/worker/index.js`;
    const probe = await this.backend.exec(
      sandboxId,
      `test -f ${shellQuote(entry)} && echo present`,
    );
    if (probe.exitCode === 0 && probe.stdout.includes("present")) return entry;

    const tarball = path.join(this.stateDir, "worker-bundle.tgz");
    if (path.resolve(tarball) !== path.resolve(this.workerBundle)) {
      await fsPromises.copyFile(this.workerBundle, tarball);
    }
    const bytes = await fsPromises.readFile(tarball);
    const staged = `${root}/worker-bundle.tgz`;
    try {
      await this.backend.exec(sandboxId, `mkdir -p ${shellQuote(root)}`);
      await this.backend.writeFile(sandboxId, staged, bytes);
      const extract = await this.backend.exec(
        sandboxId,
        `tar -xzf ${shellQuote(staged)} -C ${shellQuote(root)} && rm -f ${shellQuote(staged)}`,
        { cwd: workdir, timeoutMs: 300_000 },
      );
      if (extract.exitCode !== 0) {
        throw new ExecutionError(
          "execution_target_unavailable",
          `Could not unpack the worker bundle in sandbox ${sandboxId}: ${extract.stdout || extract.stderr}`,
          { sandboxId, entry },
        );
      }
    } catch (err) {
      throw new ExecutionError(
        "execution_target_unavailable",
        `Could not install the worker into sandbox ${sandboxId} at ${root}: ${(err as Error).message}. ` +
          "Pass --worker-entry-in-sandbox to choose a writable path.",
        { sandboxId, root, entry },
      );
    }
    return entry;
  }

  /** The directory the bundle is unpacked into, under the sandbox user's home. */
  private workerRootInSandbox(sandboxId: string): string {
    if (this.workerEntryInSandboxExplicit) {
      return path.posix.dirname(path.posix.dirname(this.workerEntryInSandbox));
    }
    return `${this.backend.homeDir(sandboxId)}/${DEFAULT_SANDBOX_WORKER_DIRNAME}`;
  }

  async stop(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (!task.sandboxId) {
      this.states().transition(taskId, "suspended", { reason: "stop_before_provision" });
      return;
    }
    const released = this.projects.releaseTask(taskId);
    const remaining = released?.taskCount ?? 0;
    if (remaining > 0) {
      // Other tasks still need this sandbox: releasing the reference is all
      // that may happen. Infrastructure idleness never decides this.
      this.store.appendEvents(taskId, "task", [
        {
          type: "task.sandbox_retained",
          payload: {
            sandboxId: task.sandboxId,
            taskCount: remaining,
            reason: "other_tasks_still_bound",
          },
        },
      ]);
      this.states().transition(taskId, "suspended", { reason: "stopped_shared" });
      return;
    }
    this.registry.dropSandboxConnection(task.sandboxId, "sandbox stopped");
    await this.backend.stop(task.sandboxId);
    this.projects.updateSandbox(task.sandboxId, { state: "stopped" });
    this.states().transition(taskId, "suspended", { reason: "stopped" });
  }

  async resume(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (!task.sandboxId) {
      await this.provision(taskId);
      return;
    }
    await this.backend.start(task.sandboxId);
    this.projects.updateSandbox(task.sandboxId, { state: "running", lastUsedAt: Date.now() });
    this.rebindTask(taskId, task.sandboxId);
    // Same sandbox, same working files: this is "resume", not "restore".
    this.store.updateTask(taskId, { resumeKind: "resumed" });
    await this.reattachWorker(taskId);
    this.states().transition(taskId, "ready", { resumeKind: "resumed" });
  }

  /**
   * Restore a task whose sandbox is gone: recreate the environment from the
   * pinned profile and the git state, and mark the task `restored` because the
   * provider-native session may not survive.
   */
  async restore(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (task.sandboxId) this.projects.releaseTask(taskId);
    this.states().transition(taskId, "restoring", { reason: "sandbox_lost" });
    this.store.updateTask(taskId, {
      sandboxId: null,
      resumeKind: "restored",
      executionTarget: { kind: "local" },
      worktreePath: "",
      worktreeBranch: "",
    });
    await this.provision(taskId);
    this.store.updateTask(taskId, { resumeKind: "restored" });
  }

  async destroy(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    const binding = this.projects.bindingFor(taskId);
    const sandboxId = task.sandboxId;
    const sandboxRecord = sandboxId ? this.projects.getSandbox(sandboxId) : null;
    // A task may already have released its claim (it was stopped first); the
    // sandbox record still tells us this is a shared project environment.
    const projectSandbox = binding?.scope === "project" || sandboxRecord !== null;

    if (sandboxId && projectSandbox) {
      await this.removeWorktree(task);
      const released = this.projects.releaseTask(taskId);
      const remaining = released?.taskCount ?? this.projects.taskCount(sandboxId);
      if (remaining > 0) {
        // The project sandbox outlives its tasks; only the reference goes.
        this.store.appendEvents(taskId, "task", [
          {
            type: "task.sandbox_retained",
            payload: { sandboxId, taskCount: remaining, reason: "project_sandbox_retained" },
          },
        ]);
      } else {
        this.registry.dropSandboxConnection(sandboxId, "no tasks left");
        // Files are retained: the sandbox is stopped, not deleted. Retention
        // policy decides when the project environment itself goes away.
        await this.backend.stop(sandboxId).catch(() => undefined);
        this.projects.updateSandbox(sandboxId, { state: "stopped", taskCount: 0 });
      }
    } else if (sandboxId) {
      this.projects.releaseTask(taskId);
      this.registry.dropSandboxConnection(sandboxId, "task destroyed");
      await this.backend.destroy(sandboxId).catch(() => undefined);
      this.projects.updateSandbox(sandboxId, { state: "deleted" });
    }

    this.store.updateTask(taskId, {
      sandboxId: null,
      resumeKind: null,
      completedAt: Date.now(),
      worktreePath: "",
      worktreeBranch: "",
    });
    this.states().transition(taskId, "completed", { reason: "destroyed" });
    this.store.appendEvents(taskId, "task", [
      {
        type: "task.sandbox_destroyed",
        payload: { taskId, sandboxId, scope: binding?.scope ?? "task" },
      },
    ]);
  }

  // -- project sandbox lifecycle (reference-counted) -----------------------

  /** Tasks currently bound to a sandbox that still need it. */
  boundTasks(sandboxId: string): TaskRecord[] {
    return this.projects
      .listBindings(sandboxId)
      .map((binding) => this.store.getTask(binding.taskId))
      .filter((task): task is TaskRecord => task !== null);
  }

  /** A sandbox may not stop while any bound task is working. */
  sandboxInUse(sandboxId: string): boolean {
    return this.boundTasks(sandboxId).some(
      (task) =>
        task.state === "running" ||
        task.state === "waiting" ||
        task.state === "provisioning" ||
        task.state === "restoring",
    );
  }

  /**
   * Whether a sandbox may be stopped right now, and why not if it may not.
   *
   * The reference count is the gate: a sandbox with tasks still bound to it is
   * never stopped, whatever the idle timers say. Clients ask this before
   * enqueuing a stop so the answer they show the user is the truth; `stopSandbox`
   * consults it too, so there is exactly one rule.
   */
  stopRefusal(sandboxId: string): { refused: boolean; taskCount: number; reason: string | null } {
    const sandbox = this.projects.getSandbox(sandboxId);
    if (!sandbox) return { refused: true, taskCount: 0, reason: "sandbox_not_found" };
    const taskCount = this.projects.taskCount(sandboxId);
    if (taskCount > 0 || this.sandboxInUse(sandboxId)) {
      return { refused: true, taskCount, reason: "tasks_bound" };
    }
    return { refused: false, taskCount, reason: null };
  }

  /**
   * Record that a stop was refused. A client that is told "no" synchronously
   * (HTTP, CLI) calls this so the sandbox's log still carries the refusal.
   */
  recordStopRefusal(sandboxId: string, requestedBy: string): void {
    this.store.appendEvents(sandboxId, "sandbox", [
      {
        type: "sandbox.stop_refused",
        payload: {
          sandboxId,
          reason: "tasks_bound",
          taskCount: this.projects.taskCount(sandboxId),
          requestedBy,
        },
      },
    ]);
  }

  async stopSandbox(sandboxId: string, reason = "idle"): Promise<boolean> {
    const sandbox = this.projects.getSandbox(sandboxId);
    if (!sandbox) return false;
    // The reference count is the gate: a sandbox with tasks still bound to it
    // is never stopped, whatever the idle timers say.
    if (this.projects.taskCount(sandboxId) > 0 || this.sandboxInUse(sandboxId)) {
      this.recordStopRefusal(sandboxId, reason);
      return false;
    }
    this.registry.dropSandboxConnection(sandboxId, `sandbox stopped: ${reason}`);
    this.launcher.terminate?.(sandboxId);
    await this.backend.stop(sandboxId);
    this.projects.updateSandbox(sandboxId, { state: "stopped" });
    this.store.appendEvents(sandboxId, "sandbox", [
      { type: "sandbox.stopped", payload: { sandboxId, reason, taskCount: sandbox.taskCount } },
    ]);
    return true;
  }

  async destroySandbox(sandboxId: string, reason = "retention"): Promise<boolean> {
    const sandbox = this.projects.getSandbox(sandboxId);
    if (!sandbox) return false;
    if (this.projects.taskCount(sandboxId) > 0) return false;
    this.registry.dropSandboxConnection(sandboxId, `sandbox destroyed: ${reason}`);
    this.launcher.terminate?.(sandboxId);
    await this.backend.destroy(sandboxId).catch(() => undefined);
    this.projects.updateSandbox(sandboxId, { state: "deleted" });
    this.store.appendEvents(sandboxId, "sandbox", [
      { type: "sandbox.destroyed", payload: { sandboxId, reason } },
    ]);
    return true;
  }

  /** Bring persisted state and real sandboxes back into agreement. */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      checked: 0,
      reattached: 0,
      restored: 0,
      stopped: 0,
      destroyedOrphans: 0,
      notes: [],
    };
    this.store.requeueStuckEffects(60_000);

    for (const task of this.store.listTasks()) {
      report.checked += 1;
      if (task.state === "completed" || task.state === "failed") continue;

      const status = task.sandboxId
        ? await this.backend.status(task.sandboxId).catch(() => null)
        : null;

      if (!status || status.state === "deleted") {
        report.notes.push(`${task.taskId}: sandbox missing, restoring from pinned profile`);
        await this.restore(task.taskId).catch((err) => {
          report.notes.push(`${task.taskId}: restore failed: ${(err as Error).message}`);
        });
        report.restored += 1;
        continue;
      }

      if (status.state === "stopped") {
        report.notes.push(`${task.taskId}: sandbox stopped, marking suspended`);
        if (task.state !== "suspended") {
          this.states().transition(task.taskId, "suspended", { reason: "reconcile_stopped" });
        }
        report.stopped += 1;
        continue;
      }

      // A shared sandbox is served by one worker: make sure the task is
      // recorded as bound to it, then check that worker.
      if (task.sandboxId) this.rebindTask(task.taskId, task.sandboxId);
      if (!this.registry.isConnected(task.taskId)) {
        try {
          await this.reattachWorker(task.taskId);
          if (this.store.requireTask(task.taskId).state !== "ready") {
            this.states().transition(task.taskId, "ready", { reason: "reconcile_reattach" });
          }
          report.reattached += 1;
        } catch (err) {
          report.notes.push(`${task.taskId}: reattach failed: ${(err as Error).message}`);
        }
      }
    }

    // Project sandboxes outlive tasks, so they are reconciled on their own.
    for (const sandbox of this.projects.listSandboxes()) {
      if (sandbox.state === "deleted") continue;
      const status = await this.backend.status(sandbox.sandboxId).catch(() => null);
      if (!status || status.state === "deleted") {
        report.notes.push(
          `project sandbox ${sandbox.sandboxId}: missing, marking deleted (tasks restore on demand)`,
        );
        this.projects.updateSandbox(sandbox.sandboxId, { state: "deleted" });
        continue;
      }
      if (status.state === "stopped" && sandbox.state !== "stopped") {
        this.projects.updateSandbox(sandbox.sandboxId, { state: "stopped" });
      }
      if (status.state === "running" && sandbox.state !== "running") {
        this.projects.updateSandbox(sandbox.sandboxId, { state: "running" });
      }
    }

    // Orphan sandboxes: created for tasks this control plane no longer tracks.
    const known = new Set<string>();
    for (const task of this.store.listTasks()) if (task.sandboxId) known.add(task.sandboxId);
    for (const sandbox of this.projects.listSandboxes()) {
      if (sandbox.state !== "deleted") known.add(sandbox.sandboxId);
    }
    for (const sandbox of await this.backend.list()) {
      if (known.has(sandbox.id)) continue;
      report.notes.push(`orphan sandbox ${sandbox.id} destroyed`);
      await this.backend.destroy(sandbox.id).catch(() => undefined);
      report.destroyedOrphans += 1;
    }

    return report;
  }

  requireConnection(taskId: string): void {
    if (!this.registry.isConnected(taskId)) {
      throw new WorkerUnavailableError(taskId, "no worker attached");
    }
  }

  static newEffectId(): string {
    return newEffectId();
  }

  /** Exposed for the HTTP API and the CLI. */
  projectSandboxes(projectId: string): ProjectSandboxRecord[] {
    return this.projects.listProjectSandboxes(projectId);
  }

  get stateDirectory(): string {
    return this.stateDir;
  }

  /** Local (backend-space) path of a sandbox-absolute path, for tests and ops. */
  resolvePath(sandboxId: string, sandboxPath: string): string {
    return this.paths(sandboxId, sandboxPath);
  }

  /**
   * Kill every worker this control plane launched. A worker whose control plane
   * has gone would otherwise keep retrying for `maxDisconnectedMs` (ten
   * minutes) before giving up, holding sandbox resources — and on the local
   * backend, leaking one process per run.
   */
  stopAllWorkers(): void {
    const sandboxIds = new Set<string>();
    for (const sandbox of this.projects.listSandboxes()) sandboxIds.add(sandbox.sandboxId);
    for (const task of this.store.listTasks()) {
      if (task.sandboxId) sandboxIds.add(task.sandboxId);
    }
    for (const sandboxId of sandboxIds) this.launcher.terminate?.(sandboxId);
  }

  backendIsLocal(): boolean {
    return this.backend instanceof LocalBackend;
  }

  localRoot(): string | null {
    return this.backend instanceof LocalBackend ? this.backend.root : null;
  }
}

/**
 * Default launcher: run the worker as a detached child of the control plane
 * (used with the local backend and by tests).
 */
export class ProcessWorkerLauncher implements WorkerLauncher {
  private readonly children = new Map<string, ReturnType<typeof spawn>>();

  async launch(input: {
    taskId: string;
    sandboxId: string;
    command: string;
    env: Record<string, string>;
    cwd: string;
  }): Promise<void> {
    const child = spawn("bash", ["-c", input.command], {
      cwd: input.cwd,
      env: { ...(process.env as Record<string, string>), ...input.env },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Keyed by both: a worker belongs to a sandbox, but callers that only know
    // the task (destroy, stop) must be able to reach it too.
    this.children.set(input.taskId, child);
    this.children.set(input.sandboxId, child);
  }

  terminate(key: string): void {
    const child = this.children.get(key);
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    this.children.delete(key);
  }
}

/**
 * Launcher for sandbox-backed tasks: the worker command is executed *inside*
 * the sandbox, because the worker must live where the repository, provider
 * processes and MCP servers live.
 *
 * A backend that can start a detached command does so (`execDetached`): the
 * OpenSandbox `/command` call is request-scoped, and a `nohup … &` that
 * returns before the process is reparented can be reaped with the call. The
 * shell fallback is kept for backends that only expose a blocking exec.
 */
export class SandboxWorkerLauncher implements WorkerLauncher {
  constructor(private readonly backend: SandboxBackend) {}

  async launch(input: {
    taskId: string;
    sandboxId: string;
    command: string;
    env: Record<string, string>;
    cwd: string;
  }): Promise<void> {
    if (this.backend.execDetached) {
      await this.backend.execDetached(input.sandboxId, input.command, {
        cwd: input.cwd,
        env: input.env,
      });
      return;
    }
    await this.backend.exec(
      input.sandboxId,
      `nohup ${input.command} > /tmp/t3x-worker.log 2>&1 &`,
      { cwd: input.cwd, env: input.env, timeoutMs: 15_000 },
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
