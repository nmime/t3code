/**
 * The client-facing contract of the HTTP API.
 *
 * These are the guarantees a Mac or phone client depends on, and each of them
 * was found to be untrue at some point while running the control plane against
 * real sandboxes:
 *
 *  - a stop that the control plane will refuse must not answer "ok";
 *  - an idempotency conflict must be a 409, not a generic 400;
 *  - a text generation must not appear in the task's event log, because it is
 *    not a turn and the log is the thread's replay stream.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask, localOriginRepo, startTestServer, tempStateDir, waitFor } from "../helpers.js";
import { statusForErrorCode } from "../../src/execution/HttpApi.js";

async function call(
  server: { port: number },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("stop is refused with 409 while a task is bound, and allowed after it lets go", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const task = await createTask(server, { repositoryUrl: origin.url });
    const sandboxId = task.sandboxId!;

    const refused = await call(server, "POST", `/sandboxes/${sandboxId}/stop`);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    const error = refused.body["error"] as { code: string; details: { taskCount: number } };
    assert.equal(error.code, "sandbox_stop_refused");
    assert.equal(error.details.taskCount, 1);
    // ...and nothing actually happened to the sandbox.
    assert.equal(server.projects.getSandbox(sandboxId)!.state, "running");
    assert.ok(
      server.store.eventsSince(sandboxId, 0).some((event) => event.type === "sandbox.stop_refused"),
      "the refusal is recorded",
    );

    await call(server, "POST", `/tasks/${task.taskId}/stop`);
    await server.effectWorker.drain();
    await waitFor(() => server.projects.taskCount(sandboxId) === 0, 15_000, "refcount to drop");

    const accepted = await call(server, "POST", `/sandboxes/${sandboxId}/stop`);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    await server.effectWorker.drain();
    await waitFor(
      () => server.projects.getSandbox(sandboxId)!.state === "stopped",
      15_000,
      "the sandbox to stop",
    );
  } finally {
    await server.stop();
  }
});

test("a stop for an unknown sandbox is a 404, not a refusal", async () => {
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const response = await call(server, "POST", "/sandboxes/sbox_nope/stop");
    assert.equal(response.status, 404);
    assert.equal((response.body["error"] as { code: string }).code, "sandbox_not_found");
  } finally {
    await server.stop();
  }
});

test("a thread that already has a task is a 409 conflict", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const source = await createTask(server, { repositoryUrl: origin.url });
    const threadId = "thread_client_fork";
    const first = await call(server, "POST", `/tasks/${source.taskId}/fork`, { threadId });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await call(server, "POST", `/tasks/${source.taskId}/fork`, { threadId });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal((second.body["error"] as { code: string }).code, "idempotency_conflict");
  } finally {
    await server.stop();
  }
});

test("a text generation leaves the task's event log untouched", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const task = await createTask(server, { repositoryUrl: origin.url });
    const before = server.tasks.events(task.taskId).map((event) => event.type);

    const generated = await call(server, "POST", "/text-generation", {
      cwd: task.worktreePath,
      prompt: "summarise the repository",
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.equal(typeof generated.body["text"], "string");

    const after = server.tasks.events(task.taskId).map((event) => event.type);
    assert.deepEqual(after, before, "a generation is not a turn and must not be logged as one");
  } finally {
    await server.stop();
  }
});

test("a generation is resolved by thread, and waits for the task it names", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const threadId = "thread_title_of_a_brand_new_thread";
    // The app asks for a thread title at the moment the thread's first message
    // creates its task, and the path it sends is its own checkout — which no
    // task owns. Naming the thread is what makes it land; the wait covers the
    // race with the task's creation.
    const pending = call(server, "POST", "/text-generation", {
      cwd: "/srv/t3-workspace",
      threadId,
      prompt: "title this thread",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const task = await createTask(server, { repositoryUrl: origin.url, threadId });

    const generated = await pending;
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.equal(typeof generated.body["text"], "string");
    assert.equal(
      server.tasks.events(task.taskId).filter((event) => event.type === "turn.updated").length,
      0,
      "the generation is still not a turn",
    );

    // A path no task owns, with no thread that has one, is still refused.
    const refused = await call(server, "POST", "/text-generation", {
      cwd: "/srv/t3-workspace",
      threadId: "thread_without_a_task",
      prompt: "hello",
    });
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    assert.equal((refused.body["error"] as { code: string }).code, "task_not_found");
  } finally {
    await server.stop();
  }
});

test("error codes map to statuses a client can branch on", () => {
  assert.equal(statusForErrorCode("task_not_found"), 404);
  assert.equal(statusForErrorCode("idempotency_conflict"), 409);
  assert.equal(statusForErrorCode("capability_unsupported"), 422);
  assert.equal(statusForErrorCode("unauthorized"), 401);
  assert.equal(statusForErrorCode("secret_policy_violation"), 403);
  assert.equal(statusForErrorCode("worker_unavailable"), 503);
  assert.equal(statusForErrorCode("something_new"), 400);
});
