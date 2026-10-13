/**
 * Client for a `@t3tools/t3x` control plane.
 *
 * This is the whole surface the provider driver needs: tasks (one per T3
 * thread), the provider-side snapshot a client resumes from, turn control,
 * approvals, checkpoints and the event stream. Nothing here knows about
 * OpenSandbox itself — the control plane owns sandboxes; this side only asks for
 * work to be done in one.
 */
import { normalizeControlPlaneUrl } from "./config.ts";

export interface OpenSandboxTask {
  taskId: string;
  threadId: string;
  state: string;
  provider: string;
  model: string;
  sandboxId: string | null;
  sandboxScope: string;
  projectId: string | null;
  worktreePath: string;
  worktreeBranch: string;
  repositoryUrl: string;
  branch: string;
}

export interface OpenSandboxTurn {
  providerTurnId: string;
  runId?: string;
  status?: string;
  runOrdinal?: number;
  completedAt?: number;
}

export interface OpenSandboxMessage {
  messageId: string;
  role: string;
  text: string;
  runId?: string;
  seq?: number;
  streaming?: boolean;
  /** Epoch milliseconds of the event that first carried this message. */
  createdAt?: number;
}

export interface OpenSandboxRuntimeRequest {
  requestId: string;
  kind?: string;
  summary?: string;
  detail?: { prompt?: string };
  status?: string;
  /** Epoch milliseconds of the event that first carried this request. */
  createdAt?: number;
  /** Epoch milliseconds of the event that resolved it, when it is resolved. */
  resolvedAt?: number;
}

export interface OpenSandboxProviderInventory {
  driver: string;
  version?: string;
  capabilities: Record<string, boolean>;
}

export interface OpenSandboxSnapshot {
  /** The strongest runtime mode the task's pinned profile permits. */
  runtimeModeCap?: string;
  taskId: string;
  state: string;
  threadId: string;
  providerThreadId: string | null;
  providerSessionId: string | null;
  title: string | null;
  driver: string;
  model: string;
  permissionMode: string;
  lastSeq: number;
  turns: OpenSandboxTurn[];
  messages: OpenSandboxMessage[];
  runtimeRequests: OpenSandboxRuntimeRequest[];
  approvals: Array<{ requestId: string; status: string; decision?: string }>;
  checkpoints: Array<{ checkpointId: string; label: string | null }>;
  capabilities: OpenSandboxProviderInventory[];
  worker: { connected: boolean; providers?: OpenSandboxProviderInventory[] } | null;
}

export interface OpenSandboxEvent {
  seq: number;
  eventId: string;
  taskId: string;
  stream: string;
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

/** One environment profile the control plane can provision a sandbox from. */
export interface OpenSandboxProfile {
  profileId: string;
  version: number;
  digest: string;
}

export interface OpenSandboxTaskStatus {
  task: OpenSandboxTask;
  sandboxScope: string;
  projectId: string | null;
  worktreePath: string;
  worktreeBranch: string;
  worker: { connected: boolean } | null;
  approvals: Array<{ requestId: string; status: string }>;
  checkpoints: Array<{ checkpointId: string; label: string | null }>;
}

export interface CreateTaskInput {
  profileId: string;
  repositoryUrl?: string;
  branch?: string;
  provider?: string;
  model?: string;
  scope?: "project" | "task";
  projectId?: string;
  threadId?: string;
}

export class OpenSandboxControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OpenSandboxControlPlaneError";
    this.status = status;
    this.code = code;
  }
}

export interface OpenSandboxClientOptions {
  url: string;
  token?: string | undefined;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenSandboxControlPlane {
  private readonly base: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenSandboxClientOptions) {
    this.base = normalizeControlPlaneUrl(options.url);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get origin(): string {
    return this.base;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    const signal = init.signal ?? controller.signal;
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: this.headers(),
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      if (!response.ok) {
        const error = (parsed as { error?: { code?: string; message?: string } }).error;
        throw new OpenSandboxControlPlaneError(
          response.status,
          error?.code ?? "http_error",
          error?.message ?? `${method} ${path} failed with ${response.status}`,
        );
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ ok: boolean }> {
    return await this.request<{ ok: boolean }>("GET", "/health");
  }

  /**
   * The profiles the control plane can provision from. This is the cheapest
   * call that both proves the token is accepted and answers whether the
   * profile an instance names actually exists — which is what the provider
   * snapshot reports as this instance's health.
   */
  async listProfiles(): Promise<OpenSandboxProfile[]> {
    const { profiles } = await this.request<{ profiles: OpenSandboxProfile[] }>("GET", "/profiles");
    return profiles;
  }

  /**
   * Answer one prompt in the sandbox that owns `cwd`, with no conversation
   * attached: the sandbox side of T3's text generation. The reply is raw text;
   * the caller decodes it against the operation's own schema.
   */
  async generateText(input: { cwd: string; prompt: string; model?: string }): Promise<string> {
    const { text } = await this.request<{ text: string }>("POST", "/text-generation", input, {
      timeoutMs: 15 * 60_000,
    });
    return text;
  }

  async listTasks(): Promise<OpenSandboxTask[]> {
    const { tasks } = await this.request<{ tasks: OpenSandboxTask[] }>("GET", "/tasks");
    return tasks;
  }

  async findTaskByThread(threadId: string): Promise<OpenSandboxTask | null> {
    const tasks = await this.listTasks();
    return tasks.find((task) => task.threadId === threadId) ?? null;
  }

  async createTask(input: CreateTaskInput): Promise<OpenSandboxTask> {
    const { task } = await this.request<{ task: OpenSandboxTask }>("POST", "/tasks", input, {
      timeoutMs: 300_000,
    });
    return task;
  }

  /**
   * Fork a task's provider thread into a new task in the same project, under
   * `threadId` — the caller's own id for the fork, so the fork can be found
   * again by thread. The conversation comes along; the new task's worktree is
   * based on the source's branch head.
   */
  async forkTask(sourceTaskId: string, threadId: string): Promise<OpenSandboxTask> {
    const { task } = await this.request<{ task: OpenSandboxTask }>(
      "POST",
      `/tasks/${encodeURIComponent(sourceTaskId)}/fork`,
      { threadId },
      { timeoutMs: 300_000 },
    );
    return task;
  }

  async status(taskId: string): Promise<OpenSandboxTaskStatus> {
    return await this.request<OpenSandboxTaskStatus>("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  async task(taskId: string): Promise<OpenSandboxTask> {
    return (await this.status(taskId)).task;
  }

  async snapshot(taskId: string): Promise<OpenSandboxSnapshot> {
    const { snapshot } = await this.request<{ snapshot: OpenSandboxSnapshot }>(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/snapshot`,
    );
    return snapshot;
  }

  async sendMessage(
    taskId: string,
    text: string,
    model?: string,
    runtimePolicy?: { runtimeMode?: string; interactionMode?: string },
  ): Promise<{ runId: string }> {
    return await this.request<{ runId: string }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/messages`,
      {
        text,
        ...(model ? { model } : {}),
        ...(runtimePolicy?.runtimeMode ? { runtimeMode: runtimePolicy.runtimeMode } : {}),
        ...(runtimePolicy?.interactionMode
          ? { interactionMode: runtimePolicy.interactionMode }
          : {}),
      },
    );
  }

  async steer(taskId: string, text: string): Promise<{ runId: string }> {
    return await this.request<{ runId: string }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/steer`,
      { text },
    );
  }

  async interrupt(taskId: string): Promise<{ runId: string }> {
    return await this.request<{ runId: string }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/interrupt`,
      {},
    );
  }

  async respondToApproval(
    taskId: string,
    requestId: string,
    decision: "approved" | "rejected" | "cancelled",
    answer?: unknown,
  ): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(requestId)}`,
      { decision, ...(answer === undefined ? {} : { answer }) },
    );
  }

  async captureCheckpoint(taskId: string, checkpointId: string, label?: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/checkpoints`,
      { checkpointId, ...(label ? { label } : {}) },
      { timeoutMs: 180_000 },
    );
  }

  async rollback(taskId: string, checkpointId: string): Promise<{ effectIds: string[] }> {
    return await this.request<{ effectIds: string[] }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
      {},
      { timeoutMs: 180_000 },
    );
  }

  async stop(taskId: string): Promise<void> {
    await this.request<{ ok: boolean }>("POST", `/tasks/${encodeURIComponent(taskId)}/stop`, {});
  }

  async resume(taskId: string): Promise<void> {
    await this.request<{ ok: boolean }>("POST", `/tasks/${encodeURIComponent(taskId)}/resume`, {});
  }

  async destroy(taskId: string): Promise<void> {
    await this.request<{ ok: boolean }>("POST", `/tasks/${encodeURIComponent(taskId)}/destroy`, {});
  }

  async exec(taskId: string, command: string): Promise<{ exitCode: number; output: string }> {
    return await this.request<{ exitCode: number; output: string }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/exec`,
      { command },
      { timeoutMs: 300_000 },
    );
  }

  /**
   * The task's event stream. Resumes from `fromSeq`, so a reconnect replays
   * exactly what the client missed and nothing else.
   */
  async *events(
    taskId: string,
    fromSeq = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<OpenSandboxEvent, void, void> {
    const response = await this.fetchImpl(
      `${this.base}/tasks/${encodeURIComponent(taskId)}/events?from=${fromSeq}&stream=sse`,
      { headers: this.headers({ accept: "text/event-stream" }), ...(signal ? { signal } : {}) },
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new OpenSandboxControlPlaneError(
        response.status,
        "stream_failed",
        `event stream failed: ${response.status} ${text.slice(0, 200)}`,
      );
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) {
          try {
            yield JSON.parse(data) as OpenSandboxEvent;
          } catch {
            // A truncated frame is not worth failing the stream over.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  }
}
