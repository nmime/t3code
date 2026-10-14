/**
 * OpenSandbox backend — the self-hosted sandbox provider this control plane
 * runs against (it replaces the OpenSandbox backend, which could not work: a
 * OpenSandbox tier-1/2 sandbox has no outbound route to a control plane outside
 * OpenSandbox, so the worker could never dial home).
 *
 * OpenSandbox (https://github.com/opensandbox-group/OpenSandbox, Apache-2.0) is
 * a lifecycle server plus an in-sandbox agent, `execd`. Everything here is
 * plain HTTP against the server's REST API:
 *
 *   POST   /v1/sandboxes                     create (image or snapshot)
 *   GET    /v1/sandboxes/{id}                status
 *   GET    /v1/sandboxes?pageSize=…          list
 *   POST   /v1/sandboxes/{id}/pause|resume   stop / start
 *   DELETE /v1/sandboxes/{id}                destroy
 *   POST   /v1/sandboxes/{id}/snapshots      snapshot (fsb/Kubernetes runtimes)
 *
 * Command execution and file transfer are *not* on the lifecycle API: they are
 * served by execd inside the sandbox and reachable through the server's
 * reverse proxy at `/v1/sandboxes/{id}/proxy/44772/…` (44772 is execd's
 * in-container port).
 *
 * Five properties of the real API shape this file, each verified against a
 * running server (opensandbox-server 1.1.1) before it was written:
 *
 *  - the proxy path is the *only* sandbox path exempt from the API key, which
 *    is exactly what a browser-facing preview URL wants — no token to hand to
 *    a browser, and no host port to publish;
 *  - `POST …/command` answers with a stream of JSON events, not one object, and
 *    a non-zero exit arrives as an `error` event whose `error.evalue` *is* the
 *    exit status — the terminal `execution_complete` event carries no exit code;
 *  - a background command's id is the text of its `init` event; the HTTP
 *    response body has no id field;
 *  - file upload is multipart where the metadata is itself a *file part* — a
 *    plain form field is rejected with `INVALID_FILE_METADATA`;
 *  - `timeout` on create is an *absolute lifetime* (`expiresAt = createdAt +
 *    timeout`, capped by the server's `max_sandbox_timeout_seconds`), never an
 *    idle timer — and `POST /v1/sandboxes/{id}/renew-expiration` moves
 *    `expiresAt` forward without being subject to that cap.
 *
 * Sandboxes are created with an entrypoint that only keeps the container alive
 * (`tail -f /dev/null`); the control plane uploads the worker bundle into the
 * sandbox and starts it as a background command, exactly as it does for the
 * other backends.
 */

import * as path from "node:path";
import type { SandboxHandle, SandboxStatus, WorkspaceEntry } from "../../../contracts/execution.js";
import {
  ExecutionError,
  SandboxBackendUnsupportedError,
  SandboxNotFoundError,
} from "../../../contracts/errors.js";
import type {
  ExecOptions,
  ExecResult,
  PreviewLink,
  SandboxBackend,
  SandboxSecret,
  SandboxSpec,
} from "../SandboxBackend.js";

/** Default lifecycle server address; the deployment overrides it. */
export const OPENSANDBOX_DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/**
 * Image every sandbox is built from when the profile pins no snapshot. The
 * deployment builds it (`deploy/sandbox-image/Dockerfile`: node, git, a shell)
 * and the lifecycle server starts containers from it.
 */
export const OPENSANDBOX_DEFAULT_IMAGE = "t3x-sandbox:latest";

/** execd's in-sandbox port; the lifecycle server proxies it by number. */
export const OPENSANDBOX_EXECD_PORT = 44772;

/** Keeps a sandbox container alive while the control plane drives it. */
export const OPENSANDBOX_DEFAULT_ENTRYPOINT = ["tail", "-f", "/dev/null"];

export interface OpenSandboxBackendOptions {
  /** Lifecycle server root, e.g. `https://sandbox.example.com`. */
  baseUrl?: string;
  /**
   * Root used to build browser-facing preview URLs when it differs from
   * `baseUrl` (the control plane may reach the server on a loopback address
   * while users reach it on a public hostname).
   */
  publicBaseUrl?: string;
  /** Sent as `OPEN-SANDBOX-API-KEY`. Empty means the server runs unauthenticated. */
  apiKey?: string;
  /** Image for image-backed profiles. */
  defaultImage?: string;
  /** Entrypoint for created sandboxes. */
  entrypoint?: string[];
  /** execd port inside the sandbox. */
  execdPort?: number;
  /**
   * How long a sandbox may live, in seconds — the *absolute* lifetime asked of
   * the provider (`expiresAt = createdAt + this`). A profile's
   * `stopAfterIdleMinutes` is not this: idleness is the control plane's own
   * policy, and a live task's sandbox is renewed before this runs out.
   */
  defaultTimeoutSeconds?: number;
  /** How long to wait for execd inside a new sandbox. */
  readyTimeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

interface OpenSandboxSandbox {
  id: string;
  status?: { state?: string; reason?: string; message?: string; lastTransitionAt?: string };
  image?: { uri?: string };
  snapshotId?: string;
  entrypoint?: string[];
  metadata?: Record<string, string>;
  createdAt?: string;
  expiresAt?: string;
}

interface OpenSandboxFileInfo {
  path: string;
  type?: string;
  size?: number;
  modified_at?: string;
  created_at?: string;
  owner?: string;
  group?: string;
  mode?: number;
}

/**
 * One event of the `/command` stream. Only the fields this backend reads are
 * typed; the server may add more.
 */
interface CommandStreamEvent {
  type?: string;
  text?: string;
  exit_code?: number;
  exitCode?: number;
  error?: { ename?: string; evalue?: string; traceback?: string[] };
}

/**
 * Fold the `/command` event stream into an `ExecResult`.
 *
 * Exported because it is the part most likely to be got wrong: the exit status
 * lives in the `error` event, and stdout/stderr arrive as many small events.
 */
export function parseCommandStream(body: string): ExecResult {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:"))
      continue;
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload || payload === "[DONE]") continue;

    let event: CommandStreamEvent;
    try {
      event = JSON.parse(payload) as CommandStreamEvent;
    } catch {
      // A partial line at the end of a truncated stream is not fatal.
      continue;
    }

    switch (event.type) {
      case "stdout":
        stdout += event.text ?? "";
        break;
      case "stderr":
        stderr += event.text ?? "";
        break;
      case "error": {
        const value = event.error?.evalue ?? "";
        const parsed = Number.parseInt(value, 10);
        exitCode = Number.isFinite(parsed) && parsed !== 0 ? parsed : 1;
        const traceback = (event.error?.traceback ?? []).join("\n");
        if (traceback)
          stderr += stderr.endsWith("\n") || stderr === "" ? `${traceback}\n` : `\n${traceback}\n`;
        break;
      }
      case "execution_complete":
      case "status": {
        const reported = event.exit_code ?? event.exitCode;
        if (typeof reported === "number") exitCode = reported;
        break;
      }
      default:
        break;
    }
  }

  return { exitCode, stdout, stderr, truncated: false };
}

export class OpenSandboxBackend implements SandboxBackend {
  readonly kind = "opensandbox" as const;

  readonly baseUrl: string;
  private readonly publicBaseUrl: string;
  private readonly apiKey: string;
  private readonly defaultImage: string;
  private readonly entrypoint: string[];
  private readonly execdPort: number;
  private readonly defaultTimeoutSeconds: number;
  private readonly readyTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private constructor(options: OpenSandboxBackendOptions) {
    this.baseUrl = stripTrailingSlash(
      options.baseUrl ?? process.env.OPENSANDBOX_API_URL ?? OPENSANDBOX_DEFAULT_BASE_URL,
    );
    this.publicBaseUrl = stripTrailingSlash(
      options.publicBaseUrl ?? process.env.OPENSANDBOX_PUBLIC_URL ?? this.baseUrl,
    );
    this.apiKey = options.apiKey ?? process.env.OPENSANDBOX_API_KEY ?? "";
    this.defaultImage =
      options.defaultImage ?? process.env.OPENSANDBOX_IMAGE ?? OPENSANDBOX_DEFAULT_IMAGE;
    this.entrypoint = options.entrypoint ?? OPENSANDBOX_DEFAULT_ENTRYPOINT;
    this.execdPort = options.execdPort ?? OPENSANDBOX_EXECD_PORT;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? 24 * 60 * 60;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static async create(options: OpenSandboxBackendOptions = {}): Promise<OpenSandboxBackend> {
    const backend = new OpenSandboxBackend(options);
    // Fail at startup, not on the first task: an unreachable or unauthorized
    // lifecycle server is a deployment mistake, and the doctor reports it.
    await backend.ping();
    return backend;
  }

  /** The lifetime a freshly created sandbox is given, in seconds. */
  lifetimeSeconds(): number {
    return Math.max(60, Math.round(this.defaultTimeoutSeconds));
  }

  /** The same lifetime in milliseconds, for the control plane's renewal math. */
  get lifetimeMs(): number {
    return this.lifetimeSeconds() * 1000;
  }

  /** `GET /health` — public route, no API key needed. */
  async ping(): Promise<{ status: string; version: string | null }> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`).catch((cause: unknown) => {
      throw new ExecutionError(
        "execution_target_unavailable",
        `OpenSandbox at ${this.baseUrl} is unreachable: ${message(cause)}`,
      );
    });
    if (!response.ok) {
      throw new ExecutionError(
        "execution_target_unavailable",
        `OpenSandbox at ${this.baseUrl} answered ${response.status} on /health.`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string };
    const version = await this.fetchImpl(`${this.baseUrl}/version`)
      .then((res) => (res.ok ? (res.json() as Promise<{ version?: string }>) : null))
      .then((json) => json?.version ?? null)
      .catch(() => null);
    return { status: body.status ?? "unknown", version };
  }

  /** Sandbox-absolute path of an execd route, through the server's proxy. */
  private execdPath(sandboxId: string, route: string, query?: Record<string, string>): string {
    const search = query ? `?${new URLSearchParams(query).toString()}` : "";
    return `/v1/sandboxes/${encodeURIComponent(sandboxId)}/proxy/${this.execdPort}${route}${search}`;
  }

  private async request(
    route: string,
    init: RequestInit = {},
    options: { tolerate404?: boolean; tolerateCodes?: readonly string[] } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("OPEN-SANDBOX-API-KEY", this.apiKey);
    const url = `${this.baseUrl}${route}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers });
    } catch (cause) {
      throw new ExecutionError(
        "execution_target_unavailable",
        `OpenSandbox request ${init.method ?? "GET"} ${route} failed: ${message(cause)}`,
      );
    }

    if (response.ok) return response;
    if (response.status === 404 && options.tolerate404) return response;

    const detail = await readError(response);
    // A redundant start/stop is not a failure: the provider answers 409 when a
    // sandbox is already in the state the caller asked for.
    if (options.tolerateCodes?.includes(detail.code)) return response;
    if (response.status === 404) {
      throw new SandboxNotFoundError(detail.message || route);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ExecutionError(
        "unauthorized",
        `OpenSandbox rejected the API key (${response.status}): ${detail.message}`,
      );
    }
    throw new ExecutionError(
      "internal",
      `OpenSandbox ${init.method ?? "GET"} ${route} failed (${response.status}): ${detail.message}`,
    );
  }

  /**
   * Create a task sandbox.
   *
   * `spec.snapshot` is passed as the sandbox's `snapshotId` (the profile pinned
   * an environment); an image-backed profile falls back to `defaultImage`.
   * Resources are hard caps: the Docker runtime maps them onto the container's
   * cgroup limits, which is what keeps one task from eating the host.
   */
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const resourceLimits: Record<string, string> = {};
    if (spec.resources.cpu > 0) resourceLimits.cpu = `${Math.round(spec.resources.cpu * 1000)}m`;
    if (spec.resources.memoryGiB > 0)
      resourceLimits.memory = `${Math.round(spec.resources.memoryGiB * 1024)}Mi`;

    const metadata: Record<string, string> = {
      "t3x.task-id": spec.taskId,
      "t3x.managed": "true",
    };
    if (spec.snapshot) metadata["t3x.profile"] = spec.snapshot;

    // `timeout` on this API is an absolute lifetime, not an idle timer.
    // Sending the profile's `stopAfterIdleMinutes` here made every sandbox die
    // thirty minutes after it was created — under a task that was using it —
    // and the sweep then rebuilt the environment from scratch (39 sandboxes
    // for one idle task). Idle-stop is the control plane's own policy
    // (PolicyEngine); this lifetime is only a backstop for a control plane
    // that never comes back, and `renew()` pushes it forward while a task is
    // alive.
    const timeoutSeconds = this.lifetimeSeconds();

    const body: Record<string, unknown> = {
      ...(spec.snapshot ? { snapshotId: spec.snapshot } : { image: { uri: this.defaultImage } }),
      entrypoint: this.entrypoint,
      metadata,
      timeout: timeoutSeconds,
      ...(Object.keys(resourceLimits).length > 0 ? { resourceLimits } : {}),
      ...(Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
      ...platformSpec(spec.platform),
    };

    const response = await this.request("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const created = (await response.json()) as OpenSandboxSandbox;
    const id = created.id;
    if (!id) {
      throw new ExecutionError("internal", "OpenSandbox returned a sandbox without an id.", {
        taskId: spec.taskId,
      });
    }

    // The container is up; its agent may not be. Wait for execd before the
    // first exec, or the first call races the sandbox's own startup.
    await this.waitUntilReady(id);

    // A fresh sandbox has no working directory, and execd refuses a cwd that
    // does not exist.
    if (spec.workingDirectory) {
      const mkdir = await this.exec(id, `mkdir -p ${shellQuote(spec.workingDirectory)}`);
      if (mkdir.exitCode !== 0) {
        throw new ExecutionError(
          "internal",
          `Could not create the working directory ${spec.workingDirectory} in sandbox ${id}: ` +
            `${mkdir.stderr || mkdir.stdout}`.trim(),
          { taskId: spec.taskId, sandboxId: id },
        );
      }
    }

    for (const step of spec.setup) {
      const result = await this.exec(id, step, { cwd: spec.workingDirectory, timeoutMs: 900_000 });
      if (result.exitCode !== 0) {
        throw new ExecutionError("internal", `Setup step failed (${result.exitCode}): ${step}`, {
          taskId: spec.taskId,
          sandboxId: id,
          stderr: result.stderr || result.stdout,
        });
      }
    }

    return {
      id,
      taskId: spec.taskId,
      backend: "opensandbox",
      workspaceRoot: spec.workingDirectory,
    };
  }

  private mapState(state: string | undefined): SandboxStatus["state"] {
    switch ((state ?? "").toLowerCase()) {
      case "running":
        return "running";
      case "paused":
      case "pausing":
        return "paused";
      case "resuming":
        return "creating";
      case "terminated":
      case "deleted":
        return "deleted";
      case "stopping":
      case "stopped":
      case "failed":
        return "stopped";
      default:
        return "creating";
    }
  }

  private mapStatus(sandbox: OpenSandboxSandbox): SandboxStatus {
    const expiresAt = sandbox.expiresAt ? Date.parse(sandbox.expiresAt) : Number.NaN;
    return {
      id: sandbox.id,
      taskId: sandbox.metadata?.["t3x.task-id"] ?? null,
      backend: "opensandbox",
      state: this.mapState(sandbox.status?.state),
      createdAt: sandbox.createdAt ? Date.parse(sandbox.createdAt) : 0,
      autoStopAt: Number.isFinite(expiresAt) ? expiresAt : null,
      snapshot: sandbox.snapshotId ?? sandbox.image?.uri ?? null,
      resources: { cpu: 0, memoryGiB: 0 },
    };
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    const response = await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`);
    return this.mapStatus((await response.json()) as OpenSandboxSandbox);
  }

  async list(): Promise<SandboxStatus[]> {
    const out: SandboxStatus[] = [];
    let page = 1;
    for (;;) {
      const response = await this.request(`/v1/sandboxes?page=${page}&pageSize=200`);
      const body = (await response.json()) as {
        items?: OpenSandboxSandbox[];
        pagination?: { hasNextPage?: boolean };
      };
      for (const item of body.items ?? []) {
        // A deployment may share one lifecycle server; only touch our own.
        if (item.metadata && item.metadata["t3x.managed"] !== "true") continue;
        out.push(this.mapStatus(item));
      }
      if (!body.pagination?.hasNextPage) break;
      page += 1;
    }
    return out;
  }

  /**
   * Start a paused sandbox.
   *
   * A sandbox that is already running has nothing to start, and the provider
   * says so with 409 `DOCKER::SANDBOX_NOT_PAUSED`. That is the normal shape of
   * a task suspended while other tasks kept the shared sandbox alive
   * (`stopped_shared`), and of a resume that raced the reconcile sweep — it is
   * a no-op, not a failure, so the effect is not left retrying it forever.
   */
  async start(sandboxId: string): Promise<void> {
    await this.request(
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
      { method: "POST" },
      { tolerateCodes: ["DOCKER::SANDBOX_NOT_PAUSED"] },
    );
  }

  /**
   * Pause a sandbox. Symmetric to `start`: pausing one that is already paused
   * (two idle tasks on one shared sandbox, or a stop that raced the sweep)
   * answers 409 `DOCKER::SANDBOX_NOT_RUNNING` and is a no-op.
   */
  async stop(sandboxId: string): Promise<void> {
    await this.request(
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pause`,
      { method: "POST" },
      { tolerateCodes: ["DOCKER::SANDBOX_NOT_RUNNING"] },
    );
  }

  /**
   * Push a sandbox's `expiresAt` forward (`POST …/renew-expiration`). That
   * route is not subject to the creation-time `max_sandbox_timeout_seconds`
   * cap, so a long-lived task keeps the sandbox it has — with its working
   * tree, its installed dependencies and its provider-native session — instead
   * of a fresh one every lifetime.
   *
   * Returns the new `expiresAt` in epoch milliseconds (the requested value when
   * the server answers without one).
   */
  async renew(sandboxId: string, expiresAtMs: number): Promise<number> {
    const response = await this.request(
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/renew-expiration`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresAt: new Date(expiresAtMs).toISOString() }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as { expiresAt?: string };
    const parsed = body.expiresAt ? Date.parse(body.expiresAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : expiresAtMs;
  }

  async destroy(sandboxId: string): Promise<void> {
    // Deleting a sandbox that is already gone is not an error.
    await this.request(
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
      { method: "DELETE" },
      { tolerate404: true },
    );
  }

  /**
   * Snapshots are a fast-sandbox (Kubernetes/fsb) feature; the Docker runtime
   * answers the request with an error, which is surfaced as-is rather than
   * pretended away. Profiles on a Docker deployment are image-backed.
   */
  async snapshot(sandboxId: string, name: string): Promise<{ id: string }> {
    const response = await this.request(
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as { id?: string; snapshotId?: string };
    return { id: body.id ?? body.snapshotId ?? name };
  }

  async restoreSnapshot(_sandboxId: string, _snapshotId: string): Promise<void> {
    // Restoring is a create: `create()` passes the profile's snapshot as
    // `snapshotId`. There is no roll-back primitive to expose here.
    throw new SandboxBackendUnsupportedError("opensandbox", "restoreSnapshot");
  }

  async exec(sandboxId: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const body: Record<string, unknown> = { command, background: false };
    if (options.cwd) body.cwd = options.cwd;
    if (options.env && Object.keys(options.env).length > 0) body.envs = options.env;
    if (options.timeoutMs && options.timeoutMs > 0)
      body.timeout = Math.max(1, Math.floor(options.timeoutMs));

    const response = await this.request(this.execdPath(sandboxId, "/command"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseCommandStream(await response.text());
  }

  /**
   * Wait until execd answers inside a new sandbox.
   *
   * The lifecycle server reports `Running` as soon as the container is up, and
   * its own docs say that "does not check whether your application inside the
   * sandbox is ready". The first exec into a fresh sandbox can therefore hit
   * the proxy before execd listens (a 502 from the server). Poll the agent's
   * own `/ping` instead of racing it.
   */
  async waitUntilReady(sandboxId: string, timeoutMs = this.readyTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "no answer";
    for (;;) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}${this.execdPath(sandboxId, "/ping")}`,
          {
            headers: this.apiKey ? { "OPEN-SANDBOX-API-KEY": this.apiKey } : {},
          },
        );
        if (response.ok) return;
        lastError = `HTTP ${response.status} ${response.statusText}`;
      } catch (cause) {
        lastError = message(cause);
      }
      if (Date.now() >= deadline) {
        throw new ExecutionError(
          "execution_target_unavailable",
          `Sandbox ${sandboxId} never became ready (${lastError}).`,
          { sandboxId },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Start a detached command and return its id (the text of the `init` event).
   * The control plane uses this to launch the worker, which then dials home and
   * never exits.
   */
  async execBackground(
    sandboxId: string,
    command: string,
    options: ExecOptions = {},
  ): Promise<string> {
    const body: Record<string, unknown> = { command, background: true };
    if (options.cwd) body.cwd = options.cwd;
    if (options.env && Object.keys(options.env).length > 0) body.envs = options.env;

    const response = await this.request(this.execdPath(sandboxId, "/command"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
      try {
        const event = JSON.parse(payload) as CommandStreamEvent;
        if (event.type === "init" && event.text) return event.text;
      } catch {
        continue;
      }
    }
    throw new ExecutionError(
      "internal",
      "OpenSandbox did not return a command id for a background run.",
      {
        sandboxId,
      },
    );
  }

  /**
   * `exec`, but detached: the worker is launched this way and outlives the
   * HTTP call that started it.
   */
  async execDetached(sandboxId: string, command: string, options: ExecOptions = {}): Promise<void> {
    await this.execBackground(sandboxId, command, options);
  }

  async readFile(sandboxId: string, filePath: string): Promise<Buffer> {
    const response = await this.request(
      this.execdPath(sandboxId, "/files/download", { path: filePath }),
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async writeFile(sandboxId: string, filePath: string, data: Buffer, mode?: number): Promise<void> {
    const form = new FormData();
    // The metadata must be a file part: execd rejects a plain form field with
    // INVALID_FILE_METADATA ("metadata file is missing").
    const metadata = {
      path: filePath,
      owner: "root",
      group: "root",
      // The API takes octal *digits* (755), not the numeric mode (0o755).
      ...(mode === undefined ? {} : { mode: Number.parseInt(mode.toString(8), 10) }),
    };
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    form.append("file", new Blob([new Uint8Array(data)]), path.posix.basename(filePath));

    await this.request(this.execdPath(sandboxId, "/files/upload"), { method: "POST", body: form });
  }

  async listDir(sandboxId: string, dirPath: string): Promise<WorkspaceEntry[]> {
    const response = await this.request(
      this.execdPath(sandboxId, "/directories/list", { path: dirPath, depth: "1" }),
    );
    const entries = (await response.json()) as OpenSandboxFileInfo[];
    return entries.map((entry) => {
      const stamp = entry.modified_at ?? entry.created_at;
      const parsed = stamp ? Date.parse(stamp) : Number.NaN;
      return {
        name: path.posix.basename(entry.path),
        path: entry.path,
        kind: entry.type === "directory" ? "directory" : "file",
        size: entry.size ?? 0,
        modifiedAt: Number.isFinite(parsed) ? parsed : 0,
      };
    });
  }

  /**
   * Credentials are part of the create request (`env`), so there is nothing to
   * attach afterwards. The lifecycle server's credential vault is an egress
   * feature, not an in-sandbox one; refusing beats silently dropping a secret.
   */
  async injectSecrets(_sandboxId: string, secrets: SandboxSecret[]): Promise<void> {
    if (secrets.length === 0) return;
    throw new ExecutionError(
      "sandbox_backend_unsupported",
      "OpenSandbox passes credentials as environment variables at creation; declare them in " +
        "the profile instead of injecting into a running sandbox.",
      { secrets: secrets.map((secret) => secret.name) },
    );
  }

  homeDir(_sandboxId: string): string {
    // Sandboxes run as root inside the container.
    return "/root";
  }

  async writeConfigFiles(
    sandboxId: string,
    files: Array<{ path: string; content: string; mode?: number }>,
  ): Promise<void> {
    for (const file of files) {
      const target = file.path.startsWith("~/")
        ? `${this.homeDir(sandboxId)}/${file.path.slice(2)}`
        : file.path;
      await this.writeFile(sandboxId, target, Buffer.from(file.content, "utf8"), file.mode);
    }
  }

  /**
   * Port-scoped preview URL.
   *
   * The server's proxy path needs no API key, so this is a plain link a browser
   * can open; nothing expires and no token travels with it. The sandbox id is
   * the only secret, which is why the deployment keeps the sandbox ports
   * themselves unpublished (`docker.publish_host = 127.0.0.1`).
   */
  async previewUrl(sandboxId: string, port: number, _ttlSeconds: number): Promise<PreviewLink> {
    return {
      url: `${this.publicBaseUrl}/v1/sandboxes/${encodeURIComponent(sandboxId)}/proxy/${port}/`,
      token: null,
      expiresAt: null,
    };
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `linux/amd64` -> `{ platform: { os, arch } }`, when the profile names one. */
function platformSpec(platform: string): Record<string, unknown> {
  const match = /^([a-z0-9]+)\/([a-z0-9_]+)$/i.exec(platform ?? "");
  if (!match) return {};
  return { platform: { os: match[1], arch: match[2] } };
}

async function readError(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as { code?: string; message?: string; detail?: unknown };
    return {
      code: body.code ?? String(response.status),
      message: body.message ?? JSON.stringify(body.detail ?? body),
    };
  } catch {
    return { code: String(response.status), message: response.statusText };
  }
}
