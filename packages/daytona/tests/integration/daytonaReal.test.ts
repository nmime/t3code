/**
 * The Daytona backend against the real API.
 *
 * These tests only run when `DAYTONA_API_KEY` is set and `@daytonaio/sdk`
 * resolves; otherwise the whole file reports as skipped, so the normal suite
 * stays hermetic. When it does run it creates real sandboxes and deletes them
 * again in `after`, so a failure never leaves a billable sandbox behind.
 *
 * `T3X_DAYTONA_TEST_SNAPSHOT` picks the snapshot (default `daytona-small`);
 * it must exist in the organization. `T3X_DAYTONA_TEST_REPO` optionally names
 * a repository to clone in the control-plane test.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  DAYTONA_SDK_PACKAGE,
  DaytonaBackend,
  loadDaytonaClient,
  type DaytonaClientLike,
} from "../../src/execution/daytona/DaytonaBackend.js";
import { ControlPlaneServer } from "../../src/execution/ControlPlaneServer.js";
import type { SandboxSpec } from "../../src/execution/daytona/SandboxBackend.js";

const apiKey = process.env.DAYTONA_API_KEY ?? "";
const snapshot = process.env.T3X_DAYTONA_TEST_SNAPSHOT ?? "daytona-small";

async function sdkAvailable(): Promise<boolean> {
  try {
    await import(DAYTONA_SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

const enabled = apiKey !== "" && (await sdkAvailable());
const skip = enabled ? false : "DAYTONA_API_KEY or @daytonaio/sdk is not available";

const created: Array<{ backend: DaytonaBackend; id: string }> = [];

/** The API is eventually consistent about lifecycle transitions. */
async function assertEventually(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3x-daytona-"));
}

async function realBackend(): Promise<DaytonaBackend> {
  return await DaytonaBackend.create({ apiKey, defaultAutoStopMinutes: 10 });
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    taskId: `t3x-smoke-${Date.now()}`,
    snapshot,
    platform: "linux/amd64",
    resources: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
    env: { T3X_SMOKE: "1" },
    setup: [],
    workingDirectory: "/home/daytona",
    secrets: [],
    stopAfterIdleMinutes: 10,
    ...overrides,
  };
}

after(async () => {
  for (const entry of created) {
    await entry.backend.destroy(entry.id).catch(() => undefined);
  }
});

test("the SDK loads and authenticates against the organization", { skip }, async () => {
  const client: DaytonaClientLike = await loadDaytonaClient({ apiKey });
  const backend = await DaytonaBackend.create({ client });
  const sandboxes = await backend.list();
  assert.ok(Array.isArray(sandboxes));
  for (const sandbox of sandboxes) assert.equal(sandbox.backend, "daytona");
});

test("a sandbox is created, used and destroyed through the real API", { skip }, async () => {
  const backend = await realBackend();
  const handle = await backend.create(
    spec({
      setup: [
        "mkdir -p /home/daytona/t3x-smoke",
        "echo setup-ran > /home/daytona/t3x-smoke/setup.txt",
      ],
    }),
  );
  created.push({ backend, id: handle.id });
  assert.ok(handle.id.length > 0);

  const status = await backend.status(handle.id);
  assert.equal(status.state, "running");
  assert.equal(status.snapshot, snapshot);

  const listed = await backend.list();
  assert.ok(
    listed.some((entry) => entry.id === handle.id),
    "the sandbox carries the managed label",
  );

  // Setup steps really ran inside the sandbox.
  const setup = await backend.exec(handle.id, "cat /home/daytona/t3x-smoke/setup.txt");
  assert.equal(setup.exitCode, 0);
  assert.match(setup.stdout, /setup-ran/);

  // Environment variables declared in the spec are present in the sandbox.
  const env = await backend.exec(handle.id, "echo $T3X_SMOKE");
  assert.match(env.stdout, /1/);

  // Files round-trip in both directions.
  await backend.writeFile(
    handle.id,
    "/home/daytona/t3x-smoke/note.txt",
    Buffer.from("from-control-plane"),
  );
  const read = await backend.readFile(handle.id, "/home/daytona/t3x-smoke/note.txt");
  assert.equal(read.toString(), "from-control-plane");

  const entries = await backend.listDir(handle.id, "/home/daytona/t3x-smoke");
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["note.txt", "setup.txt"]);
  assert.ok(entries.every((entry) => entry.kind === "file"));

  // A real git repository can be cloned and worked in. A tiny public repo
  // keeps the test fast; the point is that git runs inside the sandbox.
  const repo = process.env.T3X_DAYTONA_TEST_REPO ?? "https://github.com/octocat/Hello-World.git";
  const clone = await backend.exec(
    handle.id,
    `git clone --depth 1 ${repo} /home/daytona/t3x-smoke/repo 2>&1 | tail -2 && ` +
      "cd /home/daytona/t3x-smoke/repo && git rev-parse --abbrev-ref HEAD",
    { timeoutMs: 300_000 },
  );
  assert.equal(clone.exitCode, 0);
  assert.match(clone.stdout, /main|master|Hello-World/);

  const worktree = await backend.exec(
    handle.id,
    "cd /home/daytona/t3x-smoke/repo && git worktree add -b t3x/smoke /home/daytona/t3x-smoke/wt HEAD && " +
      "ls -a /home/daytona/t3x-smoke/wt | head -3",
    { timeoutMs: 180_000 },
  );
  assert.equal(worktree.exitCode, 0);

  // A port-scoped preview link is issued with a token.
  const link = await backend.previewUrl(handle.id, 5173, 600);
  assert.match(link.url, /^https:\/\//);
  assert.equal(link.expiresAt, null);

  // Stop retains the files; start brings the sandbox back.
  await backend.stop(handle.id);
  assert.equal((await backend.status(handle.id)).state, "stopped");
  await backend.start(handle.id);
  assert.equal((await backend.status(handle.id)).state, "running");
  const survived = await backend.exec(handle.id, "cat /home/daytona/t3x-smoke/note.txt");
  assert.equal(survived.stdout.trim(), "from-control-plane");

  await backend.destroy(handle.id);
  // Deletion is asynchronous: the sandbox leaves the managed listing, and if
  // it can still be read it is no longer running.
  await assertEventually(async () => {
    const remaining = await backend.list().catch(() => []);
    return !remaining.some((entry) => entry.id === handle.id);
  }, "the destroyed sandbox leaves the managed listing");
  const after = await backend.status(handle.id).catch(() => null);
  assert.ok(after === null || after.state !== "running", `state after destroy: ${after?.state}`);
  created.pop();
});

test("the control plane provisions a real sandbox, checkout and worktree", { skip }, async () => {
  const stateDir = tempStateDir();
  const backend = await realBackend();
  const server = await ControlPlaneServer.start({
    stateDir,
    port: 0,
    backend,
    autoStartEffects: false,
    // The worker cannot dial a control plane that is not reachable from the
    // sandbox; this test stops at that boundary and asserts the provisioning
    // work that happens before the dial.
    workerAttachTimeoutMs: 1_000,
  });
  let sandboxId: string | null = null;
  let taskId: string | null = null;
  try {
    server.profiles.createProfile({
      profileId: "real-daytona",
      body: {
        apiVersion: "t3-daytona/v1",
        kind: "EnvironmentProfile",
        metadata: { name: "real-daytona", version: 1 },
        runtime: {
          platform: "linux/amd64",
          snapshot,
          resources: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
        },
        project: {
          workingDirectory: "/home/daytona/project",
          setup: [],
          allowedRepositories: ["https://github.com/*"],
        },
        environment: { CI: "true" },
        agents: { allowed: ["echo"], defaults: { provider: "echo", permissionMode: "supervised" } },
        sandbox: {
          isolation: "per-project",
          maxConcurrentTasks: 2,
          stopAfterIdleMinutes: 10,
          deleteAfterCompletedHours: 1,
        },
      } as never,
    });

    const task = server.tasks.createTask({
      profileId: "real-daytona",
      repositoryUrl:
        process.env.T3X_DAYTONA_TEST_REPO ?? "https://github.com/octocat/Hello-World.git",
      branch: "master",
      provider: "echo",
      scope: "project",
    });
    taskId = task.taskId;
    sandboxId = task.sandboxId ?? null;

    // Provisioning runs as an effect. The worker launch is attempted inside the
    // sandbox and its dial cannot reach a control plane that is not reachable
    // from the sandbox, so the run ends with worker_attach_failed — which is
    // the honest outcome here, and the reason this test stops at that boundary.
    await server.effectWorker.drain(5);

    const events = server.tasks.events(task.taskId).map((event) => event.type);
    assert.ok(events.includes("task.sandbox_created"), `events: ${events.join(",")}`);
    assert.ok(events.includes("task.worktree_created"), `events: ${events.join(",")}`);
    assert.ok(events.includes("task.worker_attach_failed"), `events: ${events.join(",")}`);

    // The checkout and the task's worktree really exist inside the sandbox.
    const record = server.tasks.getTask(task.taskId);
    assert.ok(record.sandboxId, "the task is bound to a real sandbox");
    sandboxId = record.sandboxId;
    const listing = await backend.exec(record.sandboxId, "ls -a /home/daytona/project");
    assert.equal(listing.exitCode, 0);
    assert.match(listing.stdout, /README|\.git/i);
    const worktrees = await backend.exec(
      record.sandboxId,
      "git -C /home/daytona/project worktree list",
    );
    assert.match(worktrees.stdout, /t3x\//, "each task gets its own worktree and branch");
  } finally {
    if (!sandboxId && taskId) sandboxId = server.tasks.getTask(taskId).sandboxId ?? null;
    await server.stop();
    if (sandboxId) await backend.destroy(sandboxId).catch(() => undefined);
  }
});

test("the worker bundle is shipped into a real sandbox and started there", { skip }, async () => {
  const stateDir = tempStateDir();
  const backend = await realBackend();
  // Build the bundle the way `t3x worker bundle` does.
  const bundle = path.join(stateDir, "worker-bundle.tgz");
  const bundleBuild = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "dist", "src", "cli.js"), "worker", "bundle", "--out", bundle],
    { encoding: "utf8" },
  );
  assert.equal(bundleBuild.status, 0, bundleBuild.stderr);
  assert.ok(fs.existsSync(bundle));

  const server = await ControlPlaneServer.start({
    stateDir,
    port: 0,
    backend,
    autoStartEffects: false,
    workerBundle: bundle,
    // A public address is what a real deployment passes; here the sandbox
    // cannot reach it (tier-based network restrictions), so the dial fails and
    // the run ends with worker_attach_failed — after the bundle has landed and
    // the worker process has started inside the sandbox.
    publicWorkerUrl: "https://control-plane.invalid",
    workerAttachTimeoutMs: 20_000,
  });
  let sandboxId: string | null = null;
  try {
    server.profiles.createProfile({
      profileId: "real-bundle",
      body: {
        apiVersion: "t3-daytona/v1",
        kind: "EnvironmentProfile",
        metadata: { name: "real-bundle", version: 1 },
        runtime: {
          platform: "linux/amd64",
          snapshot,
          resources: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
        },
        project: {
          workingDirectory: "/home/daytona/project",
          setup: [],
          allowedRepositories: ["*"],
        },
        agents: { allowed: ["echo"], defaults: { provider: "echo" } },
        sandbox: {
          isolation: "per-task",
          maxConcurrentTasks: 1,
          stopAfterIdleMinutes: 10,
          deleteAfterCompletedHours: 1,
        },
      } as never,
    });
    const task = server.tasks.createTask({
      profileId: "real-bundle",
      repositoryUrl: "",
      provider: "echo",
      scope: "task",
    });
    await server.effectWorker.drain(5);
    const record = server.tasks.getTask(task.taskId);
    sandboxId = record.sandboxId;
    assert.ok(sandboxId, "the task got a real sandbox");

    // The worker landed where the control plane said it would.
    const entry = await backend.exec(
      sandboxId,
      "test -f /home/daytona/.t3x-worker/worker/index.js && echo present",
    );
    assert.match(entry.stdout, /present/, `worker entry missing: ${entry.stdout}`);
    const deps = await backend.exec(sandboxId, "ls /home/daytona/.t3x-worker/node_modules");
    for (const dep of ["ws", "yaml", "zod"]) assert.match(deps.stdout, new RegExp(dep));

    // And the worker process really started in the sandbox; its log says what
    // happened to the dial.
    const log = await backend.exec(sandboxId, "cat /tmp/t3x-worker.log 2>/dev/null | tail -5");
    assert.ok(log.stdout.trim().length > 0, "the worker wrote a log inside the sandbox");
    const events = server.tasks.events(task.taskId).map((event) => event.type);
    assert.ok(events.includes("task.worker_attach_failed"), `events: ${events.join(",")}`);
  } finally {
    await server.stop();
    if (sandboxId) await backend.destroy(sandboxId).catch(() => undefined);
  }
});
