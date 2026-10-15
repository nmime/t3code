/**
 * HTTP client for the t3x control plane.
 *
 * The MCP bridge is a client like the Mac GUI and the phone: it talks to
 * `/tasks`, `/sandboxes` and `/profiles` over JSON with the same bearer token,
 * and never opens the control plane's SQLite. That is what lets one bridge
 * serve a deployed VPS from any agent host — OpenClaw, Codex, Claude Desktop —
 * without living inside the deployment.
 */

/** A control-plane answer that was not 2xx, with its machine-readable code. */
export class ControlPlaneRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(input: { status: number; code: string; message: string; details?: unknown }) {
    super(input.message);
    this.name = "ControlPlaneRequestError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

export interface ControlPlaneClientOptions {
  baseUrl: string;
  token?: string | null;
  /**
   * Per-request timeout. A control-plane call answers in milliseconds; a task's
   * *turn* is waited for by polling, never by one long request, so nothing here
   * needs a generous timeout.
   */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface TaskSummary {
  taskId: string;
  threadId: string;
  state: string;
  provider: string;
  providerInstanceId: string;
  model: string;
  sandboxId: string | null;
  sandboxScope: string;
  workspaceRoot: string;
  worktreePath: string;
  worktreeBranch: string;
  repositoryUrl: string;
  branch: string;
  profileId: string;
  lastEventSequence: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /**
   * Everything `GET /tasks/{id}` returned besides the record: the sandbox, the
   * worker connection, approvals, checkpoints, pending effects.
   */
  detail?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StoredEvent {
  seq: number;
  eventId?: string;
  taskId?: string;
  stream?: string;
  type: string;
  payload: Record<string, unknown>;
  ts?: number;
}

export interface CreateTaskInput {
  profileId: string;
  provider?: string;
  model?: string;
  repositoryUrl?: string;
  branch?: string;
  scope?: "project" | "task";
  projectId?: string;
  threadId?: string;
  permissionMode?: "supervised" | "auto";
}

export class ControlPlaneClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token && options.token.length > 0 ? options.token : null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseJson(text);
      if (!response.ok) {
        const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } })
          ?.error;
        throw new ControlPlaneRequestError({
          status: response.status,
          code: error?.code ?? `http_${response.status}`,
          message: error?.message ?? text.slice(0, 400) ?? `HTTP ${response.status}`,
          details: error?.details,
        });
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof ControlPlaneRequestError) throw error;
      const aborted = controller.signal.aborted;
      throw new ControlPlaneRequestError({
        status: 0,
        code: aborted ? "control_plane_timeout" : "control_plane_unreachable",
        message: aborted
          ? `${method} ${path} timed out after ${this.timeoutMs}ms at ${this.baseUrl}`
          : `${method} ${path} could not reach ${this.baseUrl}: ${
              error instanceof Error ? error.message : String(error)
            }`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // -- reads ----------------------------------------------------------------

  health(): Promise<{ ok: boolean; tasks: number }> {
    return this.request("GET", "/health");
  }

  listProfiles(): Promise<{ profiles: Array<Record<string, unknown>> }> {
    return this.request("GET", "/profiles");
  }

  listProjects(): Promise<{ projects: Array<Record<string, unknown>> }> {
    return this.request("GET", "/projects");
  }

  listSandboxes(): Promise<{ sandboxes: Array<Record<string, unknown>> }> {
    return this.request("GET", "/sandboxes");
  }

  listTasks(): Promise<{ tasks: TaskSummary[] }> {
    return this.request("GET", "/tasks");
  }

  /**
   * One task's record.
   *
   * `GET /tasks/{id}` answers with the task *and* the state around it — the
   * sandbox record, the worker connection, pending approvals and effects — so
   * the record is unwrapped here and the surroundings are kept under `detail`,
   * where `t3_task_get` reports them. An agent needs to know that a task is
   * `waiting` because an approval is pending, not just that it is `waiting`.
   */
  async getTask(taskId: string): Promise<TaskSummary> {
    const payload = await this.request<Record<string, unknown>>(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}`,
    );
    const task = payload?.task;
    if (typeof task !== "object" || task === null) {
      throw new ControlPlaneRequestError({
        status: 200,
        code: "unexpected_response",
        message: `GET /tasks/${taskId} did not answer with a task record`,
      });
    }
    return { ...(task as TaskSummary), detail: payload };
  }

  /** The same answer, raw: sandbox, worker, approvals, checkpoints, effects. */
  getTaskDetail(taskId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  events(
    taskId: string,
    from = 0,
    limit?: number,
  ): Promise<{ events: StoredEvent[]; lastSeq: number }> {
    const query = new URLSearchParams({ from: String(from), stream: "json" });
    if (limit !== undefined) query.set("limit", String(limit));
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}/events?${query.toString()}`);
  }

  gitStatus(taskId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}/git/status`);
  }

  gitDiff(
    taskId: string,
    options: { staged?: boolean; ref?: string } = {},
  ): Promise<{ diff: string }> {
    const query = new URLSearchParams();
    if (options.staged) query.set("staged", "true");
    if (options.ref) query.set("ref", options.ref);
    const suffix = query.toString();
    return this.request(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/git/diff${suffix ? `?${suffix}` : ""}`,
    );
  }

  listFiles(taskId: string, path = "."): Promise<{ entries: Array<Record<string, unknown>> }> {
    return this.request(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(path)}`,
    );
  }

  // -- writes ---------------------------------------------------------------

  createTask(input: CreateTaskInput): Promise<{ task: TaskSummary }> {
    return this.request("POST", "/tasks", input);
  }

  sendMessage(
    taskId: string,
    input: { text: string; model?: string; runtimeMode?: string; interactionMode?: string },
  ): Promise<{ runId: string; effectId: string }> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/messages`, input);
  }

  steer(taskId: string, text: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/steer`, { text });
  }

  interrupt(taskId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/interrupt`, {});
  }

  exec(taskId: string, command: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/exec`, { command });
  }

  stop(taskId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/stop`, {});
  }

  resume(taskId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/resume`, {});
  }

  destroy(taskId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/destroy`, {});
  }

  stopSandbox(sandboxId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/sandboxes/${encodeURIComponent(sandboxId)}/stop`, {});
  }

  destroySandbox(sandboxId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/sandboxes/${encodeURIComponent(sandboxId)}/destroy`, {});
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}
