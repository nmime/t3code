/**
 * Run the end-to-end smoke test inside a real sandbox.
 *
 *   OPENSANDBOX_API_URL=https://sandbox.example.com \
 *   OPENSANDBOX_API_KEY=... OPENSANDBOX_IMAGE=t3x-sandbox:latest \
 *   node packages/daytona/scripts/sandbox-smoke/run.mjs
 *
 * It creates a sandbox through the same backend the control plane uses, ships
 * the built package plus `smoke.sh` into it, runs the script (control plane
 * *and* worker inside that one sandbox, so the worker's WebSocket is real but
 * does not have to cross a network boundary), prints every check, and deletes
 * the sandbox again — including on failure.
 *
 * Environment:
 *   OPENSANDBOX_API_URL / OPENSANDBOX_API_KEY / OPENSANDBOX_IMAGE   see docs/setup.md
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
const backendModule = path.join(
  packageRoot,
  "dist",
  "src",
  "execution",
  "backends",
  "opensandbox",
  "OpenSandboxBackend.js",
);

if (!fs.existsSync(cli) || !fs.existsSync(backendModule)) {
  console.error(
    `${cli} is missing — build the package first: pnpm --filter @t3tools/daytona build`,
  );
  process.exit(2);
}
if (!process.env.OPENSANDBOX_API_URL && !process.env.OPENSANDBOX_API_KEY) {
  console.error(
    "Point this at a sandbox server first:\n" +
      "  export OPENSANDBOX_API_URL=https://sandbox.example.com\n" +
      "  export OPENSANDBOX_API_KEY=...\n" +
      "  export OPENSANDBOX_IMAGE=t3x-sandbox:latest",
  );
  process.exit(2);
}

const { OpenSandboxBackend } = await import(backendModule);

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-smoke-"));
const bundle = path.join(staging, "worker-bundle.tgz");
execFileSync(process.execPath, [cli, "worker", "bundle", "--out", bundle], { stdio: "inherit" });

const backend = await OpenSandboxBackend.create({});
const health = await backend.ping();
console.log(
  `sandbox server ${backend.baseUrl ?? ""} is ${health.status} (${health.version ?? "unknown"})`,
);

const handle = await backend.create({
  taskId: "smoke",
  snapshot: "",
  platform: "",
  resources: { cpu: 2, memoryGiB: 4, diskGiB: 8 },
  env: {},
  setup: [],
  workingDirectory: "/root/project",
  secrets: [],
  stopAfterIdleMinutes: 30,
});
console.log(`sandbox ${handle.id} is up`);

try {
  // The sandbox home is the one path the sandbox user can always write to.
  const home = backend.homeDir(handle.id);
  const profiles = {
    "profile.yaml": [
      "apiVersion: t3x/v1",
      "kind: EnvironmentProfile",
      "metadata: { name: smoke-echo, version: 1 }",
      "runtime:",
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
      "apiVersion: t3x/v1",
      "kind: EnvironmentProfile",
      "metadata: { name: smoke-capped, version: 1 }",
      "runtime:",
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

  await backend.writeFile(handle.id, "/tmp/payload.tgz", fs.readFileSync(tar));
  const unpack = await backend.exec(
    handle.id,
    `mkdir -p ${home}/t3x-smoke && tar -xzf /tmp/payload.tgz -C ${home}/t3x-smoke && ` +
      `mv ${home}/t3x-smoke/t3x ${home}/t3x && chmod +x ${home}/t3x-smoke/smoke.sh && ls ${home}/t3x-smoke`,
    { cwd: "/tmp", timeoutMs: 180_000 },
  );
  if (unpack.exitCode !== 0) throw new Error(`unpack failed: ${unpack.stdout}${unpack.stderr}`);

  const result = await backend.exec(
    handle.id,
    `T3X_SMOKE_HOME=${home} T3X_SMOKE_DIR=${home}/t3x-smoke bash ${home}/t3x-smoke/smoke.sh 2>&1`,
    { cwd: "/tmp", timeoutMs: 1_800_000 },
  );
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(`\nsmoke exit code: ${result.exitCode}`);
  process.exitCode = result.exitCode === 0 ? 0 : 1;
} finally {
  if (process.env.T3X_SMOKE_KEEP === "1") {
    console.log(`kept sandbox ${handle.id} (T3X_SMOKE_KEEP=1)`);
  } else {
    await backend
      .destroy(handle.id)
      .catch((error) => console.error(`delete failed: ${error.message}`));
    console.log(`deleted sandbox ${handle.id}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
}
