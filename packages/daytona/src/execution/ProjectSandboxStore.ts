/**
 * Project and project-sandbox bookkeeping.
 *
 * Sandboxes are no longer owned by a single task: a project sandbox is shared
 * by the tasks of one project/repository and must stay alive while *any* of
 * them needs it. This store keeps the project policy, the project sandbox
 * registry and the task -> sandbox bindings that make the reference count
 * explicit, so lifecycle decisions never have to guess.
 */

import type {
  ProjectExecutionPolicy,
  ProjectSandboxRecord,
  SandboxScope,
} from "../contracts/sandboxScope.js";
import { projectIdForRepository } from "../contracts/sandboxScope.js";
import type { Database } from "./db.js";

export interface SandboxBinding {
  taskId: string;
  sandboxId: string;
  projectId: string | null;
  scope: SandboxScope;
  worktreePath: string;
  branch: string;
  attachedAt: number;
}

export class ProjectSandboxStore {
  constructor(private readonly db: Database) {}

  // -- projects ------------------------------------------------------------

  upsertProject(input: {
    projectId?: string;
    name?: string;
    repositoryUrl: string;
    defaultScope?: SandboxScope | null;
    environmentProfileId?: string | null;
    maxConcurrentTasks?: number;
  }): ProjectExecutionPolicy {
    const projectId = input.projectId ?? projectIdForRepository(input.repositoryUrl);
    const existing = this.getProject(projectId);
    const now = Date.now();
    const record: ProjectExecutionPolicy = {
      projectId,
      name: input.name ?? existing?.name ?? projectNameFor(input.repositoryUrl),
      repositoryUrl: input.repositoryUrl,
      defaultScope:
        input.defaultScope !== undefined ? input.defaultScope : (existing?.defaultScope ?? null),
      environmentProfileId:
        input.environmentProfileId !== undefined
          ? input.environmentProfileId
          : (existing?.environmentProfileId ?? null),
      maxConcurrentTasks: input.maxConcurrentTasks ?? existing?.maxConcurrentTasks ?? 4,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.handle
      .prepare(
        `INSERT INTO projects (project_id, name, repository_url, default_scope,
                               environment_profile_id, max_concurrent_tasks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           name = excluded.name,
           repository_url = excluded.repository_url,
           default_scope = excluded.default_scope,
           environment_profile_id = excluded.environment_profile_id,
           max_concurrent_tasks = excluded.max_concurrent_tasks,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.projectId,
        record.name,
        record.repositoryUrl,
        record.defaultScope,
        record.environmentProfileId,
        record.maxConcurrentTasks,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  getProject(projectId: string): ProjectExecutionPolicy | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM projects WHERE project_id = ?`)
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? this.rowToProject(row) : null;
  }

  /**
   * A project is identified by its repository. Tasks that name no project but
   * share a repository therefore land in the same project sandbox.
   */
  findProjectByRepository(repositoryUrl: string): ProjectExecutionPolicy | null {
    if (!repositoryUrl) return null;
    const row = this.db.handle
      .prepare(`SELECT * FROM projects WHERE repository_url = ? ORDER BY created_at ASC LIMIT 1`)
      .get(repositoryUrl) as Record<string, unknown> | undefined;
    return row ? this.rowToProject(row) : null;
  }

  listProjects(): ProjectExecutionPolicy[] {
    const rows = this.db.handle
      .prepare(`SELECT * FROM projects ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToProject(row));
  }

  private rowToProject(row: Record<string, unknown>): ProjectExecutionPolicy {
    return {
      projectId: String(row.project_id),
      name: String(row.name),
      repositoryUrl: String(row.repository_url),
      defaultScope: (row.default_scope as SandboxScope | null) ?? null,
      environmentProfileId: row.environment_profile_id ? String(row.environment_profile_id) : null,
      maxConcurrentTasks: Number(row.max_concurrent_tasks),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // -- project sandboxes ---------------------------------------------------

  insertSandbox(record: ProjectSandboxRecord): void {
    this.db.handle
      .prepare(
        `INSERT INTO project_sandboxes (sandbox_id, project_id, backend, profile_id, profile_digest,
                                        compatibility_key, snapshot, repository_url, branch,
                                        workspace_root, state, scope, lease_epoch, task_count,
                                        created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sandbox_id) DO UPDATE SET
           state = excluded.state,
           scope = excluded.scope,
           compatibility_key = excluded.compatibility_key,
           task_count = excluded.task_count,
           last_used_at = excluded.last_used_at`,
      )
      .run(
        record.sandboxId,
        record.projectId,
        record.backend,
        record.profileId,
        record.profileDigest,
        record.compatibilityKey,
        record.snapshot,
        record.repositoryUrl,
        record.branch,
        record.workspaceRoot,
        record.state,
        record.scope,
        record.leaseEpoch,
        record.taskCount,
        record.createdAt,
        record.lastUsedAt,
      );
  }

  updateSandbox(sandboxId: string, patch: Partial<ProjectSandboxRecord>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.leaseEpoch !== undefined) set("lease_epoch", patch.leaseEpoch);
    if (patch.taskCount !== undefined) set("task_count", patch.taskCount);
    if (patch.workspaceRoot !== undefined) set("workspace_root", patch.workspaceRoot);
    if (patch.profileDigest !== undefined) set("profile_digest", patch.profileDigest);
    if (patch.compatibilityKey !== undefined) set("compatibility_key", patch.compatibilityKey);
    if (patch.branch !== undefined) set("branch", patch.branch);
    if (patch.lastUsedAt !== undefined) set("last_used_at", patch.lastUsedAt);
    if (fields.length === 0) return;
    values.push(sandboxId);
    this.db.handle
      .prepare(`UPDATE project_sandboxes SET ${fields.join(", ")} WHERE sandbox_id = ?`)
      .run(...(values as never[]));
  }

  getSandbox(sandboxId: string): ProjectSandboxRecord | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM project_sandboxes WHERE sandbox_id = ?`)
      .get(sandboxId) as Record<string, unknown> | undefined;
    return row ? this.rowToSandbox(row) : null;
  }

  listSandboxes(): ProjectSandboxRecord[] {
    const rows = this.db.handle
      .prepare(`SELECT * FROM project_sandboxes ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSandbox(row));
  }

  listProjectSandboxes(projectId: string): ProjectSandboxRecord[] {
    const rows = this.db.handle
      .prepare(`SELECT * FROM project_sandboxes WHERE project_id = ? ORDER BY created_at ASC`)
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToSandbox(row));
  }

  /**
   * A sandbox may be reused only when it is not deleted and its compatibility
   * key matches exactly — same repository, resolved profile, snapshot, platform
   * and credential trust domain.
   */
  findReusableSandbox(projectId: string, compatibilityKey: string): ProjectSandboxRecord | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM project_sandboxes
          WHERE project_id = ? AND compatibility_key = ? AND state IN ('creating','running','stopped')
          ORDER BY last_used_at DESC LIMIT 1`,
      )
      .get(projectId, compatibilityKey) as Record<string, unknown> | undefined;
    return row ? this.rowToSandbox(row) : null;
  }

  private rowToSandbox(row: Record<string, unknown>): ProjectSandboxRecord {
    return {
      sandboxId: String(row.sandbox_id),
      projectId: row.project_id == null ? null : String(row.project_id),
      backend: String(row.backend) as ProjectSandboxRecord["backend"],
      profileId: String(row.profile_id),
      profileDigest: String(row.profile_digest),
      compatibilityKey: String(row.compatibility_key),
      snapshot: String(row.snapshot),
      repositoryUrl: String(row.repository_url),
      branch: String(row.branch),
      workspaceRoot: String(row.workspace_root),
      state: String(row.state) as ProjectSandboxRecord["state"],
      scope: (row.scope == null ? "project" : String(row.scope)) as ProjectSandboxRecord["scope"],
      leaseEpoch: Number(row.lease_epoch),
      taskCount: Number(row.task_count),
      createdAt: Number(row.created_at),
      lastUsedAt: Number(row.last_used_at),
    };
  }

  // -- reference counting --------------------------------------------------

  attachTask(input: {
    taskId: string;
    sandboxId: string;
    projectId: string | null;
    scope: SandboxScope;
    worktreePath: string;
    branch: string;
  }): void {
    this.db.tx(() => {
      const existing = this.bindingFor(input.taskId);
      if (existing && existing.sandboxId !== input.sandboxId) {
        this.decrement(existing.sandboxId);
      }
      this.db.handle
        .prepare(
          `INSERT INTO sandbox_bindings (task_id, sandbox_id, project_id, scope, worktree_path, branch, attached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             sandbox_id = excluded.sandbox_id,
             project_id = excluded.project_id,
             scope = excluded.scope,
             worktree_path = excluded.worktree_path,
             branch = excluded.branch,
             attached_at = excluded.attached_at`,
        )
        .run(
          input.taskId,
          input.sandboxId,
          input.projectId,
          input.scope,
          input.worktreePath,
          input.branch,
          Date.now(),
        );
      this.recount(input.sandboxId);
    });
  }

  /** Drop a task's claim on its sandbox; returns the remaining reference count. */
  releaseTask(taskId: string): { sandboxId: string; taskCount: number } | null {
    return this.db.tx(() => {
      const binding = this.bindingFor(taskId);
      if (!binding) return null;
      this.db.handle.prepare(`DELETE FROM sandbox_bindings WHERE task_id = ?`).run(taskId);
      const taskCount = this.recount(binding.sandboxId);
      return { sandboxId: binding.sandboxId, taskCount };
    });
  }

  bindingFor(taskId: string): SandboxBinding | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM sandbox_bindings WHERE task_id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      taskId: String(row.task_id),
      sandboxId: String(row.sandbox_id),
      projectId: row.project_id ? String(row.project_id) : null,
      scope: String(row.scope) as SandboxScope,
      worktreePath: String(row.worktree_path),
      branch: String(row.branch),
      attachedAt: Number(row.attached_at),
    };
  }

  listBindings(sandboxId: string): SandboxBinding[] {
    const rows = this.db.handle
      .prepare(`SELECT * FROM sandbox_bindings WHERE sandbox_id = ? ORDER BY attached_at ASC`)
      .all(sandboxId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      taskId: String(row.task_id),
      sandboxId: String(row.sandbox_id),
      projectId: row.project_id ? String(row.project_id) : null,
      scope: String(row.scope) as SandboxScope,
      worktreePath: String(row.worktree_path),
      branch: String(row.branch),
      attachedAt: Number(row.attached_at),
    }));
  }

  /** Sandbox a task is currently bound to, falling back to its own record. */
  sandboxForTask(taskId: string): string | null {
    return this.bindingFor(taskId)?.sandboxId ?? null;
  }

  taskCount(sandboxId: string): number {
    const row = this.db.handle
      .prepare(`SELECT COUNT(*) AS n FROM sandbox_bindings WHERE sandbox_id = ?`)
      .get(sandboxId) as { n: number };
    return Number(row.n);
  }

  private recount(sandboxId: string): number {
    const count = this.taskCount(sandboxId);
    this.db.handle
      .prepare(`UPDATE project_sandboxes SET task_count = ?, last_used_at = ? WHERE sandbox_id = ?`)
      .run(count, Date.now(), sandboxId);
    return count;
  }

  private decrement(sandboxId: string): void {
    this.recount(sandboxId);
  }
}

function projectNameFor(repositoryUrl: string): string {
  const trimmed = repositoryUrl.replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? "";
  return (last.replace(/\.git$/, "") || "project").slice(0, 64);
}
