/**
 * The client HTTP API and the t3x CLI, driven exactly as a Mac/phone client
 * and an operator would drive them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeAgentBinDir,
  startTestServer,
  tempStateDir,
  testProfile,
  waitFor,
} from "../helpers.js";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

async function t3x(args: string[]): Promise<unknown> {
  const { stdout } = await run("node", [cli, ...args], {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

test("CLI: profile, task, message, git and reconcile", async () => {
  const stateDir = tempStateDir();
  const profileFile = path.join(stateDir, "profile.yaml");
  fs.writeFileSync(
    profileFile,
    [
      "apiVersion: t3-daytona/v1",
      "kind: EnvironmentProfile",
      "metadata:",
      "  name: cli-profile",
      "  version: 1",
      "runtime:",
      "  snapshot: node24-dev-v3",
      "project:",
      "  workingDirectory: /workspace/project",
      "agents:",
      "  allowed: [echo]",
      "  defaults:",
      "    provider: echo",
    ].join("\n"),
  );

  const doctor = (await t3x(["doctor"])) as { checks: Array<{ name: string; ok: boolean }> };
  assert.ok(doctor.checks.every((c) => c.ok));

  const added = (await t3x([
    "profile",
    "add",
    "--id",
    "cli-profile",
    "--file",
    profileFile,
    "--state-dir",
    stateDir,
  ])) as { profileId: string; digest: string };
  assert.equal(added.profileId, "cli-profile");

  const created = (await t3x([
    "task",
    "create",
    "--profile",
    "cli-profile",
    "--provider",
    "echo",
    "--state-dir",
    stateDir,
  ])) as { task: { taskId: string; state: string } };
  assert.equal(created.task.state, "ready");

  const messaged = (await t3x([
    "task",
    "message",
    created.task.taskId,
    "implement the payment endpoint",
    "--state-dir",
    stateDir,
  ])) as { runId: string; events: Array<{ type: string }> };
  assert.ok(messaged.events.some((e) => e.type === "turn.terminal"));

  const status = (await t3x(["task", "status", created.task.taskId, "--state-dir", stateDir])) as {
    task: { state: string };
    pendingEffects: unknown[];
  };
  assert.equal(status.task.state, "ready");
  assert.equal(status.pendingEffects.length, 0);

  const list = (await t3x(["task", "list", "--state-dir", stateDir])) as Array<{
    taskId: string;
  }>;
  assert.equal(list.length, 1);

  const reconciled = (await t3x(["reconcile", "--state-dir", stateDir])) as {
    checked: number;
  };
  assert.ok(reconciled.checked >= 1);

  // Stop / resume through the CLI keeps the same sandbox.
  const stopped = (await t3x(["task", "stop", created.task.taskId, "--state-dir", stateDir])) as {
    ok: boolean;
  };
  assert.equal(stopped.ok, true);
  await t3x(["task", "resume", created.task.taskId, "--state-dir", stateDir]);
  const afterResume = (await t3x([
    "task",
    "status",
    created.task.taskId,
    "--state-dir",
    stateDir,
  ])) as { task: { state: string; resumeKind: string } };
  assert.equal(afterResume.task.state, "ready");
  assert.equal(afterResume.task.resumeKind, "resumed");

  const imported = (await t3x([
    "import-config",
    "--home",
    stateDir,
    "--name",
    "cli-bundle",
    "--state-dir",
    stateDir,
  ])) as { name: string };
  assert.equal(imported.name, "cli-bundle");
});

test("HTTP API: create, message, approvals, event replay and remote git", async () => {
  const server = await startTestServer({ stateDir: tempStateDir() });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    server.profiles.createProfile({ profileId: "http", body: testProfile() as never });

    const created = (await (
      await fetch(`${base}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "http", repositoryUrl: "", provider: "echo" }),
      })
    ).json()) as { task: { taskId: string } };
    const taskId = created.task.taskId;

    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(taskId), 30_000, "worker");

    // A message from the "Mac".
    const sent = await fetch(`${base}/tasks/${taskId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from the phone" }),
    });
    assert.equal(sent.status, 202);
    await server.effectWorker.drain();
    await waitFor(() => server.tasks.getTask(taskId).state === "ready", 15_000, "turn");

    // Event replay with a cursor, as an offline client would.
    const events = (await (await fetch(`${base}/tasks/${taskId}/events?from=0`)).json()) as {
      events: Array<{ seq: number; type: string }>;
      lastSeq: number;
    };
    assert.ok(events.events.some((e) => e.type === "turn.terminal"));
    const cursor = events.lastSeq;
    const tail = (await (await fetch(`${base}/tasks/${taskId}/events?from=${cursor}`)).json()) as {
      events: unknown[];
    };
    assert.equal(tail.events.length, 0);

    // Remote git inspection through the API.
    await fetch(`${base}/tasks/${taskId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command:
          "git init -q -b main && git config user.email a@b.c && git config user.name t && printf x > f.txt && git add -A && git commit -qm init",
      }),
    });
    const gitStatus = (await (await fetch(`${base}/tasks/${taskId}/git/status`)).json()) as {
      branch: string;
      clean: boolean;
    };
    assert.equal(gitStatus.branch, "main");
    assert.equal(gitStatus.clean, true);

    // Approvals surface over HTTP too.
    await fetch(`${base}/tasks/${taskId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "danger: drop the database" }),
    });
    await server.effectWorker.drain();
    await waitFor(() => server.tasks.getTask(taskId).state === "waiting", 15_000, "approval");
    const status = (await (await fetch(`${base}/tasks/${taskId}`)).json()) as {
      approvals: Array<{ requestId: string; status: string }>;
    };
    const pending = status.approvals.find((a) => a.status === "pending")!;
    const decided = await fetch(`${base}/tasks/${taskId}/approvals/${pending.requestId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    assert.equal(decided.status, 202);
    await server.effectWorker.drain();
    await waitFor(() => server.tasks.getTask(taskId).state === "ready", 15_000, "turn end");

    // Lifecycle over HTTP.
    assert.equal((await fetch(`${base}/tasks/${taskId}/stop`, { method: "POST" })).status, 202);
    await server.effectWorker.drain();
    assert.equal(server.tasks.getTask(taskId).state, "suspended");
    assert.equal((await fetch(`${base}/tasks/${taskId}/resume`, { method: "POST" })).status, 202);
    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(taskId), 30_000, "worker");
    assert.equal(server.tasks.getTask(taskId).state, "ready");

    // Unknown tasks are 404 with a typed error body.
    const missing = await fetch(`${base}/tasks/task_missing`);
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      "task_not_found",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP API: bearer token is required when configured", async () => {
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status, 200);

    const { HttpApi } = await import("../../src/execution/HttpApi.js");
    const api = new HttpApi({
      tasks: server.tasks,
      profiles: server.profiles,
      controlPlane: server.controlPlane,
      apiToken: "secret-token",
    });
    const unauthorized = await new Promise<number>((resolve) => {
      const req = {
        method: "GET",
        url: "/health",
        headers: {},
        on: () => undefined,
        [Symbol.asyncIterator]: async function* () {
          // no body
        },
      };
      const res = {
        writeHead: (status: number) => resolve(status),
        end: () => undefined,
      };
      void api.handler(req as never, res as never);
    });
    assert.equal(unauthorized, 401);
  } finally {
    await server.stop();
  }
});

/**
 * The turn-control surface a remote provider adapter drives: the provider-side
 * snapshot it resumes from, a live interrupt, and the typed refusals for steer.
 */
test("HTTP API: snapshot and live turn control", async () => {
  const binDir = fakeAgentBinDir(["#!/usr/bin/env bash", "sleep 30", "echo done"].join("\n"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  const server = await startTestServer({ stateDir: tempStateDir() });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (url: string, payload: unknown = {}) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    server.profiles.createProfile({ profileId: "test", body: testProfile() as never });
    const created = (await (
      await post("/tasks", { profileId: "test", provider: "codex", repositoryUrl: "" })
    ).json()) as { task: { taskId: string } };
    const taskId = created.task.taskId;
    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(taskId), 30_000, "worker");
    await waitFor(() => server.tasks.getTask(taskId).state === "ready", 15_000, "ready task");

    // A CLI agent that takes its time, so the turn can be observed running.
    // The effect worker has to run in the background: draining it would block
    // until the turn is over, which is the opposite of what this test needs.
    server.effectWorker.start();
    const sent = await post(`/tasks/${taskId}/messages`, { text: "take your time" });
    assert.equal(sent.status, 202, `message accepted (${await sent.text()})`);
    await waitFor(() => server.tasks.getTask(taskId).state === "running", 15_000, "running turn");

    // The state flips before the worker's turn event lands, so wait for it.
    await waitFor(
      () => (server.tasks.snapshot(taskId).turns as unknown[]).length === 1,
      10_000,
      "turn in snapshot",
    );
    const snapshot = (await (await fetch(`${base}/tasks/${taskId}/snapshot`)).json()) as {
      snapshot: {
        state: string;
        driver: string;
        threadId: string;
        turns: Array<{ status: string }>;
        messages: Array<{ role: string }>;
        capabilities: Array<{ driver: string; capabilities: Record<string, boolean> }>;
      };
    };
    assert.equal(snapshot.snapshot.state, "running");
    assert.equal(snapshot.snapshot.driver, "codex");
    assert.equal(snapshot.snapshot.turns.length, 1, "the running turn is in the snapshot");
    assert.equal(snapshot.snapshot.turns[0]!.status, "running");
    assert.ok(snapshot.snapshot.threadId.startsWith("thread_"));

    // What the provider can actually do travels with the snapshot, so a remote
    // client never offers a control the sandbox cannot honour.
    const codex = snapshot.snapshot.capabilities.find((c) => c.driver === "codex");
    assert.equal(codex?.capabilities.steer, false);
    assert.equal(codex?.capabilities.nativeResume, false);

    // Steering a provider that cannot steer is a typed refusal.
    const unsupported = await post(`/tasks/${taskId}/steer`, { text: "hurry up" });
    assert.equal(unsupported.status, 422);
    assert.equal(
      ((await unsupported.json()) as { error: { code: string } }).error.code,
      "capability_unsupported",
    );

    // Interrupting the live turn from a client.
    assert.equal((await post(`/tasks/${taskId}/interrupt`)).status, 202);
    await waitFor(
      () => server.tasks.getTask(taskId).state !== "running",
      15_000,
      "interrupted turn",
    );
    const events = (await (await fetch(`${base}/tasks/${taskId}/events?from=0`)).json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    assert.ok(events.events.some((e) => e.type === "turn.interrupt_requested"));
    const terminal = events.events.find((e) => e.type === "turn.terminal");
    assert.equal(
      terminal?.payload.status,
      "interrupted",
      "a user interrupt is not reported as a failure",
    );

    // With no running turn, steer and interrupt are refusals, not silent no-ops.
    for (const route of ["steer", "interrupt"]) {
      const refused = await post(`/tasks/${taskId}/${route}`, { text: "now" });
      assert.equal(refused.status, 409);
      assert.equal(
        ((await refused.json()) as { error: { code: string } }).error.code,
        "task_state_invalid",
      );
    }
  } finally {
    server.effectWorker.stop();
    process.env.PATH = originalPath;
    await server.stop();
  }
});

/** Rolling a task back restores the workspace from the checkpoint, in one call. */
test("HTTP API: checkpoint rollback restores the workspace", async () => {
  const server = await startTestServer({ stateDir: tempStateDir() });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (url: string, payload: unknown = {}) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    server.profiles.createProfile({ profileId: "test", body: testProfile() as never });
    const created = (await (
      await post("/tasks", { profileId: "test", provider: "echo", repositoryUrl: "" })
    ).json()) as { task: { taskId: string } };
    const taskId = created.task.taskId;
    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(taskId), 30_000, "worker");

    await post(`/tasks/${taskId}/exec`, {
      command:
        "git init -q -b main && git config user.email a@b.c && git config user.name t && " +
        "printf 'one\\n' > app.txt && git add -A && git commit -qm init",
    });
    await post(`/tasks/${taskId}/messages`, { text: "first turn" });
    await server.effectWorker.drain();
    await waitFor(() => server.tasks.getTask(taskId).state === "ready", 15_000, "turn");

    assert.equal((await post(`/tasks/${taskId}/checkpoints`, { checkpointId: "cp1" })).status, 202);
    await server.effectWorker.drain();

    // Change the file, then roll back through the API.
    await post(`/tasks/${taskId}/exec`, { command: "printf 'two\\n' > app.txt" });
    assert.equal((await post(`/tasks/${taskId}/checkpoints/cp1/restore`)).status, 202);
    await server.effectWorker.drain();
    const after = (await (
      await post(`/tasks/${taskId}/exec`, { command: "cat app.txt" })
    ).json()) as { output: string; exitCode: number };
    assert.equal(after.exitCode, 0);
    assert.equal(after.output.trim(), "one", "the workspace is back at the checkpoint");
  } finally {
    await server.stop();
  }
});

test("CLI: --help anywhere prints usage instead of starting a server", async () => {
  // `serve --help` used to start a control plane and hang, which is how a
  // backgrounded process with no output ended up sitting in `ps` for a day.
  const { stdout } = await run("node", [cli, "serve", "--help"], { cwd: repoRoot });
  assert.match(stdout, /t3x — T3 Code remote execution control plane/);
  assert.match(stdout, /DAYTONA_API_URL/);
});

test("CLI: doctor reports the endpoint it would use, and probes it when it can", async () => {
  const { stdout } = await run(
    "node",
    [cli, "doctor", "--daytona-api-url", "https://daytona.test/api"],
    {
      cwd: repoRoot,
      env: { ...process.env, DAYTONA_API_KEY: "" },
    },
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));
  const { checks } = JSON.parse(stdout) as {
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  };
  const url = checks.find((check) => check.name === "daytona api url");
  assert.ok(url, "doctor names the endpoint");
  assert.equal(url!.detail, "https://daytona.test/api");
  // No key, no probe: reachability is only a question a key can answer.
  assert.equal(
    checks.some((check) => check.name === "daytona reachable"),
    false,
  );
});

test("CLI: serve resolves the Daytona endpoint from the flag and the environment", async () => {
  const stateDir = tempStateDir();
  const child = spawn("node", [
    cli,
    "serve",
    "--state-dir",
    stateDir,
    "--port",
    "0",
    "--backend",
    "daytona",
    "--daytona-api-url",
    "https://daytona.test/api",
    "--daytona-target",
    "eu",
  ]);
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  // The banner is printed before the server starts serving, and the server
  // never exits on its own, so the banner is what this test waits for.
  await waitFor(() => out.includes("daytona target"), 15_000, "the serve banner");
  child.kill("SIGKILL");
  assert.match(out, /daytona api:\s+https:\/\/daytona\.test\/api/);
  assert.match(out, /daytona target: eu/);
});
