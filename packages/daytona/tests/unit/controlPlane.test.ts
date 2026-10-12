import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore } from "../../src/execution/EventStore.js";
import { TaskStateMachine } from "../../src/execution/TaskStateMachine.js";
import { SecretsBroker } from "../../src/execution/SecretsBroker.js";
import { PolicyEngine } from "../../src/execution/PolicyEngine.js";
import { ConfigBundleStore } from "../../src/config-importer/ConfigBundle.js";
import { importLocalConfigs } from "../../src/config-importer/importer.js";
import { IdempotencyConflictError, SecretPolicyViolationError } from "../../src/contracts/errors.js";
import { testProfile } from "../helpers.js";
import { resolveProfile } from "../../src/contracts/environmentProfile.js";
import type { TaskRecord } from "../../src/contracts/execution.js";

function stateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3x-unit-"));
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const profile = resolveProfile({
    profileId: "test",
    layers: [{ source: "global", name: "g", patch: testProfile() as never }],
  });
  const now = Date.now();
  return {
    taskId: "task_1",
    threadId: "thread_1",
    state: "pending",
    resumeKind: "fresh",
    sandboxScope: "task",
    projectId: null,
    profileId: "test",
    profileDigest: profile.digest,
    profile,
    provider: "echo",
    providerInstanceId: "echo-default",
    model: "default",
    permissionMode: "supervised",
    executionTarget: { kind: "local" },
    sandboxId: null,
    workspaceRoot: "",
    worktreePath: "",
    worktreeBranch: "",
    repositoryUrl: "",
    branch: "main",
    leaseEpoch: 0,
    lastEventSequence: 0,
    createdAt: now,
    updatedAt: now,
    idleSince: null,
    completedAt: null,
    budgetCents: null,
    spentCents: 0,
    ...overrides,
  };
}

test("state machine persists transitions and rejects illegal ones", () => {
  const store = new EventStore(path.join(stateDir(), "db.sqlite"));
  store.insertTask(taskRecord());
  const machine = new TaskStateMachine(store);

  machine.transition("task_1", "provisioning");
  machine.transition("task_1", "ready");
  assert.equal(store.getTask("task_1")!.state, "ready");

  assert.throws(() => machine.transition("task_1", "provisioning"), /cannot transition/);
  assert.equal(store.getTask("task_1")!.state, "ready");

  const events = store.eventsSince("task_1", 0).filter((e) => e.type === "task.state_changed");
  assert.equal(events.length, 2);
  store.close();
});

test("command receipts are idempotent and effects are deduplicated", () => {
  const store = new EventStore(path.join(stateDir(), "db.sqlite"));
  store.insertTask(taskRecord());

  const input = {
    commandId: "cmd_1",
    taskId: "task_1",
    kind: "message.send",
    payload: { text: "hi" },
    events: [{ type: "message.accepted", payload: { text: "hi" } }],
    effects: [
      { effectId: "fx_1", kind: "turn.start", payload: { runId: "run_1" }, leaseEpoch: 0 },
    ],
  };

  const first = store.submitCommand(input);
  assert.equal(first.events.length, 1);

  const second = store.submitCommand(input);
  assert.equal(second.events.length, 0, "duplicate command does not duplicate events");
  assert.equal(second.receipt.commandId, "cmd_1");

  // Same effect id with a different payload is a conflict.
  assert.throws(
    () =>
      store.enqueueEffect({
        effectId: "fx_1",
        taskId: "task_1",
        kind: "turn.start",
        payload: { runId: "run_2" },
        leaseEpoch: 0,
      }),
    IdempotencyConflictError,
  );

  const claimed = store.claimDueEffects();
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.attempts, 1);
  assert.equal(store.claimDueEffects().length, 0, "an effect is claimed once");

  store.failEffect("fx_1", { message: "boom" }, 0);
  assert.equal(store.claimDueEffects().length, 1, "a failed effect is retried");

  store.requeueStuckEffects(0);
  store.close();
});

test("worker tokens are single-use and expire", () => {
  const store = new EventStore(path.join(stateDir(), "db.sqlite"));
  store.issueWorkerToken({
    tokenId: "tok_1",
    tokenHash: "hash",
    taskId: "task_1",
    sandboxId: "sbox_1",
    expiresAt: Date.now() + 1000,
  });
  assert.deepEqual(store.consumeWorkerToken("tok_1", "hash"), {
    taskId: "task_1",
    sandboxId: "sbox_1",
  });
  assert.equal(store.consumeWorkerToken("tok_1", "hash"), null, "second use is refused");

  store.issueWorkerToken({
    tokenId: "tok_2",
    tokenHash: "hash2",
    taskId: "task_1",
    sandboxId: "sbox_1",
    expiresAt: Date.now() - 1,
  });
  assert.equal(store.consumeWorkerToken("tok_2", "hash2"), null, "expired token is refused");
  assert.equal(store.consumeWorkerToken("tok_2", "wrong"), null, "wrong secret is refused");
  store.close();
});

test("secrets are encrypted at rest, scoped per profile and redacted", () => {
  const dir = stateDir();
  const store = new EventStore(path.join(dir, "db.sqlite"));
  const broker = new SecretsBroker(store, path.join(dir, "secret.key"));

  broker.put("NPM_TOKEN", "npm_supersecret_value", { allowedProfiles: ["typescript-backend"] });

  // Ciphertext, never plaintext, in the database.
  const row = store.getSecretCipher("NPM_TOKEN")!;
  assert.ok(!row.ciphertext.includes("npm_supersecret_value"));
  assert.equal(broker.get("NPM_TOKEN", "typescript-backend"), "npm_supersecret_value");

  assert.throws(
    () => broker.get("NPM_TOKEN", "another-profile"),
    SecretPolicyViolationError,
  );

  const materialized = broker.materialize(
    [{ name: "NPM_TOKEN", secretRef: "NPM_TOKEN", inject: "env", hostAllowlist: [] }],
    "typescript-backend",
  );
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0]!.value, "npm_supersecret_value");

  assert.equal(
    broker.redact("token is npm_supersecret_value and sk-abcdefgh12345678"),
    "token is *** and ***",
  );
  assert.throws(
    () =>
      broker.materialize(
        [{ name: "MISSING", secretRef: "does-not-exist", inject: "env", hostAllowlist: [] }],
        "typescript-backend",
      ),
    SecretPolicyViolationError,
  );
  store.close();
});

test("policy engine stops idle tasks, enforces budget and retains completed ones", () => {
  const store = new EventStore(path.join(stateDir(), "db.sqlite"));
  const now = Date.now();

  store.insertTask(
    taskRecord({ taskId: "idle", state: "ready", idleSince: now - 90 * 60_000 }),
  );
  store.insertTask(
    taskRecord({
      taskId: "over-budget",
      state: "ready",
      idleSince: now,
      budgetCents: 10,
      spentCents: 25,
    }),
  );
  store.insertTask(
    taskRecord({
      taskId: "running",
      state: "running",
      idleSince: now - 90 * 60_000,
    }),
  );
  store.insertTask(
    taskRecord({
      taskId: "old-completed",
      state: "completed",
      completedAt: now - 72 * 3_600_000,
    }),
  );

  const decisions = new PolicyEngine(store).evaluate(now);
  const byTask = new Map(decisions.map((d) => [d.taskId, d]));
  assert.equal(byTask.get("idle")?.action, "stop");
  assert.equal(byTask.get("over-budget")?.action, "stop");
  assert.equal(byTask.get("running"), undefined, "executing tasks are never auto-stopped");
  assert.equal(byTask.get("old-completed")?.action, "destroy");
  store.close();
});

test("config importer strips credentials and flags macOS leftovers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-home-"));
  fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    [
      'model = "gpt-5-codex"',
      'openai_api_key = "sk-abcdefghijklmnop1234"',
      'shell = "/Users/nmime/.zshrc"',
    ].join("\n"),
  );
  fs.writeFileSync(path.join(home, ".codex", "skills", "review.md"), "# review skill\n");
  fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-abcdefghijklmnop" }, theme: "dark" }),
  );
  fs.writeFileSync(path.join(home, ".claude", "commands", "ship.md"), "# ship\n");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ provider: { anthropic: { options: { apiKey: "sk-ant-secret-value-1" } } } }),
  );

  const result = importLocalConfigs({ home, name: "mac-config-v1" });
  const paths = result.bundle.files.map((f) => f.path);
  assert.ok(paths.includes("~/.codex/config.toml"));
  assert.ok(paths.includes("~/.codex/skills/review.md"));
  assert.ok(paths.includes("~/.claude/settings.json"));
  assert.ok(paths.includes("~/.claude/commands/ship.md"));
  assert.ok(paths.includes("~/.config/opencode/opencode.json"));

  const codexToml = result.bundle.files.find((f) => f.path === "~/.codex/config.toml")!;
  assert.ok(!codexToml.content.includes("sk-abcdefghijklmnop1234"), "api key redacted");
  assert.match(codexToml.content, /model = "gpt-5-codex"/, "non-secret settings kept");
  assert.ok(
    result.bundle.warnings.some((w) => w.includes("macOS-specific")),
    "macOS paths flagged",
  );

  const claudeSettings = result.bundle.files.find((f) => f.path === "~/.claude/settings.json")!;
  assert.ok(!claudeSettings.content.includes("sk-ant-abcdefghijklmnop"));

  const opencode = result.bundle.files.find((f) => f.path.endsWith("opencode.json"))!;
  assert.ok(!opencode.content.includes("sk-ant-secret-value-1"));

  // Bundles resolve into provisioning files for a profile's configuration sources.
  const store = new ConfigBundleStore(path.join(stateDir(), "bundles"));
  store.save(result.bundle);
  const resolved = store.resolveSources([{ profile: "mac-config-v1" }]);
  assert.equal(resolved.files.length, result.bundle.files.length);
  assert.ok(resolved.warnings.length >= 1);
});
