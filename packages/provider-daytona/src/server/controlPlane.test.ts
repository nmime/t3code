/**
 * The client against a real control plane.
 *
 * `@t3tools/daytona` is in this repository, so the two halves of the boundary
 * are tested against each other rather than against a stub: a real control
 * plane process, a real sandbox directory, a real worker, and the HTTP surface
 * the provider driver consumes.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { ControlPlaneServer } from "../../../daytona/dist/src/execution/ControlPlaneServer.js";
import { ProcessWorkerLauncher } from "../../../daytona/dist/src/execution/SandboxControlPlane.js";
import { DaytonaControlPlane, DaytonaControlPlaneError } from "./controlPlane.ts";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-provider-"));
const launcher = new ProcessWorkerLauncher();
let server: Awaited<ReturnType<typeof ControlPlaneServer.start>>;
let client: DaytonaControlPlane;

const profile = {
  apiVersion: "t3-daytona/v1",
  kind: "EnvironmentProfile",
  metadata: { name: "provider-test", version: 1 },
  runtime: { snapshot: "node24-dev-v3", resources: { cpu: 2, memoryGiB: 4 } },
  project: { workingDirectory: "/workspace/project", setup: [] },
  environment: { NODE_ENV: "development" },
  agents: { allowed: ["echo", "codex"], defaults: { provider: "echo" } },
};

before(async () => {
  server = await ControlPlaneServer.start({
    stateDir,
    port: 0,
    launcher,
    autoStartEffects: false,
    workerAttachTimeoutMs: 30_000,
  });
  server.profiles.createProfile({ profileId: "provider-test", body: profile as never });
  client = new DaytonaControlPlane({
    url: `http://127.0.0.1:${server.port}`,
    token: undefined,
  });
});

after(async () => {
  await server.stop();
});

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 20_000,
  label = "condition",
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

test("a thread becomes a task, and a turn becomes a message", async () => {
  assert.equal((await client.health()).ok, true);

  const task = await client.createTask({
    profileId: "provider-test",
    provider: "echo",
    repositoryUrl: "",
  });
  assert.ok(task.taskId.startsWith("task_"));
  assert.equal(task.state, "pending");

  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker attach");
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "ready");

  // The task is findable by the thread id a client already holds.
  const found = await client.findTaskByThread(task.threadId);
  assert.equal(found?.taskId, task.taskId);

  // A turn is a message, and the snapshot is what a client resumes from.
  const { runId } = await client.sendMessage(task.taskId, "hello from T3");
  assert.ok(runId.startsWith("run_"));
  await server.effectWorker.drain();
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "turn end");

  const snapshot = await client.snapshot(task.taskId);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.driver, "echo");
  assert.ok(snapshot.providerThreadId?.startsWith("echo_thread_"));
  assert.equal(snapshot.messages[0]?.role, "user", "the user's own message comes first");
  assert.equal(snapshot.messages[0]?.text, "hello from T3");
  const assistant = snapshot.messages.filter((message) => message.role === "assistant");
  assert.ok(assistant.length >= 1, "the agent's reply is in the snapshot");
  assert.ok(
    assistant.some((message) => /hello from T3/.test(message.text)),
    "the reply answers the message",
  );
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.ok(snapshot.capabilities.some((entry) => entry.driver === "echo"));
});

test("the event stream carries the turn from start to terminal", async () => {
  const task = await client.createTask({
    profileId: "provider-test",
    provider: "echo",
    repositoryUrl: "",
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker attach");
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "ready");

  const collected: string[] = [];
  const controller = new AbortController();
  const stream = (async () => {
    for await (const event of client.events(task.taskId, 0, controller.signal)) {
      collected.push(event.type);
      if (event.type === "turn.terminal") break;
    }
  })();

  await client.sendMessage(task.taskId, "stream me");
  await server.effectWorker.drain();
  await waitFor(() => collected.includes("turn.terminal"), 20_000, "terminal event");
  controller.abort();
  await stream.catch(() => undefined);

  assert.ok(collected.includes("message.accepted"));
  assert.ok(collected.includes("turn.updated"));
  assert.ok(collected.includes("message.updated"));
  assert.ok(collected.includes("turn.terminal"));
});

test("an approval parks the turn and the client answers it", async () => {
  const task = await client.createTask({
    profileId: "provider-test",
    provider: "echo",
    repositoryUrl: "",
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker attach");
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "ready");

  await client.sendMessage(task.taskId, "danger: drop the database");
  await server.effectWorker.drain();
  await waitFor(() => server.tasks.getTask(task.taskId).state === "waiting", 15_000, "approval");

  const snapshot = await client.snapshot(task.taskId);
  const pending = snapshot.runtimeRequests.find((request) => request.status === "pending");
  assert.ok(pending, "the runtime request is in the snapshot");
  assert.equal(pending?.kind, "approval");

  await client.respondToApproval(task.taskId, pending!.requestId, "approved");
  await server.effectWorker.drain();
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "turn end");
  const after = await client.snapshot(task.taskId);
  assert.equal(
    after.runtimeRequests.find((request) => request.requestId === pending!.requestId)?.status,
    "resolved",
  );
});

test("checkpoints roll back through the client", async () => {
  const task = await client.createTask({
    profileId: "provider-test",
    provider: "echo",
    repositoryUrl: "",
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker attach");
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "ready");

  await client.exec(
    task.taskId,
    "git init -q -b main && git config user.email a@b.c && git config user.name t && " +
      "printf 'one\\n' > app.txt && git add -A && git commit -qm init",
  );
  await client.captureCheckpoint(task.taskId, "cp1", "before the change");
  await server.effectWorker.drain();

  await client.exec(task.taskId, "printf 'two\\n' > app.txt");
  await client.rollback(task.taskId, "cp1");
  await server.effectWorker.drain();
  const restored = await client.exec(task.taskId, "cat app.txt");
  assert.equal(restored.output.trim(), "one");

  const checkpoints = (await client.snapshot(task.taskId)).checkpoints;
  assert.ok(checkpoints.some((checkpoint) => checkpoint.checkpointId === "cp1"));
});

test("a control-plane refusal keeps its typed code", async () => {
  const task = await client.createTask({
    profileId: "provider-test",
    provider: "codex",
    repositoryUrl: "",
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker attach");
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "ready");

  // Nothing is running, so steering has no turn to address.
  await assert.rejects(
    () => client.steer(task.taskId, "hurry"),
    (error: Error) => /no running turn/.test(error.message),
  );
  await assert.rejects(
    () => client.status("task_missing"),
    (error: Error) => {
      assert.ok(error instanceof DaytonaControlPlaneError);
      assert.equal(error.code, "task_not_found");
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test("the sandbox is a real git worktree when the task is project-scoped", async () => {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-origin-"));
  const run = (command: string) =>
    spawnSync("bash", ["-c", command], { cwd: origin, encoding: "utf8" });
  run("git init -q -b main");
  run("git config user.email a@b.c");
  run("git config user.name t");
  fs.writeFileSync(path.join(origin, "README.md"), "# shared\n");
  run("git add -A && git commit -qm init");

  const first = await client.createTask({
    profileId: "provider-test",
    provider: "echo",
    repositoryUrl: origin,
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(first.taskId), 30_000, "worker attach");
  const second = await client.createTask({
    profileId: "provider-test",
    provider: "echo",
    repositoryUrl: origin,
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(second.taskId), 30_000, "worker attach");

  const statusA = await client.status(first.taskId);
  const statusB = await client.status(second.taskId);
  assert.equal(statusA.task.sandboxId, statusB.task.sandboxId, "one sandbox per project");
  assert.notEqual(statusA.worktreePath, statusB.worktreePath, "one worktree per task");
  assert.equal(statusA.task.sandboxScope, "project");
});
