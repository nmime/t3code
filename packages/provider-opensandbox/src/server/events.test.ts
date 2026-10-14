/**
 * The translation from control-plane events to T3 provider events.
 *
 * These are the mappings that make a turn *land*: T3 routes a provider event to
 * the run it is executing, and drops anything addressed to a run, an attempt or
 * a provider thread it does not know. Every case below is a bug that was found
 * by running the adapter through T3's real ingestor — a mapped message or turn
 * that decoded fine and then vanished because it named the wrong identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderDriverKind, ProviderSessionId } from "@t3tools/contracts";

import { ProviderEventMapper, type MapperContext } from "./events.ts";

const DRIVER = ProviderDriverKind.make("opensandbox");
const SESSION = ProviderSessionId.make("provider-session:test");

/** A context that knows the run T3 started, as the adapter's does. */
const context = (overrides: Partial<MapperContext> = {}): MapperContext => ({
  driver: DRIVER,
  instanceId: "opensandbox_test",
  providerSessionId: SESSION,
  appThreadId: "thread:app",
  cwd: "/workspace/project",
  capabilities: {
    models: { list: [], default: null },
    sessions: { supportsMultipleProviderThreadsPerSession: false },
    threads: { canForkThread: false },
    turns: { canSteer: false, canInterrupt: false, supportsRuntimeRequests: false },
  } as never,
  runContext: () => ({
    providerTurnId: "turn_cp",
    nodeId: "node:root" as never,
    runId: "run:app",
    attemptId: "attempt:app",
  }),
  providerThreadId: () => null,
  ...overrides,
});

const event = (type: string, payload: Record<string, unknown>, seq = 1) => ({
  seq,
  eventId: `evt_${seq}`,
  taskId: "task_1",
  stream: "task",
  type,
  payload,
  ts: 1_700_000_000_000,
});

test("an assistant chunk is addressed to T3's run, not the control plane's", () => {
  const mapper = new ProviderEventMapper(context());
  const [mapped] = mapper.map(
    event("message.updated", {
      runId: "run_cp",
      message: { messageId: "m1", role: "assistant", text: "hello" },
    }),
  );
  assert.equal(mapped?.type, "message.updated");
  const message = (mapped as { message: { runId: string; id: string } }).message;
  assert.equal(message.runId, "run:app", "T3 owns the run; the sandbox's id is not it");
  assert.equal(message.id, "m1");
});

test("the user's own message is not echoed back into T3", () => {
  const mapper = new ProviderEventMapper(context());
  const mapped = mapper.map(
    event("message.updated", {
      runId: "run_cp",
      message: { messageId: "user_1", role: "user", text: "hello" },
    }),
  );
  assert.deepEqual(mapped, [], "the app thread already holds the user's message");
});

test("an assistant chunk also lands as a transcript item, which is what the UI renders", () => {
  const mapper = new ProviderEventMapper(context());
  const mapped = mapper.map(
    event("message.updated", {
      runId: "run_cp",
      message: { messageId: "m1", role: "assistant", text: "hello", streaming: true },
    }),
  );
  const item = mapped.find((candidate) => candidate.type === "turn_item.updated");
  assert.ok(item, "a message alone reaches the projection and never the transcript");
  const turnItem = (
    item as {
      turnItem: {
        id: string;
        type: string;
        messageId: string;
        text: string;
        runId: string;
        status: string;
      };
    }
  ).turnItem;
  assert.equal(turnItem.type, "assistant_message");
  assert.equal(turnItem.messageId, "m1");
  assert.equal(turnItem.text, "hello");
  assert.equal(turnItem.runId, "run:app");
  assert.equal(turnItem.status, "running", "the reply is still streaming");

  // The next chunk updates that same item rather than appending another.
  const second = mapper.map(
    event(
      "message.updated",
      {
        runId: "run_cp",
        message: { messageId: "m1", role: "assistant", text: " there", streaming: false },
      },
      2,
    ),
  );
  const secondItem = (
    second.find((candidate) => candidate.type === "turn_item.updated") as {
      turnItem: { id: string; text: string; status: string };
    }
  ).turnItem;
  assert.equal(secondItem.id, turnItem.id, "one item per reply, updated in place");
  assert.equal(secondItem.text, "hello there");
  assert.equal(secondItem.status, "completed", "the last chunk closes the item");
});

test("a turn carries the attempt T3 started, so it is the root turn", () => {
  const mapper = new ProviderEventMapper(context());
  const [mapped] = mapper.map(
    event("turn.updated", {
      runId: "run_cp",
      providerTurn: { providerTurnId: "turn_cp", runId: "run_cp", status: "running" },
    }),
  );
  assert.equal(mapped?.type, "provider_turn.updated");
  const turn = (mapped as { providerTurn: { runAttemptId: string; nodeId: string } }).providerTurn;
  assert.equal(turn.runAttemptId, "attempt:app");
  assert.equal(turn.nodeId, "node:root");
});

test("a finished turn is closed in T3's projection, not only in the run", () => {
  const mapper = new ProviderEventMapper(context());
  mapper.map(
    event(
      "turn.updated",
      { runId: "run_cp", providerTurn: { providerTurnId: "turn_cp", runId: "run_cp" } },
      1,
    ),
  );
  const mapped = mapper.map(
    event("turn.terminal", { runId: "run_cp", providerTurnId: "turn_cp", status: "completed" }, 2),
  );
  assert.equal(mapped.length, 2, "the turn ends and the run ends");
  const [turn, terminal] = mapped as Array<{
    type: string;
    providerTurn?: { id: string; status: string; completedAt: unknown };
    status?: string;
  }>;
  // Without this first event T3's row for the turn keeps the `running` it was
  // created with: `turn.terminal` ends the run, not the turn.
  assert.equal(turn?.type, "provider_turn.updated");
  assert.equal(turn?.providerTurn?.id, "turn_cp");
  assert.equal(turn?.providerTurn?.status, "completed");
  assert.ok(turn?.providerTurn?.completedAt, "a finished turn has an end time");
  assert.equal(terminal?.type, "turn.terminal");
  assert.equal(terminal?.status, "completed");
});

test("a failed turn is closed as failed", () => {
  const mapper = new ProviderEventMapper(context());
  mapper.map(
    event(
      "turn.updated",
      { runId: "run_cp", providerTurn: { providerTurnId: "turn_cp", runId: "run_cp" } },
      1,
    ),
  );
  const [turn, terminal] = mapper.map(
    event(
      "turn.terminal",
      {
        runId: "run_cp",
        providerTurnId: "turn_cp",
        status: "failed",
        failure: { message: "nope" },
      },
      2,
    ),
  ) as Array<{ type: string; providerTurn?: { status: string }; status?: string }>;
  assert.equal(turn?.type, "provider_turn.updated");
  assert.equal(turn?.providerTurn?.status, "failed");
  assert.equal(terminal?.type, "turn.terminal");
  assert.equal(terminal?.status, "failed");
});

test("a thread keeps the identity T3 holds and reports the worker's as native", () => {
  const mapper = new ProviderEventMapper(
    context({ providerThreadId: () => "provider-thread:row" }),
  );
  const [mapped] = mapper.map(
    event("thread.updated", { providerThread: { providerThreadId: "echo_thread:app" } }),
  );
  const thread = (
    mapped as { providerThread: { id: string; nativeThreadRef: { nativeId: string } } }
  ).providerThread;
  assert.equal(thread.id, "provider-thread:row", "T3's row, adopted — not a second row");
  assert.equal(thread.nativeThreadRef.nativeId, "echo_thread:app");
});

test("a turn with no known app run is addressed to the thread, not to a foreign run", () => {
  const mapper = new ProviderEventMapper(context({ runContext: () => ({}) }));
  const [mapped] = mapper.map(
    event("message.updated", {
      runId: "run_cp",
      message: { messageId: "m2", role: "assistant", text: "unattributed" },
    }),
  );
  const message = (mapped as { message: { runId: string | null } }).message;
  assert.equal(message.runId, null, "no run is claimed that T3 does not have");
});
