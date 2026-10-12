/**
 * Event store, command receipts and the durable effect outbox.
 *
 * Every accepted command produces, inside one SQLite transaction:
 *
 *   1. a command receipt (so the client can retry idempotently),
 *   2. the domain events it caused,
 *   3. updated projections (tasks / approvals),
 *   4. the pending effects a worker will execute later.
 *
 * A crash between execution and acknowledgement re-runs the effect, which is
 * safe because commands are idempotent by `effectId` on the worker.
 */

import type {
  TaskRecord,
  TaskExecutionState,
  TaskResumeKind,
} from "../contracts/execution.js";
import type { SandboxScope } from "../contracts/sandboxScope.js";
import type { ResolvedProfile } from "../contracts/environmentProfile.js";
import { IdempotencyConflictError, ExecutionError } from "../contracts/errors.js";
import { newEventId } from "../contracts/ids.js";
import { payloadHash } from "../contracts/workerProtocol.js";
import { Database } from "./db.js";

export interface StoredEvent {
  seq: number;
  eventId: string;
  taskId: string;
  stream: string;
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

export type EffectStatus = "pending" | "running" | "done" | "failed";

export interface EffectRecord {
  effectId: string;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: EffectStatus;
  attempts: number;
  leaseEpoch: number;
  nextAttemptAt: number;
  result: unknown;
  error: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface CommandReceipt {
  commandId: string;
  taskId: string;
  kind: string;
  status: "accepted" | "completed" | "failed";
  result: unknown;
  ts: number;
}

export interface SubmitCommandInput {
  commandId: string;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  events?: Array<{ type: string; payload: Record<string, unknown> }>;
  effects?: Array<{
    effectId: string;
    kind: string;
    payload: Record<string, unknown>;
    leaseEpoch: number;
  }>;
  taskPatch?: Partial<TaskRecord>;
  approval?: {
    requestId: string;
    kind: string;
    summary: string;
    detail?: unknown;
    status: "pending" | "approved" | "rejected" | "cancelled";
  };
}

export class EventStore {
  readonly db: Database;

  constructor(file: string) {
    this.db = new Database(file);
  }

  close(): void {
    this.db.close();
  }

  // -- events --------------------------------------------------------------

  appendEvents(
    taskId: string,
    stream: string,
    events: Array<{
      type: string;
      payload: Record<string, unknown>;
      /** Prescribed identity, e.g. the worker-side event id (for dedupe). */
      eventId?: string;
    }>,
  ): StoredEvent[] {
    return this.db.tx(() => {
      const out: StoredEvent[] = [];
      for (const event of events) {
        const eventId = event.eventId ?? newEventId();
        const ts = Date.now();
        this.db.handle
          .prepare(
            `INSERT INTO events (event_id, task_id, stream, type, payload, ts)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(event_id) DO NOTHING`,
          )
          .run(eventId, taskId, stream, event.type, JSON.stringify(event.payload), ts);
        const row = this.db.handle
          .prepare(`SELECT seq FROM events WHERE event_id = ?`)
          .get(eventId) as { seq: number } | undefined;
        if (!row) continue; // duplicate delivery; already persisted
        out.push({
          seq: row.seq,
          eventId,
          taskId,
          stream,
          type: event.type,
          payload: event.payload,
          ts,
        });
      }
      if (out.length > 0) {
        this.db.handle
          .prepare(`UPDATE tasks SET last_event_seq = ?, updated_at = ? WHERE task_id = ?`)
          .run(out[out.length - 1]!.seq, Date.now(), taskId);
      }
      return out;
    });
  }

  eventsSince(taskId: string, seq: number, limit = 500): StoredEvent[] {
    const rows = this.db.handle
      .prepare(
        `SELECT seq, event_id, task_id, stream, type, payload, ts
           FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(taskId, seq, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      seq: Number(row.seq),
      eventId: String(row.event_id),
      taskId: String(row.task_id),
      stream: String(row.stream),
      type: String(row.type),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      ts: Number(row.ts),
    }));
  }

  lastEventSeq(taskId: string): number {
    const row = this.db.handle
      .prepare(`SELECT MAX(seq) AS seq FROM events WHERE task_id = ?`)
      .get(taskId) as { seq: number | null };
    return row.seq ?? 0;
  }

  // -- commands and effects ------------------------------------------------

  /**
   * The transactional write path: receipt + events + projections + effects in
   * one transaction. Re-submitting the same command id returns the original
   * receipt (idempotent client retries).
   */
  submitCommand(input: SubmitCommandInput): { receipt: CommandReceipt; events: StoredEvent[] } {
    return this.db.tx(() => {
      const existing = this.getCommand(input.commandId);
      if (existing) {
        return { receipt: existing, events: [] };
      }

      const ts = Date.now();
      this.db.handle
        .prepare(
          `INSERT INTO commands (command_id, task_id, kind, payload, status, ts)
           VALUES (?, ?, ?, ?, 'accepted', ?)`,
        )
        .run(input.commandId, input.taskId, input.kind, JSON.stringify(input.payload), ts);

      const stored: StoredEvent[] = [];
      for (const event of input.events ?? []) {
        const eventId = newEventId();
        this.db.handle
          .prepare(
            `INSERT INTO events (event_id, task_id, stream, type, payload, ts)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(eventId, input.taskId, "command", event.type, JSON.stringify(event.payload), ts);
        const row = this.db.handle
          .prepare(`SELECT seq FROM events WHERE event_id = ?`)
          .get(eventId) as { seq: number };
        stored.push({
          seq: row.seq,
          eventId,
          taskId: input.taskId,
          stream: "command",
          type: event.type,
          payload: event.payload,
          ts,
        });
      }

      if (input.taskPatch) this.updateTask(input.taskId, input.taskPatch);

      if (input.approval) {
        this.db.handle
          .prepare(
            `INSERT INTO approvals (request_id, task_id, kind, summary, detail, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(request_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
          )
          .run(
            input.approval.requestId,
            input.taskId,
            input.approval.kind,
            input.approval.summary,
            input.approval.detail === undefined ? null : JSON.stringify(input.approval.detail),
            input.approval.status,
            ts,
            ts,
          );
      }

      for (const effect of input.effects ?? []) {
        this.enqueueEffect({ ...effect, taskId: input.taskId });
      }

      return {
        receipt: {
          commandId: input.commandId,
          taskId: input.taskId,
          kind: input.kind,
          status: "accepted",
          result: null,
          ts,
        },
        events: stored,
      };
    });
  }

  getCommand(commandId: string): CommandReceipt | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM commands WHERE command_id = ?`)
      .get(commandId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      commandId: String(row.command_id),
      taskId: String(row.task_id),
      kind: String(row.kind),
      status: String(row.status) as CommandReceipt["status"],
      result: row.result ? JSON.parse(String(row.result)) : null,
      ts: Number(row.ts),
    };
  }

  completeCommand(commandId: string, status: "completed" | "failed", result: unknown): void {
    this.db.handle
      .prepare(`UPDATE commands SET status = ?, result = ?, completed_at = ? WHERE command_id = ?`)
      .run(status, JSON.stringify(result ?? null), Date.now(), commandId);
  }

  enqueueEffect(input: {
    effectId: string;
    taskId: string;
    kind: string;
    payload: Record<string, unknown>;
    leaseEpoch: number;
    notBefore?: number;
  }): void {
    const now = Date.now();
    const hash = payloadHash({ kind: input.kind, payload: input.payload });
    const existing = this.getEffect(input.effectId);
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new IdempotencyConflictError(
          input.effectId,
          "effect replayed with a different payload",
        );
      }
      return;
    }
    this.db.handle
      .prepare(
        `INSERT INTO effects (effect_id, task_id, kind, payload, payload_hash, status, attempts,
                              lease_epoch, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .run(
        input.effectId,
        input.taskId,
        input.kind,
        JSON.stringify(input.payload),
        hash,
        input.leaseEpoch,
        input.notBefore ?? now,
        now,
        now,
      );
  }

  getEffect(effectId: string): EffectRecord | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM effects WHERE effect_id = ?`)
      .get(effectId) as Record<string, unknown> | undefined;
    return row ? this.rowToEffect(row) : null;
  }

  claimDueEffects(limit = 10): EffectRecord[] {
    const now = Date.now();
    return this.db.tx(() => {
      const rows = this.db.handle
        .prepare(
          `SELECT * FROM effects
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY created_at ASC LIMIT ?`,
        )
        .all(now, limit) as Array<Record<string, unknown>>;
      const claimed: EffectRecord[] = [];
      for (const row of rows) {
        this.db.handle
          .prepare(
            `UPDATE effects SET status = 'running', attempts = attempts + 1, updated_at = ?
              WHERE effect_id = ? AND status = 'pending'`,
          )
          .run(now, String(row.effect_id));
        claimed.push(
          this.rowToEffect({ ...row, status: "running", attempts: Number(row.attempts) + 1 }),
        );
      }
      return claimed;
    });
  }

  completeEffect(effectId: string, result: unknown): void {
    this.db.handle
      .prepare(`UPDATE effects SET status = 'done', result = ?, updated_at = ? WHERE effect_id = ?`)
      .run(JSON.stringify(result ?? null), Date.now(), effectId);
  }

  failEffect(effectId: string, error: unknown, retryInMs: number | null): void {
    const now = Date.now();
    if (retryInMs === null) {
      this.db.handle
        .prepare(`UPDATE effects SET status = 'failed', error = ?, updated_at = ? WHERE effect_id = ?`)
        .run(JSON.stringify(error ?? null), now, effectId);
      return;
    }
    this.db.handle
      .prepare(
        `UPDATE effects SET status = 'pending', error = ?, next_attempt_at = ?, updated_at = ?
          WHERE effect_id = ?`,
      )
      .run(JSON.stringify(error ?? null), now + retryInMs, now, effectId);
  }

  /** Effects stuck in `running` (control plane crashed mid-execution). */
  requeueStuckEffects(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const now = Date.now();
    const result = this.db.handle
      .prepare(
        `UPDATE effects SET status = 'pending', next_attempt_at = ?, updated_at = ?
          WHERE status = 'running' AND updated_at < ?`,
      )
      .run(now, now, cutoff);
    return Number(result.changes ?? 0);
  }

  pendingEffectsForTask(taskId: string): EffectRecord[] {
    const rows = this.db.handle
      .prepare(`SELECT * FROM effects WHERE task_id = ? AND status IN ('pending','running')`)
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEffect(row));
  }

  private rowToEffect(row: Record<string, unknown>): EffectRecord {
    return {
      effectId: String(row.effect_id),
      taskId: String(row.task_id),
      kind: String(row.kind),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      payloadHash: String(row.payload_hash),
      status: String(row.status) as EffectStatus,
      attempts: Number(row.attempts),
      leaseEpoch: Number(row.lease_epoch),
      nextAttemptAt: Number(row.next_attempt_at),
      result: row.result ? JSON.parse(String(row.result)) : null,
      error: row.error ? JSON.parse(String(row.error)) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // -- task projections ----------------------------------------------------

  insertTask(record: TaskRecord): void {
    this.db.handle
      .prepare(
        `INSERT INTO tasks (task_id, thread_id, state, resume_kind, profile_id, profile_digest,
                            profile_json, provider, provider_instance, model, permission_mode,
                            execution_target, sandbox_id, workspace_root, repository_url, branch,
                            lease_epoch, last_event_seq, budget_cents, spent_cents,
                            created_at, updated_at, idle_since, completed_at,
                            project_id, sandbox_scope, worktree_path, worktree_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.taskId,
        record.threadId,
        record.state,
        record.resumeKind,
        record.profileId,
        record.profileDigest,
        JSON.stringify(record.profile),
        record.provider,
        record.providerInstanceId,
        record.model,
        record.permissionMode,
        JSON.stringify(record.executionTarget),
        record.sandboxId,
        record.workspaceRoot,
        record.repositoryUrl,
        record.branch,
        record.leaseEpoch,
        record.lastEventSequence,
        record.budgetCents,
        record.spentCents,
        record.createdAt,
        record.updatedAt,
        record.idleSince,
        record.completedAt,
        record.projectId,
        record.sandboxScope,
        record.worktreePath,
        record.worktreeBranch,
      );
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.resumeKind !== undefined) set("resume_kind", patch.resumeKind);
    if (patch.sandboxId !== undefined) set("sandbox_id", patch.sandboxId);
    if (patch.workspaceRoot !== undefined) set("workspace_root", patch.workspaceRoot);
    if (patch.executionTarget !== undefined)
      set("execution_target", JSON.stringify(patch.executionTarget));
    if (patch.leaseEpoch !== undefined) set("lease_epoch", patch.leaseEpoch);
    if (patch.lastEventSequence !== undefined) set("last_event_seq", patch.lastEventSequence);
    if (patch.profile !== undefined) set("profile_json", JSON.stringify(patch.profile));
    if (patch.provider !== undefined) set("provider", patch.provider);
    if (patch.providerInstanceId !== undefined) set("provider_instance", patch.providerInstanceId);
    if (patch.model !== undefined) set("model", patch.model);
    if (patch.permissionMode !== undefined) set("permission_mode", patch.permissionMode);
    if (patch.branch !== undefined) set("branch", patch.branch);
    if (patch.repositoryUrl !== undefined) set("repository_url", patch.repositoryUrl);
    if (patch.idleSince !== undefined) set("idle_since", patch.idleSince);
    if (patch.completedAt !== undefined) set("completed_at", patch.completedAt);
    if (patch.spentCents !== undefined) set("spent_cents", patch.spentCents);
    if (patch.projectId !== undefined) set("project_id", patch.projectId);
    if (patch.sandboxScope !== undefined) set("sandbox_scope", patch.sandboxScope);
    if (patch.worktreePath !== undefined) set("worktree_path", patch.worktreePath);
    if (patch.worktreeBranch !== undefined) set("worktree_branch", patch.worktreeBranch);
    if (fields.length === 0) return;
    set("updated_at", Date.now());
    values.push(taskId);
    this.db.handle
      .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE task_id = ?`)
      .run(...(values as never[]));
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db.handle
      .prepare(`SELECT * FROM tasks ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTask(row));
  }

  private rowToTask(row: Record<string, unknown>): TaskRecord {
    return {
      taskId: String(row.task_id),
      threadId: String(row.thread_id),
      state: String(row.state) as TaskExecutionState,
      resumeKind: (row.resume_kind as TaskResumeKind) ?? null,
      profileId: String(row.profile_id),
      profileDigest: String(row.profile_digest),
      profile: JSON.parse(String(row.profile_json)) as ResolvedProfile,
      provider: String(row.provider),
      providerInstanceId: String(row.provider_instance),
      model: String(row.model),
      permissionMode: String(row.permission_mode) as "supervised" | "auto",
      executionTarget: JSON.parse(String(row.execution_target)),
      sandboxId: row.sandbox_id ? String(row.sandbox_id) : null,
      workspaceRoot: String(row.workspace_root),
      worktreePath: row.worktree_path ? String(row.worktree_path) : "",
      worktreeBranch: row.worktree_branch ? String(row.worktree_branch) : "",
      projectId: row.project_id ? String(row.project_id) : null,
      sandboxScope: (row.sandbox_scope as SandboxScope | null) ?? "task",
      repositoryUrl: String(row.repository_url),
      branch: String(row.branch),
      leaseEpoch: Number(row.lease_epoch),
      lastEventSequence: Number(row.last_event_seq),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      idleSince: row.idle_since === null ? null : Number(row.idle_since),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      budgetCents: row.budget_cents === null ? null : Number(row.budget_cents),
      spentCents: Number(row.spent_cents),
    };
  }

  // -- approvals -----------------------------------------------------------

  recordApproval(input: {
    requestId: string;
    taskId: string;
    kind: string;
    summary: string;
    detail?: unknown;
    status: "pending" | "approved" | "rejected" | "cancelled";
  }): void {
    const now = Date.now();
    this.db.handle
      .prepare(
        `INSERT INTO approvals (request_id, task_id, kind, summary, detail, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(
        input.requestId,
        input.taskId,
        input.kind,
        input.summary,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        input.status,
        now,
        now,
      );
  }

  resolveApproval(
    requestId: string,
    status: "approved" | "rejected" | "cancelled",
    response: unknown,
  ): void {
    this.db.handle
      .prepare(`UPDATE approvals SET status = ?, response = ?, updated_at = ? WHERE request_id = ?`)
      .run(status, JSON.stringify(response ?? null), Date.now(), requestId);
  }

  getApproval(requestId: string): {
    requestId: string;
    taskId: string;
    kind: string;
    summary: string;
    detail: unknown;
    status: string;
    response: unknown;
  } | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM approvals WHERE request_id = ?`)
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      requestId: String(row.request_id),
      taskId: String(row.task_id),
      kind: String(row.kind),
      summary: String(row.summary),
      detail: row.detail ? JSON.parse(String(row.detail)) : null,
      status: String(row.status),
      response: row.response ? JSON.parse(String(row.response)) : null,
    };
  }

  listApprovals(taskId: string): Array<Record<string, unknown>> {
    const rows = this.db.handle
      .prepare(`SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      requestId: String(row.request_id),
      kind: String(row.kind),
      summary: String(row.summary),
      status: String(row.status),
      response: row.response ? JSON.parse(String(row.response)) : null,
    }));
  }

  // -- profiles ------------------------------------------------------------

  saveProfile(profileId: string, version: number, body: unknown, digest: string): void {
    this.db.handle
      .prepare(
        `INSERT INTO profiles (profile_id, version, body, digest, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, version) DO UPDATE SET body = excluded.body, digest = excluded.digest`,
      )
      .run(profileId, version, JSON.stringify(body), digest, Date.now());
  }

  getProfile(profileId: string, version?: number): { body: unknown; digest: string } | null {
    const row = (
      version === undefined
        ? this.db.handle
            .prepare(
              `SELECT body, digest FROM profiles WHERE profile_id = ? ORDER BY version DESC LIMIT 1`,
            )
            .get(profileId)
        : this.db.handle
            .prepare(`SELECT body, digest FROM profiles WHERE profile_id = ? AND version = ?`)
            .get(profileId, version)
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { body: JSON.parse(String(row.body)), digest: String(row.digest) };
  }

  listProfiles(): Array<{ profileId: string; version: number; digest: string }> {
    const rows = this.db.handle
      .prepare(`SELECT profile_id, version, digest FROM profiles ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      profileId: String(row.profile_id),
      version: Number(row.version),
      digest: String(row.digest),
    }));
  }

  // -- worker tokens (short-lived, task-scoped) ----------------------------

  issueWorkerToken(input: {
    tokenId: string;
    tokenHash: string;
    taskId: string;
    sandboxId: string;
    expiresAt: number;
  }): void {
    this.db.handle
      .prepare(
        `INSERT INTO worker_tokens (token_id, token_hash, task_id, sandbox_id, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(input.tokenId, input.tokenHash, input.taskId, input.sandboxId, input.expiresAt);
  }

  /** Single-use consumption: the token is marked used at most once. */
  consumeWorkerToken(
    tokenId: string,
    tokenHash: string,
  ): { taskId: string; sandboxId: string } | null {
    return this.db.tx(() => {
      const row = this.db.handle
        .prepare(`SELECT * FROM worker_tokens WHERE token_id = ?`)
        .get(tokenId) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (String(row.token_hash) !== tokenHash) return null;
      if (row.used_at !== null) return null;
      if (Number(row.expires_at) < Date.now()) return null;
      this.db.handle
        .prepare(`UPDATE worker_tokens SET used_at = ? WHERE token_id = ?`)
        .run(Date.now(), tokenId);
      return { taskId: String(row.task_id), sandboxId: String(row.sandbox_id) };
    });
  }

  // -- checkpoints ---------------------------------------------------------

  recordCheckpoint(
    taskId: string,
    checkpointId: string,
    label: string | undefined,
    digest: string,
  ): void {
    this.db.handle
      .prepare(
        `INSERT INTO checkpoints (checkpoint_id, task_id, label, digest, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, checkpoint_id) DO UPDATE SET digest = excluded.digest`,
      )
      .run(checkpointId, taskId, label ?? null, digest, Date.now());
  }

  listCheckpoints(taskId: string): Array<{ checkpointId: string; label: string | null }> {
    const rows = this.db.handle
      .prepare(
        `SELECT checkpoint_id, label FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      checkpointId: String(row.checkpoint_id),
      label: row.label === null ? null : String(row.label),
    }));
  }

  // -- secrets (ciphertext only; see SecretsBroker) ------------------------

  putSecretCipher(
    name: string,
    cipher: { ciphertext: string; iv: string; tag: string },
    policy: unknown,
  ): void {
    this.db.handle
      .prepare(
        `INSERT INTO secrets (name, ciphertext, iv, tag, policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
                                          tag = excluded.tag, policy = excluded.policy`,
      )
      .run(
        name,
        cipher.ciphertext,
        cipher.iv,
        cipher.tag,
        JSON.stringify(policy ?? {}),
        Date.now(),
      );
  }

  getSecretCipher(name: string): {
    ciphertext: string;
    iv: string;
    tag: string;
    policy: unknown;
  } | null {
    const row = this.db.handle
      .prepare(`SELECT * FROM secrets WHERE name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ciphertext: String(row.ciphertext),
      iv: String(row.iv),
      tag: String(row.tag),
      policy: JSON.parse(String(row.policy)),
    };
  }

  listSecretNames(): string[] {
    const rows = this.db.handle.prepare(`SELECT name FROM secrets`).all() as Array<{
      name: string;
    }>;
    return rows.map((row) => String(row.name));
  }

  // -- helpers -------------------------------------------------------------

  requireTask(taskId: string): TaskRecord {
    const record = this.getTask(taskId);
    if (!record) {
      throw new ExecutionError("task_not_found", `Task ${taskId} does not exist.`, { taskId });
    }
    return record;
  }
}
