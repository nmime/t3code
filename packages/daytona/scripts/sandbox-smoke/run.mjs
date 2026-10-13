/**
 * Run the end-to-end smoke test inside a real Daytona sandbox.
 *
 *   DAYTONA_API_KEY=... node packages/daytona/scripts/sandbox-smoke/run.mjs
 *
 * It creates a sandbox, ships the built package plus `smoke.sh` into it, runs
 * the script (control plane *and* worker inside that one sandbox, so the
 * worker's WebSocket is real but does not have to cross a network boundary),
 * prints every check, and deletes the sandbox again — including on failure.
 *
 * Environment:
 *   T3X_SMOKE_SNAPSHOT  snapshot to create (default daytona-medium)
 *   T3X_SMOKE_KEEP=1    leave the sandbox behind for inspection
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const cli = path.join(packageRoot, "dist", "src", "cli.js");
const snapshot = process.env.T3X_SMOKE_SNAPSHOT ?? "daytona-medium";

let Daytona;
try {
  ({ Daytona } = await import("@daytonaio/sdk"));
} catch {
  console.error(
    "This script needs the Daytona SDK and DAYTONA_API_KEY.\n" +
      "  npm install @daytonaio/sdk && export DAYTONA_API_KEY=...",
  );
  process.exit(2);
}
if (!process.env.DAYTONA_API_KEY) {
  console.error("DAYTONA_API_KEY is not set.");
  process.exit(2);
}
if (!fs.existsSync(cli)) {
  console.error(
    `${cli} is missing — build the package first: pnpm --filter @t3tools/daytona build`,
  );
  process.exit(2);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-smoke-"));
const bundle = path.join(staging, "worker-bundle.tgz");
execFileSync(process.execPath, [cli, "worker", "bundle", "--out", bundle], { stdio: "inherit" });

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
const sandbox = await daytona.create(
  {
    snapshot,
    labels: { "t3x.smoke": "in-sandbox" },
    autoStopInterval: 20,
  },
  { timeout: 240 },
);
console.log(`sandbox ${sandbox.id} (${snapshot}) is ${sandbox.state}`);

try {
  // The sandbox home is the one path the task user can always write to.
  const home = `/home/${sandbox.user ?? "daytona"}`;
  const profiles = {
    "profile.yaml": [
      "apiVersion: t3-daytona/v1",
      "kind: EnvironmentProfile",
      "metadata: { name: smoke-echo, version: 1 }",
      "runtime:",
      `  snapshot: ${snapshot}`,
      "  resources: { cpu: 2, memoryGiB: 4, diskGiB: 8 }",
      "project:",
      `  workingDirectory: ${home}/project`,
      "  setup: []",
      '  allowedRepositories: ["file://*"]',
      'environment: { CI: "true" }',
      "agents:",
      "  allowed: [echo]",
      "  defaults: { provider: echo }",
      "sandbox:",
      "  isolation: per-project",
      "  maxConcurrentTasks: 4",
      "  stopAfterIdleMinutes: 30",
      "  deleteAfterCompletedHours: 48",
      "",
    ].join("\n"),
    "profile-capped.yaml": [
      "apiVersion: t3-daytona/v1",
      "kind: EnvironmentProfile",
      "metadata: { name: smoke-capped, version: 1 }",
      "runtime:",
      `  snapshot: ${snapshot}`,
      "  resources: { cpu: 2, memoryGiB: 4, diskGiB: 8 }",
      "project:",
      `  workingDirectory: ${home}/project`,
      "  setup: []",
      '  allowedRepositories: ["file://*"]',
      "agents:",
      "  allowed: [echo]",
      "  maxRuntimeMode: approval-required",
      "  defaults: { provider: echo }",
      "sandbox:",
      "  isolation: per-project",
      "  maxConcurrentTasks: 4",
      "  stopAfterIdleMinutes: 30",
      "  deleteAfterCompletedHours: 48",
      "",
    ].join("\n"),
  };

  // Ship: the built package (without node_modules — the sandbox installs the
  // three production dependencies from the registry), the script, the profiles.
  const payload = path.join(staging, "payload");
  fs.mkdirSync(payload, { recursive: true });
  fs.cpSync(path.join(packageRoot, "dist"), path.join(payload, "t3x", "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(payload, "t3x", "package.json"),
    `${JSON.stringify(
      {
        name: "t3x-sandbox-bundle",
        private: true,
        type: "module",
        dependencies: { ws: "8.22.0", yaml: "2.9.0", zod: "3.25.76" },
      },
      null,
      2,
    )}\n`,
  );
  fs.copyFileSync(path.join(here, "smoke.sh"), path.join(payload, "smoke.sh"));
  for (const [name, body] of Object.entries(profiles))
    fs.writeFileSync(path.join(payload, name), body);
  const tar = path.join(staging, "payload.tgz");
  execFileSync("tar", ["-czf", tar, "-C", payload, "."]);

  await sandbox.fs.uploadFile(fs.readFileSync(tar), "/tmp/payload.tgz");
  const unpack = await sandbox.process.executeCommand(
    `mkdir -p ${home}/t3x-smoke && tar -xzf /tmp/payload.tgz -C ${home}/t3x-smoke && ` +
      `mv ${home}/t3x-smoke/t3x ${home}/t3x && chmod +x ${home}/t3x-smoke/smoke.sh && ls ${home}/t3x-smoke`,
    "/tmp",
    undefined,
    180,
  );
  if (unpack.exitCode !== 0) throw new Error(`unpack failed: ${unpack.result}`);

  const result = await sandbox.process.executeCommand(
    `T3X_SMOKE_HOME=${home} T3X_SMOKE_DIR=${home}/t3x-smoke bash ${home}/t3x-smoke/smoke.sh 2>&1`,
    "/tmp",
    undefined,
    1800,
  );
  process.stdout.write(result.result ?? "");
  console.log(`\nsmoke exit code: ${result.exitCode}`);
  process.exitCode = result.exitCode === 0 ? 0 : 1;
} finally {
  if (process.env.T3X_SMOKE_KEEP === "1") {
    console.log(`kept sandbox ${sandbox.id} (T3X_SMOKE_KEEP=1)`);
  } else {
    await daytona
      .delete(sandbox)
      .catch((error) => console.error(`delete failed: ${error.message}`));
    console.log(`deleted sandbox ${sandbox.id}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
}
