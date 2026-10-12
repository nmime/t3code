/**
 * Integration: report §9 scenarios 6, 7, 8 and 9.
 *
 *  6. Stop and restart a sandbox, then continue the same provider-native
 *     session where supported.
 *  7. Kill the worker and reconnect without duplicating the running turn.
 *  8. Kill the control plane and verify state recovery and reconciliation.
 *  9. Duplicate commands, expired credentials and deleted sandboxes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createTask,
  sandboxStateDir,
  sendMessage,
  startTestServer,
  tempStateDir,
  waitFor,
} from "../helpers.js";

test("scenario 6: stop and restart the sandbox, continue the native session", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);
    await sendMessage(server, task.taskId, "first turn");

    const sandboxBefore = server.tasks.getTask(task.taskId).sandboxId!;
    const stateFile = path.join(sandboxStateDir(server, sandboxBefore), "echo-runtime.json");
    const before = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      threads: Record<string, { messages: unknown[] }>;
    };
    const threadId = server.tasks.getTask(task.taskId).threadId;
    assert.equal(before.threads[threadId]!.messages.length, 2);

    // Stop: the sandbox is suspended, the worker is detached.
    server.tasks.stop(task.taskId);
    await server.effectWorker.drain();
    assert.equal(server.tasks.getTask(task.taskId).state, "suspended");
    assert.equal(server.registry.isConnected(task.taskId), false);

    // Resume: same sandbox, native session intact.
    server.tasks.resume(task.taskId);
    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker reattach");

    const resumed = server.tasks.getTask(task.taskId);
    assert.equal(resumed.state, "ready");
    assert.equal(resumed.sandboxId, sandboxBefore, "resume reuses the sandbox");
    assert.equal(resumed.resumeKind, "resumed");

    await sendMessage(server, task.taskId, "second turn");
    const after = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      threads: Record<string, { messages: unknown[] }>;
    };
    assert.equal(
      after.threads[threadId]!.messages.length,
      4,
      "the native session continued rather than restarting",
    );
  } finally {
    await server.stop();
  }
});

test("scenario 7: killing the worker reattaches without duplicating a turn", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);
    const epochBefore = server.tasks.getTask(task.taskId).leaseEpoch;

    // Kill the worker process out from under the control plane.
    server.launcher.terminate(task.taskId);
    await waitFor(() => !server.registry.isConnected(task.taskId), 15_000, "worker death");

    await server.controlPlane.reattachWorker(task.taskId);
    await waitFor(() => server.registry.isConnected(task.taskId), 15_000, "worker reattach");
    const epochAfter = server.tasks.getTask(task.taskId).leaseEpoch;
    assert.ok(epochAfter > epochBefore, "reattachment fences the previous lease");

    // A command replayed with the same effect id executes once.
    const threadId = server.tasks.getTask(task.taskId).threadId;
    await server.registry.sendCommand(
      task.taskId,
      "thread.ensure",
      {
        driver: "echo",
        threadId,
        model: "default",
        runtimePolicy: { runtimeMode: "interactive", interactionMode: "supervised", cwd: null },
      },
      { effectId: "fx_ensure" },
    );
    const payload = {
      driver: "echo",
      threadId,
      runId: "run_dup",
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: "fx_dup",
      message: {
        messageId: "msg_dup",
        text: "do not run twice",
        attachments: [],
        createdBy: "user",
        creationSource: "client",
      },
      model: "default",
      runtimePolicy: {
        runtimeMode: "interactive",
        interactionMode: "supervised",
        cwd: null,
      },
    } as const;

    const first = await server.registry.sendCommand(task.taskId, "turn.start", payload as never, {
      effectId: "fx_dup",
    });
    const second = await server.registry.sendCommand(task.taskId, "turn.start", payload as never, {
      effectId: "fx_dup",
    });
    assert.deepEqual(second, first, "the replayed command returns the recorded result");

    await waitFor(() => server.tasks.getTask(task.taskId).state !== "running", 15_000, "turn end");
    const terminals = server.tasks
      .events(task.taskId)
      .filter(
        (e) => e.type === "turn.terminal" && (e.payload as { runId?: string }).runId === "run_dup",
      );
    assert.equal(terminals.length, 1, "exactly one turn ran");

    // A duplicate command receipt in the store is a no-op as well.
    const before = server.store.eventsSince(task.taskId, 0).length;
    server.store.submitCommand({
      commandId: "cmd_dup",
      taskId: task.taskId,
      kind: "message.send",
      payload: { text: "x" },
      events: [{ type: "message.accepted", payload: { text: "x" } }],
      effects: [
        { effectId: "fx_dup_cmd", kind: "turn.start", payload: { runId: "r" }, leaseEpoch: 0 },
      ],
    });
    server.store.submitCommand({
      commandId: "cmd_dup",
      taskId: task.taskId,
      kind: "message.send",
      payload: { text: "x" },
      events: [{ type: "message.accepted", payload: { text: "x" } }],
      effects: [
        { effectId: "fx_dup_cmd", kind: "turn.start", payload: { runId: "r" }, leaseEpoch: 0 },
      ],
    });
    assert.equal(
      server.store.eventsSince(task.taskId, 0).length,
      before + 1,
      "the duplicate command added exactly one event",
    );
  } finally {
    await server.stop();
  }
});

test("scenario 8: the control plane restarts and reconciles", async () => {
  const stateDir = tempStateDir();
  const first = await startTestServer({ stateDir, port: 0 });
  const port = first.port;
  let taskId = "";
  let sandboxId = "";
  try {
    const task = await createTask(first);
    taskId = task.taskId;
    sandboxId = task.sandboxId!;
    await sendMessage(first, taskId, "before the restart");
  } finally {
    await first.stop();
  }

  // Restart on the same port and state directory, as a VPS process restart.
  const second = await startTestServer({ stateDir, port });
  try {
    const report = await second.recovery.recover();
    assert.ok(report.checked >= 1);

    const recovered = second.tasks.getTask(taskId);
    assert.equal(recovered.sandboxId, sandboxId, "the sandbox mapping survived");
    assert.ok(
      second.tasks.events(taskId).some((e) => e.type === "turn.terminal"),
      "conversation history survived",
    );

    // The worker reconnects on its own and the conversation continues.
    await waitFor(() => second.registry.isConnected(taskId), 30_000, "worker reconnect");
    assert.equal(second.tasks.getTask(taskId).state, "ready");
    await sendMessage(second, taskId, "after the restart");
    assert.ok(
      second.tasks
        .events(taskId)
        .some((e) => JSON.stringify(e.payload).includes("after the restart")),
    );

    // Stuck effects are requeued rather than stranded.
    assert.equal(second.store.pendingEffectsForTask(taskId).length, 0);
  } finally {
    await second.stop();
  }
});

test("scenario 9: expired credentials, deleted sandboxes and orphan cleanup", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);

    // Expired worker credentials are refused.
    const expired = server.controlPlane.issueWorkerToken(task.taskId, task.sandboxId!, -1_000);
    const [tokenId, secret] = expired.split(".");
    const { sha256Hex } = await import("../../src/contracts/ids.js");
    assert.equal(server.store.consumeWorkerToken(tokenId!, sha256Hex(secret!)), null);

    // A deleted sandbox is *restored*, not silently treated as resumed.
    const oldSandbox = task.sandboxId!;
    server.registry.dropConnection(task.taskId, "simulating sandbox loss");
    await server.backend.destroy(oldSandbox);

    const report = await server.controlPlane.reconcile();
    assert.ok(report.restored >= 1);
    const restored = server.tasks.getTask(task.taskId);
    assert.notEqual(restored.sandboxId, oldSandbox);
    assert.equal(restored.resumeKind, "restored");
    assert.equal(restored.state, "ready");

    // Orphan sandboxes are destroyed.
    const orphan = await server.backend.create({
      taskId: "task_orphan",
      snapshot: "node24-dev-v3",
      platform: "linux/amd64",
      resources: { cpu: 1, memoryGiB: 1, diskGiB: 5 },
      env: {},
      setup: [],
      workingDirectory: "/workspace/project",
      secrets: [],
      stopAfterIdleMinutes: 30,
    });
    const cleanup = await server.controlPlane.reconcile();
    assert.ok(cleanup.destroyedOrphans >= 1);
    await assert.rejects(() => server.backend.status(orphan.id), /does not exist/);

    // Destroying a task terminates it and its sandbox.
    server.tasks.destroy(task.taskId);
    await server.effectWorker.drain();
    assert.equal(server.tasks.getTask(task.taskId).state, "completed");
    assert.equal(server.tasks.getTask(task.taskId).sandboxId, null);
  } finally {
    await server.stop();
  }
});

test("budget policy stops a task that overspends", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server, { budgetCents: 0 });
    server.store.updateTask(task.taskId, { spentCents: 5, state: "ready", idleSince: Date.now() });

    const { policyActions } = await server.recovery.sweep();
    assert.ok(policyActions.some((a) => a.includes("budget exceeded")));
    await server.effectWorker.drain();
    assert.equal(server.tasks.getTask(task.taskId).state, "suspended");
  } finally {
    await server.stop();
  }
});
