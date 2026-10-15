/**
 * Integration: the report's §9 scenarios 1, 3 and 4.
 *
 *  1. Create separate OpenSandbox tasks for Codex, Claude and OpenCode.
 *  3. Start on Mac, disconnect it, continue on Android, then reconnect the Mac
 *     to the same conversation.
 *  4. Interrupt, approve and resume tasks remotely.
 *
 * Everything here runs against real worker child processes over real
 * WebSockets and real sandbox directory trees.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createTask,
  fakeAgentBinDir,
  sendMessage,
  startTestServer,
  tempStateDir,
  testProfile,
  waitFor,
} from "../helpers.js";

test("scenario 1: separate sandboxes for different providers", async () => {
  const stateDir = tempStateDir();
  const binDir = fakeAgentBinDir(
    [
      "#!/usr/bin/env bash",
      'echo "codex agent running in $PWD"',
      // The argv the runtime hands the CLI, so a test can assert the flags a
      // real codex needs (`--skip-git-repo-check`) actually travel.
      'echo "codex argv: $*"',
      "echo done",
    ].join("\n"),
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  const server = await startTestServer({ stateDir });
  try {
    server.profiles.createProfile({ profileId: "multi", body: testProfile() as never });

    const echoTask = await createTask(server, { profileId: "multi", provider: "echo" });
    const codexTask = await createTask(server, { profileId: "multi", provider: "codex" });
    const claudeTask = await createTask(server, { profileId: "multi", provider: "claude" });

    // One sandbox per task, and no two tasks share one.
    const sandboxes = new Set([echoTask.sandboxId, codexTask.sandboxId, claudeTask.sandboxId]);
    assert.equal(sandboxes.size, 3);
    assert.ok([echoTask, codexTask, claudeTask].every((t) => t.state === "ready"));

    // Each worker advertises its provider inventory with capability flags.
    const echoProviders = server.registry.providersFor(echoTask.taskId);
    assert.ok(echoProviders.some((p) => p.driver === "echo"));
    const claudeProviders = server.registry.providersFor(claudeTask.taskId);
    const claudeCapabilities = claudeProviders.find((p) => p.driver === "claude")!.capabilities;
    assert.equal(claudeCapabilities.rollback, false, "CLI agents do not support rollback");

    // The echo provider answers a turn.
    await sendMessage(server, echoTask.taskId, "hello from mac");
    const echoEvents = server.tasks.events(echoTask.taskId);
    const assistant = echoEvents.filter((e) => e.type === "message.updated");
    assert.ok(assistant.length >= 2, "streamed assistant chunks arrive");
    assert.ok(echoEvents.some((e) => e.type === "turn.terminal"));

    // The codex CLI runtime runs a real process inside its own sandbox.
    await sendMessage(server, codexTask.taskId, "summarise the repository");
    const codexEvents = server.tasks.events(codexTask.taskId);
    assert.ok(
      codexEvents.some(
        (e) =>
          e.type === "message.updated" && JSON.stringify(e.payload).includes("codex agent running"),
      ),
      "CLI output is normalized into provider events",
    );
    assert.ok(codexEvents.some((e) => e.type === "turn.terminal"));

    // codex refuses to run outside a repository it trusts ("Not inside a
    // trusted directory and --skip-git-repo-check was not specified") and a
    // scratch task has no repository, so the flag has to be in the argv.
    assert.ok(
      codexEvents.some(
        (e) =>
          e.type === "message.updated" &&
          JSON.stringify(e.payload).includes("codex argv: exec --skip-git-repo-check"),
      ),
      "the codex CLI is invoked with --skip-git-repo-check",
    );
    // Provider selection did not leak across tasks.
    assert.ok(
      !server.tasks
        .events(echoTask.taskId)
        .some((e) => JSON.stringify(e.payload).includes("codex agent running")),
    );
  } finally {
    await server.stop();
    process.env.PATH = originalPath;
  }
});

test("scenario 3: Mac disconnects, phone continues, Mac reconnects", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);

    await sendMessage(server, task.taskId, "first turn from the mac");
    const macCursor = server.tasks.events(task.taskId).at(-1)!.seq;

    // The Mac goes away; the phone starts from where it left off.
    await sendMessage(server, task.taskId, "second turn from the phone");
    const phoneEvents = server.tasks.events(task.taskId, macCursor);
    assert.ok(phoneEvents.length > 0);
    assert.ok(
      phoneEvents.every((e) => e.seq > macCursor),
      "replay is strictly after the cursor",
    );
    assert.ok(
      phoneEvents.some((e) => JSON.stringify(e.payload).includes("second turn from the phone")),
    );

    // The Mac reconnects and replays from its own cursor without duplicates.
    const replay = server.tasks.events(task.taskId, 0);
    const seqs = replay.map((e) => e.seq);
    assert.deepEqual(
      seqs,
      [...new Set(seqs)].sort((a, b) => a - b),
      "event sequence is monotonic",
    );
    assert.equal(replay.at(-1)!.seq, server.tasks.getTask(task.taskId).lastEventSequence);

    // The task survived the client disconnect: same sandbox, same session.
    const status = server.tasks.status(task.taskId) as { task: { sandboxId: string } };
    assert.equal(status.task.sandboxId, task.sandboxId);
  } finally {
    await server.stop();
  }
});

test("scenario 4: interrupt, approve and resume remotely", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);

    // A privileged message opens a pending approval and parks the task.
    server.tasks.sendMessage(task.taskId, { text: "danger: rm -rf /workspace/tmp" });
    await server.effectWorker.drain();
    await waitFor(() => server.tasks.getTask(task.taskId).state === "waiting", 15_000, "approval");

    const status = server.tasks.status(task.taskId) as {
      approvals: Array<{ requestId: string; status: string }>;
    };
    const pending = status.approvals.find((a) => a.status === "pending");
    assert.ok(pending, "the approval is visible to clients");

    // Approving from a remote client resumes and finishes the turn.
    server.tasks.respondToApproval(task.taskId, pending!.requestId, "approved");
    await server.effectWorker.drain();
    await waitFor(
      () => server.tasks.getTask(task.taskId).state === "ready",
      15_000,
      "turn to finish",
    );

    const events = server.tasks.events(task.taskId);
    assert.ok(events.some((e) => e.type === "approval.resolved"));
    assert.ok(
      events.some((e) => e.type === "turn.terminal" && e.payload.status === "completed"),
      "approval resumes the turn to completion",
    );

    // Interrupting a running turn is possible while the task is running.
    const interruptTask = await createTask(server, { profileId: "test" });
    const threadId = server.tasks.getTask(interruptTask.taskId).threadId;
    await server.registry.sendCommand(
      interruptTask.taskId,
      "turn.interrupt",
      { driver: "echo", threadId, runId: "run_interrupt", providerTurnId: "turn_x" },
      { effectId: "fx_interrupt_1" },
    );
    // A second send with the same effect id is deduplicated by the worker.
    await server.registry.sendCommand(
      interruptTask.taskId,
      "turn.interrupt",
      { driver: "echo", threadId, runId: "run_interrupt", providerTurnId: "turn_x" },
      { effectId: "fx_interrupt_1" },
    );
  } finally {
    await server.stop();
  }
});

test("a message to a suspended task wakes it, in the order it queued", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);
    await sendMessage(server, task.taskId, "first turn");
    const sandboxId = server.tasks.getTask(task.taskId).sandboxId;

    // What the idle policy does: pause the sandbox, suspend the task.
    server.tasks.stop(task.taskId);
    await server.effectWorker.drain();
    assert.equal(server.tasks.getTask(task.taskId).state, "suspended");

    // The message is accepted. A client does not have to resume the task first,
    // and must not be told `task does not accept messages`: the wake is queued
    // *ahead of* the turn, so the worker brings the task back before it hands it
    // the turn.
    server.tasks.sendMessage(task.taskId, { text: "after an idle stop" });
    assert.deepEqual(
      server.store.pendingEffectsForTask(task.taskId).map((effect) => effect.kind),
      ["task.ensure_ready", "turn.start"],
      "the wake runs first, the turn second",
    );

    await server.effectWorker.drain();
    await waitFor(
      () => server.tasks.getTask(task.taskId).state === "ready",
      15_000,
      "the turn to finish",
    );

    const events = server.tasks.events(task.taskId);
    assert.ok(
      events.some((e) => e.type === "task.wake_requested" && e.payload.state === "suspended"),
      "the task's own history says why it came back",
    );
    assert.ok(
      events.some((e) => e.type === "turn.terminal" && e.payload.status === "completed"),
      "the turn ran on the woken task",
    );
    assert.equal(
      server.tasks.getTask(task.taskId).sandboxId,
      sandboxId,
      "the resume kept the sandbox it had",
    );
  } finally {
    await server.stop();
  }
});

test("a message to a ready task whose worker is gone reattaches it first", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);
    const sandboxId = server.tasks.getTask(task.taskId).sandboxId;

    // The sandbox is up, the task reads `ready`, and nothing is listening in
    // it: the worker process died. A turn dispatched into that socket would
    // fail; the message has to reattach first.
    server.registry.dropSandboxConnection(sandboxId!, "worker died");
    assert.equal(server.tasks.getTask(task.taskId).state, "ready");
    assert.equal(server.registry.isConnected(task.taskId), false);

    server.tasks.sendMessage(task.taskId, { text: "anyone there?" });
    assert.deepEqual(
      server.store.pendingEffectsForTask(task.taskId).map((effect) => effect.kind),
      ["task.ensure_ready", "turn.start"],
      "the reattach is queued ahead of the turn",
    );

    await server.effectWorker.drain();
    await waitFor(
      () => server.tasks.getTask(task.taskId).state === "ready",
      30_000,
      "the turn to finish",
    );
    assert.equal(server.registry.isConnected(task.taskId), true, "the worker is back");
    assert.ok(
      server.tasks
        .events(task.taskId)
        .some((e) => e.type === "turn.terminal" && e.payload.status === "completed"),
      "the turn ran on the reattached worker",
    );
    assert.equal(server.tasks.getTask(task.taskId).sandboxId, sandboxId);
  } finally {
    await server.stop();
  }
});

test("a message to a terminal task is still refused", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);
    // `failed` is terminal: reviving it is `task.restore`, a separate decision,
    // not something a message decides on its own.
    server.store.updateTask(task.taskId, { state: "failed" });
    assert.throws(
      () => server.tasks.sendMessage(task.taskId, { text: "into the void" }),
      /task does not accept messages/,
    );
  } finally {
    await server.stop();
  }
});

test("unsupported provider capabilities are refused, not faked", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server, { provider: "claude" });
    const { RemoteProviderAdapter } =
      await import("../../src/orchestration-v2/RemoteProviderAdapter.js");
    const adapter = new RemoteProviderAdapter({
      driver: "claude",
      taskId: task.taskId,
      store: server.store,
      registry: server.registry,
    });
    assert.equal(adapter.capabilities().steer, false);
    await assert.rejects(
      () => adapter.steer({ threadId: "t", runId: "r", providerTurnId: "p", text: "x" }),
      /does not support steer/,
    );
    adapter.close();

    // The echo provider does support rollback and fork.
    const echoTask = await createTask(server);
    const echoAdapter = new RemoteProviderAdapter({
      driver: "echo",
      taskId: echoTask.taskId,
      store: server.store,
      registry: server.registry,
    });
    assert.equal(echoAdapter.capabilities().rollback, true);
    echoAdapter.close();
  } finally {
    await server.stop();
  }
});

test("sandbox preview URLs are signed and expiring", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    const task = await createTask(server);
    const link = await server.backend.previewUrl(task.sandboxId!, 5173, 600);
    assert.match(link.url, /t3x-preview=[0-9a-f]{32}/);
    assert.match(link.url, /exp=\d+/);
    assert.equal(link.token, null);
    assert.ok((link.expiresAt ?? 0) > Math.floor(Date.now() / 1000));
    assert.ok(fs.existsSync(path.join(stateDir, "sandboxes")));
  } finally {
    await server.stop();
  }
});

test("a CLI agent gets a closed stdin, so it cannot wait for input that never comes", async () => {
  const stateDir = tempStateDir();
  // `read` returns on data or on EOF. With an open pipe and no writer it never
  // returns — which is exactly what `codex exec` did inside a real sandbox: it
  // printed "Reading additional input from stdin..." and the turn hung until
  // it was interrupted. The prompt is an argument; nothing here is interactive.
  const binDir = fakeAgentBinDir(
    [
      "#!/usr/bin/env bash",
      'if read -r line; then echo "agent read: $line"; else echo "agent saw EOF on stdin"; fi',
      "echo agent-finished",
    ].join("\n"),
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  const server = await startTestServer({ stateDir });
  try {
    server.profiles.createProfile({ profileId: "stdin", body: testProfile() as never });
    const task = await createTask(server, { profileId: "stdin", provider: "codex" });
    await sendMessage(server, task.taskId, "hello");
    await waitFor(
      () => server.tasks.events(task.taskId).some((e) => e.type === "turn.terminal"),
      20_000,
      "the turn ended instead of waiting on stdin",
    );
    const events = server.tasks.events(task.taskId);
    assert.ok(
      events.some((e) => JSON.stringify(e.payload).includes("agent saw EOF on stdin")),
      "the agent read EOF rather than blocking forever",
    );
    assert.ok(events.some((e) => JSON.stringify(e.payload).includes("agent-finished")));

    // The assistant stream has to be closed before the turn's outcome. T3's
    // mapper keeps the turn item `running` until an update arrives with
    // `streaming: false`, and a running item is not rendered — so a CLI turn
    // that ended with an open stream showed the user nothing at all.
    const updates = events.filter((e) => e.type === "message.updated");
    const last = JSON.parse(JSON.stringify(updates[updates.length - 1]!.payload)) as {
      message: { streaming: boolean; text: string };
    };
    assert.equal(last.message.streaming, false, "the assistant message is closed");
    assert.equal(last.message.text, "", "the closing update carries no text of its own");
    assert.ok(
      events.findIndex((e) => e.type === "turn.terminal") >
        events.indexOf(updates[updates.length - 1]!),
      "the message is closed before turn.terminal",
    );
  } finally {
    await server.stop();
    process.env.PATH = originalPath;
  }
});
