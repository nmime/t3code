/**
 * OpenSandboxBackend against a fake lifecycle server.
 *
 * The fake answers exactly what opensandbox-server 1.1.1 answered when the
 * backend was written: a JSON event stream on `/command` (the exit status
 * inside the `error` event, the background command id inside the `init`
 * event), a multipart upload whose metadata must be a file part, execd routes
 * behind `/v1/sandboxes/{id}/proxy/44772`, and a paginated list. Every one of
 * those differs from the convenient shape a first draft assumes, and each is
 * invisible until the code meets a real server.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  OPENSANDBOX_EXECD_PORT,
  OpenSandboxBackend,
  parseCommandStream,
} from "../../src/execution/backends/opensandbox/OpenSandboxBackend.js";
import type { SandboxSpec } from "../../src/execution/backends/SandboxBackend.js";
import { ExecutionError, SandboxNotFoundError } from "../../src/contracts/errors.js";

const API_KEY = "test-key-0123456789";

interface FakeSandbox {
  id: string;
  state: string;
  image?: string;
  snapshotId?: string;
  metadata: Record<string, string>;
  entrypoint: string[];
  createdAt: string;
  expiresAt: string;
  files: Map<string, Buffer>;
}

/** A lifecycle server that behaves like the real one, including its quirks. */
class FakeLifecycleServer {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly requests: Array<{ method: string; path: string; body: string; apiKey?: string }> = [];
  readonly commands: Array<{ id: string; command: string; background: boolean; cwd?: string }> = [];
  readonly uploads: Array<{ metadata: string; content: string; hadFilename: boolean }> = [];
  /** Commands containing this marker answer with a non-zero exit. */
  static readonly FAIL_MARKER = "__fail__";
  /** How many `/ping` calls answer 502 before the sandbox is considered up. */
  pingFailures = 0;
  /** Set to make the next request answer with this status. */
  failNext: { status: number; body: unknown } | null = null;
  requireApiKey = true;

  private server: http.Server | null = null;
  private counter = 0;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    // fetch keeps its sockets alive, and `close()` alone waits for them.
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const apiKey = req.headers["open-sandbox-api-key"] as string | undefined;
    this.requests.push({
      method: req.method ?? "",
      path: url.pathname + url.search,
      body: body.toString("utf8"),
      apiKey,
    });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/health") {
      json(200, { status: "healthy" });
      return;
    }
    if (url.pathname === "/version") {
      json(200, { version: "1.1.1" });
      return;
    }

    if (this.failNext) {
      const { status, body: payload } = this.failNext;
      this.failNext = null;
      json(status, payload);
      return;
    }

    // Everything below the public routes needs the API key, exactly like the
    // real server's auth middleware.
    if (this.requireApiKey && apiKey !== API_KEY) {
      json(401, {
        code: "MISSING_API_KEY",
        message: "Provide API key via OPEN-SANDBOX-API-KEY header.",
      });
      return;
    }

    const proxy = /^\/v1\/sandboxes\/([^/]+)\/proxy\/(\d+)(\/.*)$/.exec(url.pathname);
    if (proxy) {
      this.handleExecd(proxy[1]!, Number(proxy[2]), proxy[3]!, url, body, res);
      return;
    }

    if (url.pathname === "/v1/sandboxes" && req.method === "POST") {
      const request = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      const id = `sandbox-${++this.counter}`;
      const sandbox: FakeSandbox = {
        id,
        state: "Running",
        ...(request.image ? { image: (request.image as { uri: string }).uri } : {}),
        ...(request.snapshotId ? { snapshotId: request.snapshotId as string } : {}),
        metadata: (request.metadata ?? {}) as Record<string, string>,
        entrypoint: (request.entrypoint ?? []) as string[],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
        files: new Map(),
      };
      this.sandboxes.set(id, sandbox);
      json(201, {
        id,
        status: { state: "Running", reason: "CONTAINER_RUNNING" },
        entrypoint: sandbox.entrypoint,
        createdAt: sandbox.createdAt,
        expiresAt: sandbox.expiresAt,
      });
      return;
    }

    if (url.pathname === "/v1/sandboxes" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
      const all = [...this.sandboxes.values()];
      const items = all.slice((page - 1) * pageSize, page * pageSize);
      json(200, {
        items: items.map((sandbox) => ({
          id: sandbox.id,
          ...(sandbox.image ? { image: { uri: sandbox.image } } : {}),
          ...(sandbox.snapshotId ? { snapshotId: sandbox.snapshotId } : {}),
          metadata: sandbox.metadata,
          status: { state: sandbox.state },
          createdAt: sandbox.createdAt,
          expiresAt: sandbox.expiresAt,
        })),
        pagination: {
          page,
          pageSize,
          totalItems: all.length,
          hasNextPage: page * pageSize < all.length,
        },
      });
      return;
    }

    const sandboxPath = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (sandboxPath) {
      const sandbox = this.sandboxes.get(sandboxPath[1]!);
      if (!sandbox) {
        json(404, { code: "SANDBOX_NOT_FOUND", message: "sandbox not found" });
        return;
      }
      const action = sandboxPath[2] ?? "";
      if (action === "" && req.method === "GET") {
        json(200, {
          id: sandbox.id,
          ...(sandbox.image ? { image: { uri: sandbox.image } } : {}),
          ...(sandbox.snapshotId ? { snapshotId: sandbox.snapshotId } : {}),
          metadata: sandbox.metadata,
          status: { state: sandbox.state },
          entrypoint: sandbox.entrypoint,
          createdAt: sandbox.createdAt,
          expiresAt: sandbox.expiresAt,
        });
        return;
      }
      if (action === "" && req.method === "DELETE") {
        this.sandboxes.delete(sandbox.id);
        res.writeHead(204);
        res.end();
        return;
      }
      if (action === "/pause") {
        // The real server refuses a redundant pause/start with a 409 carrying a
        // code (measured against the deployment): `DOCKER::SANDBOX_NOT_RUNNING`
        // for a pause of a paused sandbox, `DOCKER::SANDBOX_NOT_PAUSED` for the
        // reverse. The backend has to read that as "already in the state you
        // asked for", not as a failure.
        if (sandbox.state === "Paused") {
          json(409, {
            code: "DOCKER::SANDBOX_NOT_RUNNING",
            message: "Sandbox is not in a running state.",
          });
          return;
        }
        sandbox.state = "Paused";
        json(200, { id: sandbox.id, status: { state: sandbox.state } });
        return;
      }
      if (action === "/resume") {
        if (sandbox.state === "Running") {
          json(409, {
            code: "DOCKER::SANDBOX_NOT_PAUSED",
            message: "Sandbox is not in a paused state.",
          });
          return;
        }
        sandbox.state = "Running";
        json(200, { id: sandbox.id, status: { state: sandbox.state } });
        return;
      }
      if (action === "/renew-expiration") {
        const request = JSON.parse(body.toString("utf8")) as { expiresAt?: string };
        if (request.expiresAt) sandbox.expiresAt = request.expiresAt;
        json(200, { expiresAt: sandbox.expiresAt });
        return;
      }
      if (action === "/snapshots") {
        json(201, { id: `snapshot-${sandbox.id}`, name: "snap" });
        return;
      }
    }

    json(404, { code: "NOT_FOUND", message: `no route for ${url.pathname}` });
  }

  /** execd: the routes the backend reaches through the lifecycle proxy. */
  private handleExecd(
    sandboxId: string,
    port: number,
    route: string,
    url: URL,
    body: Buffer,
    res: http.ServerResponse,
  ): void {
    const sandbox = this.sandboxes.get(sandboxId);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (!sandbox) {
      json(404, { code: "SANDBOX_NOT_FOUND", message: "sandbox not found" });
      return;
    }
    if (port !== OPENSANDBOX_EXECD_PORT) {
      json(500, { code: "BAD_PORT", message: `no proxy for ${port}` });
      return;
    }

    if (route === "/ping") {
      // The first pings can fail: a fresh container answers the lifecycle API
      // before execd listens, which is the race `waitUntilReady` closes.
      if (this.pingFailures > 0) {
        this.pingFailures -= 1;
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "BAD_GATEWAY",
            message: "Could not connect to the backend sandbox",
          }),
        );
        return;
      }
      json(200, { status: "ok" });
      return;
    }

    if (route === "/command") {
      const request = JSON.parse(body.toString("utf8")) as {
        command: string;
        cwd?: string;
        background?: boolean;
      };
      const id = `cmd-${++this.counter}`;
      this.commands.push({
        id,
        command: request.command,
        background: Boolean(request.background),
        ...(request.cwd ? { cwd: request.cwd } : {}),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events: string[] = [];
      if (request.background) {
        events.push(JSON.stringify({ type: "init", text: id }));
        events.push(JSON.stringify({ type: "execution_complete" }));
      } else {
        events.push(JSON.stringify({ type: "init", text: id }));
        events.push(JSON.stringify({ type: "ping", text: "pong" }));
        if (request.command.includes("__stdout__")) {
          events.push(JSON.stringify({ type: "stdout", text: "hello\n" }));
        }
        if (request.command.includes("__stderr__")) {
          events.push(JSON.stringify({ type: "stderr", text: "oops\n" }));
        }
        if (request.command.includes(FakeLifecycleServer.FAIL_MARKER)) {
          events.push(
            JSON.stringify({
              type: "error",
              error: { ename: "CommandExecError", evalue: "3", traceback: ["exit status 3"] },
            }),
          );
        } else {
          events.push(JSON.stringify({ type: "execution_complete", execution_time: 7 }));
        }
      }
      res.end(`${events.join("\n\n")}\n\n`);
      return;
    }

    if (route === "/files/upload") {
      const text = body.toString("utf8");
      // The metadata must travel as a file part; the real server answers
      // INVALID_FILE_METADATA otherwise.
      // Header lines are consumed lazily: greedy matching walks straight past
      // the metadata part into the file part.
      const metadataMatch =
        /name="metadata"(;\s*filename="[^"]*")?\r\n(?:[^\r\n]*\r\n)*?\r\n([\s\S]*?)\r\n--/.exec(
          text,
        );
      if (!metadataMatch?.[1]) {
        json(400, { code: "INVALID_FILE_METADATA", message: "metadata file is missing" });
        return;
      }
      let metadata: { path: string };
      try {
        metadata = JSON.parse(metadataMatch[2]!.trim()) as { path: string };
      } catch {
        // Never leave the caller hanging: answer, do not throw.
        json(400, { code: "INVALID_FILE_METADATA", message: "metadata is not JSON" });
        return;
      }
      const fileMatch = /name="file"[^\r\n]*\r\n(?:[^\r\n]*\r\n)*?\r\n([\s\S]*?)\r\n--/.exec(text);
      const content = fileMatch?.[1] ?? "";
      sandbox.files.set(metadata.path, Buffer.from(content, "utf8"));
      this.uploads.push({ metadata: metadataMatch[2]!.trim(), content, hadFilename: true });
      json(200, { ok: true });
      return;
    }

    if (route === "/files/download") {
      const filePath = url.searchParams.get("path") ?? "";
      const file = sandbox.files.get(filePath);
      if (!file) {
        json(404, { code: "FILE_NOT_FOUND", message: `file not found: ${filePath}` });
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(file);
      return;
    }

    if (route === "/directories/list") {
      const dirPath = url.searchParams.get("path") ?? "/";
      const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
      json(200, [
        {
          path: `${prefix}src`,
          type: "directory",
          size: 4096,
          modified_at: "2026-01-02T03:04:05.000Z",
          created_at: "2026-01-02T03:04:05.000Z",
          owner: "root",
          group: "root",
          mode: 755,
        },
        {
          path: `${prefix}README.md`,
          type: "file",
          size: 42,
          modified_at: "2026-01-02T03:04:06.000Z",
          created_at: "2026-01-02T03:04:06.000Z",
          owner: "root",
          group: "root",
          mode: 644,
        },
      ]);
      return;
    }

    json(404, { code: "NOT_FOUND", message: `no execd route for ${route}` });
  }
}

const server = new FakeLifecycleServer();
let baseUrl = "";
let backend: OpenSandboxBackend;

before(async () => {
  baseUrl = await server.start();
  backend = await OpenSandboxBackend.create({
    baseUrl,
    apiKey: API_KEY,
    defaultImage: "t3x-sandbox:latest",
    // The wait is real; the test must not sit through the production timeout.
    readyTimeoutMs: 400,
  });
});

after(async () => {
  await server.stop();
});

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    taskId: "task-1",
    snapshot: "",
    platform: "linux/amd64",
    resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 },
    env: {},
    setup: [],
    workingDirectory: "/workspace/project",
    secrets: [],
    stopAfterIdleMinutes: 60,
    ...overrides,
  };
}

function lastRequest(path: string) {
  return [...server.requests].reverse().find((request) => request.path.startsWith(path));
}

test("create posts an image sandbox with resource caps, metadata and a keep-alive entrypoint", async () => {
  const handle = await backend.create(spec({ env: { T3X_TASK_ID: "task-1" } }));

  assert.equal(handle.backend, "opensandbox");
  assert.equal(handle.taskId, "task-1");
  assert.equal(handle.workspaceRoot, "/workspace/project");
  assert.match(handle.id, /^sandbox-\d+$/);

  const created = server.requests.find(
    (request) => request.method === "POST" && request.path === "/v1/sandboxes",
  );
  assert.ok(created, "the create request was sent");
  const body = JSON.parse(created.body) as Record<string, unknown>;
  assert.deepEqual(body.image, { uri: "t3x-sandbox:latest" });
  assert.deepEqual(body.entrypoint, ["tail", "-f", "/dev/null"]);
  assert.deepEqual(body.resourceLimits, { cpu: "2000m", memory: "4096Mi" });
  assert.deepEqual(body.env, { T3X_TASK_ID: "task-1" });
  // `timeout` is the sandbox's absolute lifetime, not the profile's idle-stop:
  // the spec below asks for 60 idle minutes, and the request must still carry
  // the backend's lifetime (24 h unless the deployment says otherwise). Sending
  // the idle minutes here killed a sandbox under a task that was using it.
  assert.equal(body.timeout, 24 * 60 * 60);
  assert.deepEqual(body.metadata, { "t3x.task-id": "task-1", "t3x.managed": "true" });
  assert.deepEqual(body.platform, { os: "linux", arch: "amd64" });
  assert.equal(created.apiKey, API_KEY, "the API key travels on every call");

  // The working directory is created inside the sandbox before anything runs.
  const mkdir = server.commands.find((command) => command.command.includes("mkdir -p"));
  assert.ok(mkdir, "mkdir ran inside the sandbox");
  assert.match(mkdir.command, /mkdir -p '\/workspace\/project'/);
});

test("create runs the profile's setup steps and fails loudly when one does", async () => {
  await backend.create(spec({ setup: ["echo __stdout__"] }));
  assert.ok(server.commands.some((command) => command.command === "echo __stdout__"));

  await assert.rejects(
    () => backend.create(spec({ setup: [FakeLifecycleServer.FAIL_MARKER] })),
    (error: unknown) =>
      error instanceof ExecutionError && /Setup step failed \(3\)/.test(error.message),
  );
});

test("create waits for execd inside a sandbox the server already calls Running", async () => {
  // The lifecycle server reports Running as soon as the container starts; the
  // agent inside is not up yet, and the first exec would get a 502.
  server.pingFailures = 2;
  try {
    const handle = await backend.create(spec());
    assert.equal((await backend.status(handle.id)).state, "running");
    assert.equal(server.pingFailures, 0, "the wait consumed the failing pings");
  } finally {
    server.pingFailures = 0;
  }
});

test("create gives up on a sandbox whose agent never comes up", async () => {
  server.pingFailures = 10_000;
  try {
    await assert.rejects(
      () => backend.create(spec()),
      (error: unknown) =>
        error instanceof ExecutionError && error.code === "execution_target_unavailable",
    );
  } finally {
    server.pingFailures = 0;
  }
});

test("create passes the profile's snapshot instead of an image", async () => {
  const before = server.sandboxes.size;
  await backend.create(spec({ snapshot: "snap-abc" }));
  const created = [...server.sandboxes.values()][before]!;
  assert.equal(created.snapshotId, "snap-abc");
  assert.equal(created.image, undefined);
});

test("exec folds the event stream into stdout, stderr and an exit code", async () => {
  const handle = await backend.create(spec());
  const result = await backend.exec(handle.id, "echo __stdout__", { cwd: "/workspace/project" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, "");
  assert.equal(result.truncated, false);

  const last = server.commands.at(-1)!;
  assert.equal(last.background, false);
  assert.equal(last.cwd, "/workspace/project");
});

test("exec reports a non-zero exit from the error event", async () => {
  const handle = await backend.create(spec());
  const result = await backend.exec(handle.id, FakeLifecycleServer.FAIL_MARKER);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /exit status 3/);
});

test("parseCommandStream reads a bare JSON stream, SSE framing, and a partial tail", () => {
  const body = [
    '{"type":"init","text":"cmd-1"}',
    "",
    'data: {"type":"stdout","text":"one\\n"}',
    "",
    '{"type":"stderr","text":"two\\n"}',
    "",
    '{"type":"error","error":{"ename":"CommandExecError","evalue":"7","traceback":["exit status 7"]}}',
    "",
    '{"type":"stdout","text":"partial',
  ].join("\n");
  const result = parseCommandStream(body);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "one\n");
  assert.equal(result.stderr, "two\nexit status 7\n");
});

test("execDetached starts the command in the background and returns its id", async () => {
  const handle = await backend.create(spec());
  await backend.execDetached(handle.id, "node /root/.t3x/worker/index.js", {
    cwd: "/workspace/project",
  });
  const launched = server.commands.at(-1)!;
  assert.equal(launched.background, true);
  assert.equal(launched.command, "node /root/.t3x/worker/index.js");
  assert.equal(launched.cwd, "/workspace/project");
});

test("writeFile uploads the metadata as a file part, and readFile reads it back", async () => {
  const handle = await backend.create(spec());
  await backend.writeFile(handle.id, "/root/.t3x/state.json", Buffer.from("{}", "utf8"), 0o600);

  const upload = server.uploads.at(-1)!;
  assert.equal(upload.hadFilename, true, "metadata must be a file part");
  assert.deepEqual(JSON.parse(upload.metadata), {
    path: "/root/.t3x/state.json",
    owner: "root",
    group: "root",
    mode: 600,
  });

  const bytes = await backend.readFile(handle.id, "/root/.t3x/state.json");
  assert.equal(bytes.toString("utf8"), "{}");
});

test("listDir maps execd's FileInfo onto workspace entries", async () => {
  const handle = await backend.create(spec());
  const entries = await backend.listDir(handle.id, "/workspace/project");
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.path, entry.kind, entry.size]),
    [
      ["src", "/workspace/project/src", "directory", 4096],
      ["README.md", "/workspace/project/README.md", "file", 42],
    ],
  );
  assert.equal(entries[1]!.modifiedAt, Date.parse("2026-01-02T03:04:06.000Z"));
});

test("status and list map lifecycle states, and list keeps only t3x sandboxes", async () => {
  const handle = await backend.create(spec());
  const running = await backend.status(handle.id);
  assert.equal(running.state, "running");
  assert.equal(running.taskId, "task-1");
  assert.equal(running.backend, "opensandbox");
  assert.equal(running.autoStopAt, Date.parse("2026-01-02T00:00:00.000Z"));

  await backend.stop(handle.id);
  assert.equal((await backend.status(handle.id)).state, "paused");
  await backend.start(handle.id);
  assert.equal((await backend.status(handle.id)).state, "running");

  // A sandbox somebody else created on the same server is not ours to manage.
  server.sandboxes.set("foreign", {
    id: "foreign",
    state: "Running",
    metadata: { "other.tool": "true" },
    entrypoint: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    files: new Map(),
  });
  const listed = await backend.list();
  assert.ok(!listed.some((sandbox) => sandbox.id === "foreign"));
  assert.ok(listed.some((sandbox) => sandbox.id === handle.id));
});

test("a redundant start or stop is a no-op, not a failure", async () => {
  // Two tasks can share one sandbox: the second one to idle out is suspended
  // while the sandbox stays running (`stopped_shared`), and a resume then asks
  // the provider to start a sandbox that never stopped. The provider answers
  // 409 `DOCKER::SANDBOX_NOT_PAUSED`; the backend must swallow it, or the
  // resume effect retries forever and the task never comes back.
  const handle = await backend.create(spec());
  await backend.start(handle.id);
  assert.equal((await backend.status(handle.id)).state, "running");

  await backend.stop(handle.id);
  await backend.stop(handle.id);
  assert.equal((await backend.status(handle.id)).state, "paused");

  await backend.start(handle.id);
  assert.equal((await backend.status(handle.id)).state, "running");
});

test("status on a missing sandbox raises sandbox_not_found", async () => {
  await assert.rejects(
    () => backend.status("sandbox-does-not-exist"),
    (error: unknown) => error instanceof SandboxNotFoundError,
  );
});

test("destroy tolerates a sandbox that is already gone", async () => {
  await backend.destroy("sandbox-does-not-exist");
});

test("a server error surfaces the server's own message", async () => {
  server.failNext = {
    status: 500,
    body: { code: "SANDBOX::UNSUPPORTED_POOL_REF", message: "no pool here" },
  };
  await assert.rejects(
    () => backend.create(spec()),
    (error: unknown) =>
      error instanceof ExecutionError &&
      /no pool here/.test(error.message) &&
      /500/.test(error.message),
  );
});

test("a wrong API key is reported as unauthorized", async () => {
  server.failNext = { status: 401, body: { code: "MISSING_API_KEY", message: "nope" } };
  await assert.rejects(
    () => backend.status("sandbox-1"),
    (error: unknown) => error instanceof ExecutionError && error.code === "unauthorized",
  );
});

test("previewUrl is the key-less proxy path on the public root", async () => {
  const backendWithPublic = await OpenSandboxBackend.create({
    baseUrl,
    publicBaseUrl: "https://sandbox.example.com",
    apiKey: API_KEY,
  });
  const link = await backendWithPublic.previewUrl("sandbox-1", 3000, 60);
  assert.equal(link.url, `https://sandbox.example.com/v1/sandboxes/sandbox-1/proxy/3000/`);
  assert.equal(link.token, null);
  assert.equal(link.expiresAt, null);
});

test("secrets are refused rather than silently dropped", async () => {
  const handle = await backend.create(spec());
  await backend.injectSecrets(handle.id, []);
  await assert.rejects(
    () => backend.injectSecrets(handle.id, [{ name: "TOKEN", value: "x", inject: "env" }]),
    (error: unknown) =>
      error instanceof ExecutionError && error.code === "sandbox_backend_unsupported",
  );
});

test("writeConfigFiles expands ~/ under the sandbox home", async () => {
  const handle = await backend.create(spec());
  await backend.writeConfigFiles(handle.id, [
    { path: "~/.codex/config.toml", content: "x = 1", mode: 0o600 },
  ]);
  const upload = server.uploads.at(-1)!;
  assert.equal(JSON.parse(upload.metadata).path, "/root/.codex/config.toml");
});

test("an unauthenticated server works when no key is configured", async () => {
  server.requireApiKey = false;
  try {
    const open = await OpenSandboxBackend.create({ baseUrl, apiKey: "" });
    const status = await open.status("sandbox-1");
    assert.equal(status.backend, "opensandbox");
    assert.equal(lastRequest("/v1/sandboxes/sandbox-1")?.apiKey, undefined);
  } finally {
    server.requireApiKey = true;
  }
});

test("the sandbox lifetime is the deployment's, not the profile's idle timeout", async () => {
  const shortLived = await OpenSandboxBackend.create({
    baseUrl,
    apiKey: API_KEY,
    defaultImage: "t3x-sandbox:latest",
    defaultTimeoutSeconds: 3600,
    readyTimeoutMs: 400,
  });
  assert.equal(shortLived.lifetimeSeconds(), 3600);
  assert.equal(shortLived.lifetimeMs, 3_600_000);

  await shortLived.create(spec({ stopAfterIdleMinutes: 5 }));
  const created = [...server.requests]
    .reverse()
    .find((request) => request.method === "POST" && request.path === "/v1/sandboxes");
  const body = JSON.parse(created!.body) as { timeout: number };
  assert.equal(body.timeout, 3600, "the idle-stop minutes do not shorten the lifetime");

  // The API's own floor is 60 seconds.
  const floored = await OpenSandboxBackend.create({
    baseUrl,
    apiKey: API_KEY,
    defaultTimeoutSeconds: 1,
  });
  assert.equal(floored.lifetimeSeconds(), 60);
});

test("renew pushes a sandbox's expiry forward and answers with the new deadline", async () => {
  const handle = await backend.create(spec());
  const requested = Date.now() + 24 * 60 * 60_000;

  const expiresAt = await backend.renew(handle.id, requested);

  const renewRequest = lastRequest(`/v1/sandboxes/${handle.id}/renew-expiration`);
  assert.ok(renewRequest, "the renew request was sent");
  assert.equal(renewRequest!.method, "POST");
  assert.deepEqual(JSON.parse(renewRequest!.body), {
    expiresAt: new Date(requested).toISOString(),
  });
  assert.equal(expiresAt, Date.parse(new Date(requested).toISOString()));

  const status = await backend.status(handle.id);
  assert.equal(status.autoStopAt, expiresAt, "the status reports the renewed deadline");
});

test("create puts profile secrets into the sandbox environment, because that is the only time this API takes them", async () => {
  const handle = await backend.create(
    spec({
      env: { CI: "true" },
      secrets: [
        { name: "OPENAI_API_KEY", value: "sk-secret-value", inject: "env" },
        { name: "OTHER_TOKEN", value: "token-value", inject: "env" },
      ],
    }),
  );
  assert.match(handle.id, /^sandbox-\d+$/);

  const created = server.requests
    .filter((request) => request.method === "POST" && request.path === "/v1/sandboxes")
    .at(-1);
  assert.ok(created, "the create request was sent");
  const body = JSON.parse(created!.body) as Record<string, unknown>;
  // A dropped credential starts an agent that cannot authenticate, and the
  // failure then looks like a provider error at the first model call.
  assert.deepEqual(body.env, {
    CI: "true",
    OPENAI_API_KEY: "sk-secret-value",
    OTHER_TOKEN: "token-value",
  });
});

test("create refuses a header-injected secret instead of dropping it", async () => {
  await assert.rejects(
    () =>
      backend.create(
        spec({
          secrets: [
            { name: "GATEWAY_KEY", value: "v", inject: "headers", hostAllowlist: ["gw.example"] },
          ],
        }),
      ),
    (err: unknown) =>
      err instanceof ExecutionError &&
      err.code === "sandbox_backend_unsupported" &&
      JSON.stringify(err.details).includes("GATEWAY_KEY"),
  );
});
