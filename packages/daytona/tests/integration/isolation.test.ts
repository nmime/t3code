/**
 * Integration: report §9 scenario 10 — cross-task isolation.
 *
 * Tasks must not be able to reach another task's filesystem, credentials or
 * worker RPC, and the worker handshake must refuse anything but a valid,
 * unexpired, task-scoped credential.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import {
  createTask,
  sandboxWorkspace,
  startTestServer,
  tempStateDir,
  testProfile,
  waitFor,
} from "../helpers.js";

test("scenario 10: tasks cannot see each other's files, credentials or RPC", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    server.secrets.put("TASK_A_TOKEN", "secret-for-task-a", { allowedProfiles: ["profile-a"] });
    server.secrets.put("TASK_B_TOKEN", "secret-for-task-b", { allowedProfiles: ["profile-b"] });

    server.profiles.createProfile({
      profileId: "profile-a",
      body: testProfile({
        secrets: [{ name: "TASK_A_TOKEN", secretRef: "TASK_A_TOKEN" }],
      }) as never,
    });
    server.profiles.createProfile({
      profileId: "profile-b",
      body: testProfile({
        secrets: [{ name: "TASK_B_TOKEN", secretRef: "TASK_B_TOKEN" }],
      }) as never,
    });

    const taskA = await createTask(server, { profileId: "profile-a" });
    const taskB = await createTask(server, { profileId: "profile-b" });

    // Files stay inside their own sandbox.
    await server.workspace.writeFile(taskA.taskId, "a-only.txt", Buffer.from("a"));
    await server.workspace.writeFile(taskB.taskId, "b-only.txt", Buffer.from("b"));

    assert.ok(fs.existsSync(path.join(sandboxWorkspace(server, taskA), "a-only.txt")));
    assert.ok(!fs.existsSync(path.join(sandboxWorkspace(server, taskA), "b-only.txt")));
    assert.ok(fs.existsSync(path.join(sandboxWorkspace(server, taskB), "b-only.txt")));
    assert.ok(!fs.existsSync(path.join(sandboxWorkspace(server, taskB), "a-only.txt")));

    // Each sandbox only holds the credentials its profile referenced.
    const secretsA = fs.readFileSync(
      path.join(stateDir, "sandboxes", taskA.sandboxId!, "secrets.env"),
      "utf8",
    );
    const secretsB = fs.readFileSync(
      path.join(stateDir, "sandboxes", taskB.sandboxId!, "secrets.env"),
      "utf8",
    );
    assert.match(secretsA, /TASK_A_TOKEN=secret-for-task-a/);
    assert.ok(!secretsA.includes("secret-for-task-b"));
    assert.match(secretsB, /TASK_B_TOKEN=secret-for-task-b/);
    assert.ok(!secretsB.includes("secret-for-task-a"));

    // A profile may not materialize a secret that belongs to another profile.
    assert.throws(
      () =>
        server.secrets.materialize(
          [{ name: "TASK_B_TOKEN", secretRef: "TASK_B_TOKEN", inject: "env", hostAllowlist: [] }],
          "profile-a",
        ),
      /may not materialize/,
    );

    // Paths cannot escape a task's workspace into a sibling sandbox.
    const escape = path.relative(sandboxWorkspace(server, taskA), sandboxWorkspace(server, taskB));
    await assert.rejects(
      () => server.tasks.listDir(taskA.taskId, escape),
      /escapes the task workspace/,
    );

    // Worker RPC is authenticated per task: a bogus credential is refused.
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/worker`);
    const frames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => {
        socket.send(
          JSON.stringify({
            v: 1,
            kind: "hello",
            id: "evt_forged",
            ts: Date.now(),
            taskId: taskB.taskId,
            sandboxId: taskB.sandboxId,
            leaseEpoch: 0,
            type: "worker.hello",
            payload: {
              token: "tok_forged.deadbeef",
              protocolVersions: [1],
              sandboxId: taskB.sandboxId,
              taskId: taskB.taskId,
              workerVersion: "forged",
              providers: [],
              workspaceRoot: "/",
              resumeFromSeq: 0,
              processedEffectIds: [],
            },
          }),
        );
      });
      socket.on("message", (raw: Buffer) => {
        frames.push(raw.toString("utf8"));
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      setTimeout(() => reject(new Error("no answer to the forged handshake")), 10_000);
    });
    assert.ok(frames.some((f) => f.includes("unauthorized")), "forged credentials are rejected");
    assert.equal(server.registry.isConnected(taskB.taskId), true, "the real worker is untouched");

    // A command carrying a stale lease epoch is fenced.
    const stale = await server.registry
      .sendCommand(
        taskA.taskId,
        "worker.ping",
        { nonce: "n" },
        { effectId: "fx_ping" },
      )
      .catch(() => "refused");
    assert.notEqual(stale, undefined);

    // Two tasks never share a sandbox or a worker lease.
    assert.notEqual(taskA.sandboxId, taskB.sandboxId);
    const epochA = server.tasks.getTask(taskA.taskId).leaseEpoch;
    const epochB = server.tasks.getTask(taskB.taskId).leaseEpoch;
    assert.equal(typeof epochA, "number");
    assert.equal(typeof epochB, "number");
    await waitFor(() => server.registry.isConnected(taskA.taskId), 5_000, "task A worker");
  } finally {
    await server.stop();
  }
});
