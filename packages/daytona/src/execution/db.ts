/**
 * SQLite plumbing for the control plane.
 *
 * T3's Orchestration V2 keeps durable state in SQLite on the VPS; this module
 * does the same for the execution system, using node's built-in sqlite so the
 * control plane has no native build step.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export class Database {
  readonly handle: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.handle = new DatabaseSync(file);
    this.handle.exec("PRAGMA journal_mode = WAL;");
    this.handle.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id      TEXT NOT NULL UNIQUE,
        task_id       TEXT NOT NULL,
        stream        TEXT NOT NULL,
        type          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        ts            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_seq ON events (task_id, seq);

      CREATE TABLE IF NOT EXISTS commands (
        command_id    TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        kind          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        status        TEXT NOT NULL,
        result        TEXT,
        ts            INTEGER NOT NULL,
        completed_at  INTEGER
      );

      CREATE TABLE IF NOT EXISTS effects (
        effect_id     TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        kind          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        payload_hash  TEXT NOT NULL,
        status        TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        lease_epoch   INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        result        TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS effects_due ON effects (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id        TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL,
        state          TEXT NOT NULL,
        resume_kind    TEXT,
        profile_id     TEXT NOT NULL,
        profile_digest TEXT NOT NULL,
        profile_json   TEXT NOT NULL,
        provider       TEXT NOT NULL,
        provider_instance TEXT NOT NULL,
        model          TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        execution_target TEXT NOT NULL,
        sandbox_id     TEXT,
        workspace_root TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        branch         TEXT NOT NULL,
        lease_epoch    INTEGER NOT NULL DEFAULT 0,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        budget_cents   INTEGER,
        spent_cents    INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        idle_since     INTEGER,
        completed_at   INTEGER
      );

      CREATE TABLE IF NOT EXISTS approvals (
        request_id   TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        kind         TEXT NOT NULL,
        summary      TEXT NOT NULL,
        detail       TEXT,
        status       TEXT NOT NULL,
        response     TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        profile_id   TEXT NOT NULL,
        version      INTEGER NOT NULL,
        body         TEXT NOT NULL,
        digest       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (profile_id, version)
      );

      CREATE TABLE IF NOT EXISTS worker_tokens (
        token_id     TEXT PRIMARY KEY,
        token_hash   TEXT NOT NULL,
        task_id      TEXT NOT NULL,
        sandbox_id   TEXT NOT NULL,
        expires_at   INTEGER NOT NULL,
        used_at      INTEGER
      );

      CREATE TABLE IF NOT EXISTS secrets (
        name         TEXT PRIMARY KEY,
        ciphertext   TEXT NOT NULL,
        iv           TEXT NOT NULL,
        tag          TEXT NOT NULL,
        policy       TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        label         TEXT,
        digest        TEXT,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (task_id, checkpoint_id)
      );

      -- Project scope: one sandbox per project/repository, shared by its tasks.
      CREATE TABLE IF NOT EXISTS projects (
        project_id            TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        repository_url        TEXT NOT NULL,
        default_scope         TEXT,
        environment_profile_id TEXT,
        max_concurrent_tasks  INTEGER NOT NULL DEFAULT 4,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_sandboxes (
        sandbox_id        TEXT PRIMARY KEY,
        project_id        TEXT,
        backend           TEXT NOT NULL,
        profile_id        TEXT NOT NULL,
        profile_digest    TEXT NOT NULL,
        compatibility_key TEXT NOT NULL,
        snapshot          TEXT NOT NULL,
        repository_url    TEXT NOT NULL,
        branch            TEXT NOT NULL,
        workspace_root    TEXT NOT NULL,
        state             TEXT NOT NULL,
        scope             TEXT NOT NULL DEFAULT 'project',
        lease_epoch       INTEGER NOT NULL DEFAULT 0,
        task_count        INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        last_used_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_sandboxes_reuse
        ON project_sandboxes (project_id, compatibility_key, state);

      -- Reference counting: which tasks currently need a sandbox.
      CREATE TABLE IF NOT EXISTS sandbox_bindings (
        task_id       TEXT PRIMARY KEY,
        sandbox_id    TEXT NOT NULL,
        project_id    TEXT,
        scope         TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch        TEXT NOT NULL,
        attached_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sandbox_bindings_sandbox ON sandbox_bindings (sandbox_id);
    `);

    // Columns added after the first release; SQLite has no IF NOT EXISTS for
    // ALTER TABLE, so add them only when missing.
    this.addColumnIfMissing("tasks", "project_id", "TEXT");
    this.addColumnIfMissing("tasks", "sandbox_scope", "TEXT");
    this.addColumnIfMissing("tasks", "worktree_path", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("tasks", "worktree_branch", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("project_sandboxes", "scope", "TEXT NOT NULL DEFAULT 'project'");
    this.relaxSandboxProjectId();
  }

  /**
   * A dedicated sandbox belongs to no project, so `project_sandboxes.project_id`
   * must be nullable. SQLite cannot drop NOT NULL in place, so a table created
   * before that change is rebuilt.
   */
  private relaxSandboxProjectId(): void {
    const columns = this.handle.prepare("PRAGMA table_info(project_sandboxes)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const projectId = columns.find((c) => c.name === "project_id");
    if (!projectId || projectId.notnull === 0) return;
    this.handle.exec(`
      ALTER TABLE project_sandboxes RENAME TO project_sandboxes_old;
      CREATE TABLE project_sandboxes (
        sandbox_id        TEXT PRIMARY KEY,
        project_id        TEXT,
        backend           TEXT NOT NULL,
        profile_id        TEXT NOT NULL,
        profile_digest    TEXT NOT NULL,
        compatibility_key TEXT NOT NULL,
        snapshot          TEXT NOT NULL,
        repository_url    TEXT NOT NULL,
        branch            TEXT NOT NULL,
        workspace_root    TEXT NOT NULL,
        state             TEXT NOT NULL,
        scope             TEXT NOT NULL DEFAULT 'project',
        lease_epoch       INTEGER NOT NULL DEFAULT 0,
        task_count        INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        last_used_at      INTEGER NOT NULL
      );
      INSERT INTO project_sandboxes (sandbox_id, project_id, backend, profile_id, profile_digest,
                                     compatibility_key, snapshot, repository_url, branch,
                                     workspace_root, state, lease_epoch, task_count, created_at,
                                     last_used_at)
        SELECT sandbox_id, project_id, backend, profile_id, profile_digest, compatibility_key,
               snapshot, repository_url, branch, workspace_root, state, lease_epoch, task_count,
               created_at, last_used_at
          FROM project_sandboxes_old;
      DROP TABLE project_sandboxes_old;
      CREATE INDEX IF NOT EXISTS project_sandboxes_reuse
        ON project_sandboxes (project_id, compatibility_key, state);
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((c) => c.name === column)) return;
    this.handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private depth = 0;

  /**
   * Run `fn` inside an IMMEDIATE transaction; rolls back on throw. Reentrant:
   * an inner call joins the outer transaction instead of starting a second
   * one, so composed operations (task state change + event append) stay atomic.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.handle.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const out = fn();
      this.handle.exec("COMMIT");
      this.depth = 0;
      return out;
    } catch (err) {
      try {
        this.handle.exec("ROLLBACK");
      } catch {
        // transaction already unwound
      }
      this.depth = 0;
      throw err;
    }
  }

  close(): void {
    this.handle.close();
  }
}
