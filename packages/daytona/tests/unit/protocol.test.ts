import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canTransition,
  TASK_STATE_TRANSITIONS,
  type TaskExecutionState,
} from "../../src/contracts/execution.js";
import {
  commandEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  negotiateProtocol,
  payloadHash,
  eventEnvelope,
  type ProviderEventPayload,
} from "../../src/contracts/workerProtocol.js";
import { canonicalize } from "../../src/contracts/canonical.js";
import { ProtocolViolationError } from "../../src/contracts/errors.js";
import { CommandDedupe } from "../../src/worker/CommandDedupe.js";
import { IdempotencyConflictError } from "../../src/contracts/errors.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("task state machine allows exactly the documented transitions", () => {
  const legal: Array<[TaskExecutionState, TaskExecutionState]> = [
    ["pending", "provisioning"],
    ["provisioning", "ready"],
    ["ready", "running"],
    ["running", "waiting"],
    ["waiting", "running"],
    ["running", "ready"],
    ["ready", "suspended"],
    ["suspended", "ready"],
    ["suspended", "restoring"],
    ["ready", "restoring"],
    ["completed", "restoring"],
  ];
  for (const [from, to] of legal) {
    assert.ok(canTransition(from, to), `${from} -> ${to} should be legal`);
  }

  const illegal: Array<[TaskExecutionState, TaskExecutionState]> = [
    ["pending", "running"],
    ["pending", "ready"],
    ["completed", "running"],
    ["failed", "ready"],
    ["suspended", "running"],
    ["provisioning", "running"],
  ];
  for (const [from, to] of illegal) {
    assert.ok(!canTransition(from, to), `${from} -> ${to} should be illegal`);
  }

  // Every state has an entry; terminal states still allow restore.
  assert.equal(Object.keys(TASK_STATE_TRANSITIONS).length, 9);
});

test("protocol envelopes round-trip and validate", () => {
  const envelope = commandEnvelope(
    "turn.start",
    {
      driver: "echo",
      threadId: "thread_1",
      runId: "run_1",
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: "fx_1",
      message: {
        messageId: "msg_1",
        text: "hello",
        attachments: [],
        createdBy: "user",
        creationSource: "client",
      },
      model: "default",
      runtimePolicy: { runtimeMode: "interactive", interactionMode: "supervised", cwd: null },
    },
    { taskId: "task_1", sandboxId: "sbox_1", leaseEpoch: 3, effectId: "fx_1" },
  );
  const decoded = decodeEnvelope(encodeEnvelope(envelope));
  assert.equal(decoded.kind, "command");
  assert.equal(decoded.type, "turn.start");
  assert.equal(decoded.effectId, "fx_1");
  assert.equal(decoded.leaseEpoch, 3);
});

test("malformed frames are rejected as protocol violations", () => {
  assert.throws(() => decodeEnvelope("{not json"), ProtocolViolationError);
  assert.throws(() => decodeEnvelope(JSON.stringify({ kind: "command" })), ProtocolViolationError);
});

test("provider events carry sequence numbers and correlation ids", () => {
  const event: ProviderEventPayload = {
    type: "turn.terminal",
    driver: "echo",
    providerThreadId: "echo_thread_1",
    providerTurnId: "turn_1",
    runId: "run_1",
    runOrdinal: 1,
    status: "completed",
    threadDisposition: "reusable",
  };
  const envelope = eventEnvelope(event, {
    taskId: "task_1",
    sandboxId: "sbox_1",
    leaseEpoch: 1,
    seq: 7,
    runId: "run_1",
  });
  assert.equal(envelope.seq, 7);
  assert.equal(envelope.runId, "run_1");
  assert.equal(envelope.type, "turn.terminal");
});

test("protocol negotiation picks the highest shared version", () => {
  assert.equal(negotiateProtocol([1]), 1);
  assert.equal(negotiateProtocol([1, 2, 3]), 1);
  assert.throws(() => negotiateProtocol([99]), ProtocolViolationError);
});

test("canonical JSON is order-independent", () => {
  assert.equal(
    canonicalize({ b: 1, a: [2, { d: 3, c: 4 }] }),
    canonicalize({ a: [2, { c: 4, d: 3 }], b: 1 }),
  );
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ b: 2, a: 1 }));
});

test("processed-effect ledger replays results and rejects drifted payloads", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-dedupe-"));
  const dedupe = new CommandDedupe(stateDir);
  const command = { type: "turn.start", payload: { runId: "run_1" } };

  assert.equal(dedupe.lookup("fx_1", command).duplicate, false);
  dedupe.record("fx_1", command, { providerThreadId: "t1" });

  const replay = dedupe.lookup("fx_1", command);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.result, { providerThreadId: "t1" });

  assert.throws(
    () => dedupe.lookup("fx_1", { type: "turn.start", payload: { runId: "run_2" } }),
    IdempotencyConflictError,
  );

  // The ledger survives a restart.
  const reopened = new CommandDedupe(stateDir);
  assert.equal(reopened.lookup("fx_1", command).duplicate, true);
});
