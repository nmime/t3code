/**
 * The v1 driver — the half T3's provider-instance registry actually
 * instantiates from `ServerSettings.providerInstances`.
 *
 * The ready path runs against a **real** control plane from `@t3tools/t3x`
 * (a real state directory, a real profile store, the real HTTP surface), because
 * both halves live in this repository. The other paths are the probe's, and need
 * no sandbox: they are what the user sees in Settings when a URL, a token or a
 * profile is wrong.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ModelSelection, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { ControlPlaneServer } from "../../../t3x/dist/src/execution/ControlPlaneServer.js";
import { ProcessWorkerLauncher } from "../../../t3x/dist/src/execution/SandboxControlPlane.js";
import { decodeOpenSandboxSettings } from "./config.ts";
import { OpenSandboxControlPlane } from "./controlPlane.ts";
import { OpenSandboxDriver } from "./driver.ts";

const TOKEN = "driver-test-token";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-driver-"));
let server: Awaited<ReturnType<typeof ControlPlaneServer.start>>;

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
    launcher: new ProcessWorkerLauncher(),
    autoStartEffects: false,
    workerAttachTimeoutMs: 30_000,
    // The probe is expected to tell a refused token apart from an absent one,
    // so the server under test must actually demand one.
    apiToken: TOKEN,
  });
  server.profiles.createProfile({ profileId: "provider-test", body: profile as never });
});

after(async () => {
  await server.stop();
});

/** Materialize the driver's instance, as the server's registry would. */
const instanceFor = (config: Record<string, unknown>, enabled = true) =>
  Effect.gen(function* () {
    return yield* OpenSandboxDriver.create({
      instanceId: ProviderInstanceId.make("opensandbox_test"),
      displayName: "OpenSandbox (test)",
      accentColor: undefined,
      environment: [],
      enabled,
      config: decodeOpenSandboxSettings(config),
    });
  }).pipe(
    Effect.provide(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))),
    Effect.scoped,
  );

/** The snapshot a client would see for an instance with this config. */
const snapshotFor = (
  config: Record<string, unknown>,
  enabled = true,
): Effect.Effect<ServerProvider, ProviderDriverError> =>
  instanceFor(config, enabled).pipe(Effect.flatMap((instance) => instance.snapshot.getSnapshot));

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

test("a reachable control plane with the named profile is ready", async () => {
  const snapshot = await Effect.runPromise(
    snapshotFor({
      enabled: true,
      controlPlaneUrl: `http://127.0.0.1:${server.port}`,
      apiToken: TOKEN,
      profileId: "provider-test",
      repositoryUrl: "github.com/nmime/backend",
    }),
  );

  assert.equal(snapshot.driver, "opensandbox");
  assert.equal(snapshot.instanceId, "opensandbox_test");
  assert.equal(snapshot.displayName, "OpenSandbox (test)");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.auth.status, "authenticated");
  assert.equal(snapshot.models[0]?.slug, "default");
  assert.match(snapshot.message ?? "", /profile provider-test v1/);
  assert.match(snapshot.message ?? "", /github\.com\/nmime\/backend/);
});

test("a missing environment profile is an error that names it", async () => {
  const snapshot = await Effect.runPromise(
    snapshotFor({
      enabled: true,
      controlPlaneUrl: `http://127.0.0.1:${server.port}`,
      apiToken: TOKEN,
      profileId: "nope",
    }),
  );

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.auth.status, "authenticated");
  assert.match(snapshot.message ?? "", /no environment profile 'nope'/);
});

test("a refused token is unauthenticated, not merely unavailable", async () => {
  const snapshot = await Effect.runPromise(
    snapshotFor({
      enabled: true,
      controlPlaneUrl: `http://127.0.0.1:${server.port}`,
      apiToken: "wrong-token",
      profileId: "provider-test",
    }),
  );

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.auth.status, "unauthenticated");
  assert.match(snapshot.message ?? "", /refused this token/);
});

test("an unreachable control plane says so", async () => {
  const snapshot = await Effect.runPromise(
    snapshotFor({
      enabled: true,
      controlPlaneUrl: "http://127.0.0.1:1",
      profileId: "provider-test",
    }),
  );

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.auth.status, "unknown");
  assert.match(snapshot.message ?? "", /Could not reach the control plane/);
});

test("a turned-off instance is disabled", async () => {
  const snapshot = await Effect.runPromise(
    snapshotFor(
      {
        enabled: true,
        controlPlaneUrl: `http://127.0.0.1:${server.port}`,
        profileId: "provider-test",
      },
      false,
    ),
  );

  assert.equal(snapshot.status, "disabled");
  assert.match(snapshot.message ?? "", /turned off/);
});

test("text generation runs the agent in the sandbox, and refuses what it cannot promise", async () => {
  // A task first: the prompt runs where the agent does, so the control plane
  // resolves the caller's cwd to the task that owns it.
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-driver-gen-"));
  const run = (command: string) =>
    spawnSync("bash", ["-c", command], { cwd: origin, encoding: "utf8" });
  run("git init -q -b main");
  run("git config user.email a@b.c");
  run("git config user.name t");
  fs.writeFileSync(path.join(origin, "README.md"), "# generate\n");
  run("git add -A && git commit -qm init");

  const client = new OpenSandboxControlPlane({
    url: `http://127.0.0.1:${server.port}`,
    token: TOKEN,
  });
  const task = await client.createTask({
    profileId: "provider-test",
    provider: "echo",
    repositoryUrl: origin,
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker attach");
  await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "ready");
  const { worktreePath } = await client.status(task.taskId);

  const instance = await Effect.runPromise(
    instanceFor({
      enabled: true,
      controlPlaneUrl: `http://127.0.0.1:${server.port}`,
      apiToken: TOKEN,
      profileId: "provider-test",
      agent: "echo",
      repositoryUrl: origin,
    }),
  );
  const modelSelection = Schema.decodeSync(ModelSelection)({
    instanceId: "opensandbox_test",
    model: "default",
  });

  const commit = await Effect.runPromise(
    instance.textGeneration.generateCommitMessage({
      cwd: worktreePath,
      branch: "main",
      stagedSummary: "1 file changed",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection,
    }),
  );
  assert.equal(commit.subject, "echo subject");
  assert.match(commit.body, /echo body/);

  const branch = await Effect.runPromise(
    instance.textGeneration.generateBranchName({
      cwd: worktreePath,
      message: "add a thing",
      modelSelection,
    }),
  );
  assert.match(branch.branch, /echo/);

  const title = await Effect.runPromise(
    instance.textGeneration.generateThreadTitle({
      cwd: worktreePath,
      message: "hello",
      modelSelection,
    }),
  );
  assert.equal(title.title, "echo title");

  // The review guide needs read-only tools over several turns; a one-shot
  // invocation cannot promise that, so it is refused instead of answered blind.
  const refused = await Effect.runPromise(
    Effect.result(
      instance.textGeneration.generateReviewGuide({
        cwd: worktreePath,
        number: 1,
        title: "A change",
        description: "Why it is here",
        baseBranch: "main",
        baseCommit: "HEAD~1",
        settledReview: "",
        modelSelection,
      }),
    ),
  );
  assert.equal(refused._tag, "Failure");
  assert.match(refused._tag === "Failure" ? refused.failure.message : "", /read-only/);

  // And none of it entered the conversation.
  const snapshot = await client.snapshot(task.taskId);
  assert.equal(snapshot.messages.length, 0);
});
