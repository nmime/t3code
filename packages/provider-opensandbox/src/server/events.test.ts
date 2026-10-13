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
