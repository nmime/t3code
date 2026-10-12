/**
 * The v1 driver — the half T3's provider-instance registry actually
 * instantiates from `ServerSettings.providerInstances`.
 *
 * The ready path runs against a **real** control plane from `@t3tools/daytona`
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

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { ControlPlaneServer } from "../../../daytona/dist/src/execution/ControlPlaneServer.js";
import { ProcessWorkerLauncher } from "../../../daytona/dist/src/execution/SandboxControlPlane.js";
import { decodeDaytonaSettings } from "./config.ts";
import { DaytonaDriver } from "./driver.ts";

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

/** Materialize the driver's instance and read the snapshot a client would see. */
const snapshotFor = (
  config: Record<string, unknown>,
  enabled = true,
): Effect.Effect<ServerProvider, ProviderDriverError> =>
  Effect.gen(function* () {
    const instance = yield* DaytonaDriver.create({
      instanceId: ProviderInstanceId.make("daytona_test"),
      displayName: "Daytona (test)",
      accentColor: undefined,
      environment: [],
      enabled,
      config: decodeDaytonaSettings(config),
    });
    return yield* instance.snapshot.getSnapshot;
  }).pipe(
    Effect.provide(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))),
    Effect.scoped,
  );

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

  assert.equal(snapshot.driver, "daytona");
  assert.equal(snapshot.instanceId, "daytona_test");
  assert.equal(snapshot.displayName, "Daytona (test)");
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
