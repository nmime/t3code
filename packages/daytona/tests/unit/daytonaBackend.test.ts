/**
 * DaytonaBackend against a fake client that mimics the *real* SDK surface
 * (`@daytonaio/sdk` 0.224.0), not a convenient one.
 *
 * The point of these tests is the mapping: an async-iterable `list`, `id` and
 * `state` as properties, positional `executeCommand(command, cwd, env, seconds)`,
 * `uploadFile(file, path)`, `listFiles`, `getPreviewLink`, `delete(sandbox)`
 * and credentials mounted at creation. Every one of those differs from the
 * shape the first port assumed, and a mistake in any of them is invisible
 * until the code meets the real API.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DaytonaBackend,
  loadDaytonaClient,
  type DaytonaClientLike,
  type DaytonaSdkLoader,
  type DaytonaSandboxLike,
} from "../../src/execution/daytona/DaytonaBackend.js";
import { SandboxBackendUnsupportedError } from "../../src/contracts/errors.js";
import type { SandboxSpec } from "../../src/execution/daytona/SandboxBackend.js";

interface FakeSandbox extends DaytonaSandboxLike {
  calls: Array<Record<string, unknown>>;
  deleted: boolean;
  snapshots: string[];
}

function fakeSandbox(id: string, state = "started"): FakeSandbox {
  const calls: Array<Record<string, unknown>> = [];
  const sandbox: FakeSandbox = {
    id,
    state,
    snapshot: "daytona-medium",
    cpu: 2,
    memory: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    autoStopInterval: 15,
    calls,
    deleted: false,
    snapshots: [],
    async refreshData() {
      calls.push({ op: "refreshData" });
    },
    async start() {
      calls.push({ op: "start" });
      sandbox.state = "started";
    },
    async stop() {
      calls.push({ op: "stop" });
      sandbox.state = "stopped";
    },
    async delete() {
      calls.push({ op: "delete" });
      sandbox.deleted = true;
      sandbox.state = "deleted";
    },
    async createSnapshot(name: string) {
      calls.push({ op: "createSnapshot", name });
      sandbox.snapshots.push(name);
    },
    fs: {
      async downloadFile(remotePath: string) {
        calls.push({ op: "downloadFile", remotePath });
        return Buffer.from(`contents of ${remotePath}`);
      },
      async uploadFile(file: Buffer | Uint8Array, remotePath: string) {
        calls.push({ op: "uploadFile", remotePath, body: Buffer.from(file).toString("utf8") });
        return undefined;
      },
      async listFiles(path: string) {
        calls.push({ op: "listFiles", path });
        return [
          { name: "src", isDir: true, size: 0, modifiedAt: "2026-01-02T03:04:05.000Z" },
          { name: "README.md", isDir: false, size: 42, modifiedAt: "2026-01-02T03:04:06.000Z" },
        ];
      },
    },
    process: {
      async executeCommand(
        command: string,
        cwd?: string,
        env?: Record<string, string>,
        timeout?: number,
      ) {
        calls.push({ op: "executeCommand", command, cwd, env, timeout });
        if (command.startsWith("test -f")) return { exitCode: 0, result: "present" };
        if (command.startsWith("chmod")) return { exitCode: 0, result: "" };
        return { exitCode: 0, result: `ran: ${command}` };
      },
    },
    async getPreviewLink(port: number) {
      calls.push({ op: "getPreviewLink", port });
      return { url: `https://${port}-${id}.daytonaproxy01.eu`, token: "tok-123" };
    },
  };
  return sandbox;
}

interface FakeClient extends DaytonaClientLike {
  created: Array<Record<string, unknown>>;
  sandboxes: Map<string, FakeSandbox>;
  deletedIds: string[];
  orgSecrets: Array<{ id: string; name: string; value: string; hosts: string[] }>;
  secretCreateCalls: Array<Record<string, unknown>>;
  lastListQuery?: { labels?: Record<string, string>; limit?: number };
}

function fakeClient(): FakeClient {
  const sandboxes = new Map<string, FakeSandbox>();
  const client: FakeClient = {
    created: [],
    sandboxes,
    deletedIds: [],
    orgSecrets: [],
    secretCreateCalls: [],
    async create(params) {
      client.created.push(params as Record<string, unknown>);
      const sandbox = fakeSandbox(`sbx-${client.created.length}`);
      sandboxes.set(sandbox.id, sandbox);
      return sandbox;
    },
    async get(id: string) {
      const sandbox = sandboxes.get(id);
      if (!sandbox) throw new Error(`Sandbox with ID or name ${id} not found`);
      return sandbox;
    },
    // The real SDK returns an async iterable, not an array.
    list(query) {
      client.lastListQuery = query;
      const items = [...sandboxes.values()];
      return (async function* () {
        for (const item of items) yield item;
      })();
    },
    async delete(sandbox) {
      client.deletedIds.push(sandbox.id);
      sandboxes.delete(sandbox.id);
    },
    secret: {
      async list() {
        return { items: client.orgSecrets.map(({ id, name }) => ({ id, name })), nextCursor: null };
      },
      async create(params) {
        client.secretCreateCalls.push(params as Record<string, unknown>);
        const record = {
          id: `secret-${client.orgSecrets.length + 1}`,
          name: params.name,
          value: params.value,
          hosts: params.hosts ?? [],
        };
        client.orgSecrets.push(record);
        return { id: record.id, name: record.name };
      },
      async update(id, params) {
        const record = client.orgSecrets.find((item) => item.id === id);
        if (!record) throw new Error("no such secret");
        if (params.value !== undefined) record.value = params.value;
        if (params.hosts !== undefined) record.hosts = params.hosts;
        return { id: record.id, name: record.name };
      },
    },
  } as FakeClient;
  return client;
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    taskId: "task-1",
    snapshot: "daytona-medium",
    platform: "linux/amd64",
    resources: { cpu: 4, memoryGiB: 8, diskGiB: 20 },
    env: { NODE_ENV: "development" },
    setup: [],
    workingDirectory: "/workspace/project",
    secrets: [],
    stopAfterIdleMinutes: 15,
    ...overrides,
  };
}

test("create sends a snapshot, env vars, labels and the idle interval", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  const handle = await backend.create(spec({ env: { CI: "true" } }));

  assert.equal(handle.id, "sbx-1");
  assert.equal(handle.backend, "daytona");
  const params = client.created[0]!;
  assert.equal(params["snapshot"], "daytona-medium");
  assert.deepEqual(params["envVars"], { CI: "true" });
  assert.equal(params["autoStopInterval"], 15);
  assert.deepEqual(params["labels"], {
    "t3x.task-id": "task-1",
    "t3x.managed": "true",
    "t3x.profile": "daytona-medium",
  });
  // A snapshot fixes the resources: sending them would be meaningless.
  assert.equal(params["resources"], undefined);
});

test("create from an image sends resources when no snapshot is named", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec({ snapshot: "" }));
  const params = client.created[0]!;
  assert.equal(params["snapshot"], undefined);
  assert.equal(params["image"], "daytonaio/sandbox:latest");
  assert.deepEqual(params["resources"], { cpu: 4, memory: 8, disk: 20 });
});

test("setup steps run in the sandbox working directory and fail loudly", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec({ setup: ["corepack enable"] }));
  const sandbox = client.sandboxes.get("sbx-1")!;
  const commands = sandbox.calls
    .filter((call) => call["op"] === "executeCommand")
    .map((call) => String(call["command"]));
  // The working directory has to exist before anything runs with it as cwd.
  assert.equal(commands[0], "mkdir -p '/workspace/project'");
  const run = sandbox.calls.filter((call) => call["op"] === "executeCommand")[1]!;
  assert.equal(run["command"], "corepack enable");
  assert.equal(run["cwd"], "/workspace/project");

  const failing = fakeClient();
  const failingBackend = await DaytonaBackend.create({ client: failing });
  const failingSandbox = fakeSandbox("sbx-fail");
  failingSandbox.process.executeCommand = async (command: string) =>
    command.startsWith("mkdir -p")
      ? { exitCode: 0, result: "" }
      : { exitCode: 127, result: "not found" };
  failing.sandboxes.set("sbx-fail", failingSandbox);
  failing.create = async () => failingSandbox;
  await assert.rejects(
    () => failingBackend.create(spec({ setup: ["nope"] })),
    /Setup step failed \(127\)/,
  );
});

test("environment secrets are mounted as env vars, header secrets as org secrets", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(
    spec({
      secrets: [
        { name: "NPM_TOKEN", value: "npm-secret", inject: "env" },
        {
          name: "ANTHROPIC_API_KEY",
          value: "sk-ant",
          inject: "headers",
          hostAllowlist: ["api.anthropic.com"],
        },
      ],
    }),
  );
  const params = client.created[0]!;
  assert.deepEqual(params["envVars"], { NODE_ENV: "development", NPM_TOKEN: "npm-secret" });
  // The value never enters the sandbox: only the organization secret's name.
  assert.deepEqual(params["secrets"], { ANTHROPIC_API_KEY: "t3x-ANTHROPIC_API_KEY" });
  assert.equal(client.secretCreateCalls.length, 1);
  assert.deepEqual(client.secretCreateCalls[0], {
    name: "t3x-ANTHROPIC_API_KEY",
    value: "sk-ant",
    hosts: ["api.anthropic.com"],
  });
});

test("a header secret without a host allowlist is refused, not silently dropped", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await assert.rejects(
    () => backend.create(spec({ secrets: [{ name: "TOKEN", value: "v", inject: "headers" }] })),
    /declares no hostAllowlist/,
  );
});

test("an existing organization secret is updated rather than duplicated", async () => {
  const client = fakeClient();
  client.orgSecrets.push({
    id: "secret-9",
    name: "t3x-GH_TOKEN",
    value: "old",
    hosts: ["github.com"],
  });
  const backend = await DaytonaBackend.create({ client });
  await backend.create(
    spec({
      secrets: [
        { name: "GH_TOKEN", value: "new", inject: "headers", hostAllowlist: ["github.com"] },
      ],
    }),
  );
  assert.equal(client.secretCreateCalls.length, 0);
  assert.deepEqual(client.orgSecrets[0], {
    id: "secret-9",
    name: "t3x-GH_TOKEN",
    value: "new",
    hosts: ["github.com"],
  });
});

test("exec uses positional arguments and seconds, and reports the exit code", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec());
  const result = await backend.exec("sbx-1", "git status", {
    cwd: "/workspace/project",
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 90_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ran: git status");
  const run = client.sandboxes
    .get("sbx-1")!
    .calls.filter((call) => call["op"] === "executeCommand")
    .at(-1)!;
  assert.equal(run["cwd"], "/workspace/project");
  assert.deepEqual(run["env"], { GIT_TERMINAL_PROMPT: "0" });
  assert.equal(run["timeout"], 90, "the SDK takes seconds, not milliseconds");
});

test("files move in the SDK's argument order and directories list with ISO stamps", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec());

  await backend.writeFile("sbx-1", "/workspace/project/notes.txt", Buffer.from("hello"), 0o600);
  const upload = client.sandboxes.get("sbx-1")!.calls.find((call) => call["op"] === "uploadFile")!;
  assert.equal(upload["remotePath"], "/workspace/project/notes.txt");
  assert.equal(upload["body"], "hello");

  const read = await backend.readFile("sbx-1", "/workspace/project/notes.txt");
  assert.equal(read.toString(), "contents of /workspace/project/notes.txt");

  const entries = await backend.listDir("sbx-1", "/workspace/project");
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.kind, entry.size]),
    [
      ["src", "directory", 0],
      ["README.md", "file", 42],
    ],
  );
  assert.equal(entries[1]!.modifiedAt, Date.parse("2026-01-02T03:04:06.000Z"));
  assert.equal(entries[1]!.path, "/workspace/project/README.md");
});

test("status, list, stop/start, snapshot and destroy map onto the real lifecycle", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec());

  const status = await backend.status("sbx-1");
  assert.equal(status.state, "running");
  assert.equal(status.snapshot, "daytona-medium");
  assert.deepEqual(status.resources, { cpu: 2, memoryGiB: 4 });

  const listed = await backend.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, "sbx-1");
  assert.deepEqual(client.lastListQuery, { labels: { "t3x.managed": "true" } });

  await backend.stop("sbx-1");
  assert.equal((await backend.status("sbx-1")).state, "stopped");
  await backend.start("sbx-1");
  assert.equal((await backend.status("sbx-1")).state, "running");

  const snapshot = await backend.snapshot("sbx-1", "after-setup");
  assert.deepEqual(snapshot, { id: "after-setup" });
  assert.deepEqual(client.sandboxes.get("sbx-1")!.snapshots, ["after-setup"]);

  await backend.destroy("sbx-1");
  assert.deepEqual(client.deletedIds, ["sbx-1"]);
});

test("preview links carry Daytona's token and no expiry", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec());
  const link = await backend.previewUrl("sbx-1", 5173, 600);
  assert.equal(link.url, "https://5173-sbx-1.daytonaproxy01.eu");
  assert.equal(link.token, "tok-123");
  assert.equal(link.expiresAt, null);
});

test("credentials cannot be injected into a running sandbox, and that is said out loud", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec());
  await assert.rejects(
    () => backend.injectSecrets("sbx-1", [{ name: "TOKEN", value: "v", inject: "env" }]),
    /injects credentials at sandbox creation/,
  );
  await backend.injectSecrets("sbx-1", []);
});

test("restoring a snapshot is unsupported rather than pretended", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await backend.create(spec());
  await assert.rejects(
    () => backend.restoreSnapshot("sbx-1", "some-snapshot"),
    (error: unknown) => error instanceof SandboxBackendUnsupportedError,
  );
});

test("a missing sandbox is reported as not found, not as a crash", async () => {
  const client = fakeClient();
  const backend = await DaytonaBackend.create({ client });
  await assert.rejects(() => backend.status("nope"), /Sandbox nope does not exist/);
});

test("the client is built for the deployment the configuration names", async () => {
  // A self-hosted Daytona is the same SDK against another API root, so the
  // endpoint and the region have to reach the constructor — an ignored
  // `apiUrl` would silently talk to the managed cloud instead.
  const built: Array<Record<string, unknown>> = [];
  // Only the constructor matters here: the point is what the deployment
  // configuration hands it.
  const loader: DaytonaSdkLoader = async () => ({
    Daytona: class {
      constructor(options: unknown) {
        built.push(options as Record<string, unknown>);
      }
    } as unknown as new (options: unknown) => DaytonaClientLike,
  });

  await loadDaytonaClient(
    { apiKey: "key", apiUrl: "https://daytona.example.com/api", target: "eu" },
    loader,
  );
  assert.deepEqual(built[0], {
    apiKey: "key",
    apiUrl: "https://daytona.example.com/api",
    target: "eu",
  });

  // Nothing configured: the SDK's own default (the managed cloud) applies.
  await loadDaytonaClient({ apiKey: "key" }, loader);
  assert.deepEqual(built[1], { apiKey: "key" });
});

test("a missing key is unauthorized, not a connection failure", async () => {
  const loader: DaytonaSdkLoader = async () => ({ Daytona: class {} as never });
  await assert.rejects(
    () => loadDaytonaClient({ apiKey: "" }, loader),
    /DAYTONA_API_KEY is not set/,
  );
});
