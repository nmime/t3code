#!/usr/bin/env node
/**
 * t3x — control-plane CLI.
 *
 * The same commands drive local development and a deployed VPS: profiles,
 * tasks, approvals, checkpoints, reconciliation and configuration import.
 */

import { parseArgs } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  ControlPlaneServer,
  createSandboxBackend,
  defaultWorkerEntry,
  type SandboxBackendKind,
} from "./execution/ControlPlaneServer.js";
import { parseProfileYaml } from "./contracts/environmentProfile.js";
import {
  OPENSANDBOX_DEFAULT_BASE_URL,
  OPENSANDBOX_DEFAULT_IMAGE,
  OpenSandboxBackend,
} from "./execution/backends/opensandbox/OpenSandboxBackend.js";
import { DEFAULT_SANDBOX_WORKER_ENTRY } from "./execution/SandboxControlPlane.js";
import { importLocalConfigs } from "./config-importer/importer.js";
import { ConfigBundleStore } from "./config-importer/ConfigBundle.js";
import { errorPayload } from "./contracts/errors.js";

const USAGE = `t3x — T3 Code remote execution control plane

Usage:
  t3x serve [--state-dir DIR] [--port N] [--api-token TOKEN]
            [--backend auto|local|opensandbox] [--worker-url https://host]
            [--worker-bundle FILE.tgz] [--worker-entry-in-sandbox PATH]
            [--opensandbox-url URL] [--opensandbox-image IMAGE]
  t3x worker bundle [--out FILE.tgz]
  t3x profile add --id ID --file FILE.yaml
  t3x profile list
  t3x profile resolve --id ID [--overrides FILE.yaml]
  t3x project list
  t3x project add --repo URL [--id ID] [--name NAME] [--default-scope project|task] [--max-tasks N]
  t3x project sandboxes [--id ID]
  t3x sandbox list
  t3x sandbox stop SANDBOX_ID | destroy SANDBOX_ID
  t3x task create --profile ID [--repo URL] [--branch B] [--provider P] [--model M]
                  [--scope project|task] [--project PROJECT_ID]
  t3x task list
  t3x task status TASK_ID
  t3x task message TASK_ID "text"
  t3x task approve TASK_ID REQUEST_ID [--reject]
  t3x task stop TASK_ID | resume TASK_ID | destroy TASK_ID
  t3x task checkpoint TASK_ID CHECKPOINT_ID
  t3x task git TASK_ID
  t3x reconcile
  t3x import-config --home DIR --name NAME [--targets codex,claude,opencode]
  t3x doctor [--opensandbox-url URL]

OpenSandbox (the sandbox provider):
  OPENSANDBOX_API_URL  lifecycle server root; defaults to http://127.0.0.1:8080
                       (a deployment usually puts it behind TLS, e.g.
                       https://sandbox.example.com)
  OPENSANDBOX_API_KEY  the server's api_key, sent as OPEN-SANDBOX-API-KEY
  OPENSANDBOX_IMAGE    image every image-backed profile is built from
  OPENSANDBOX_SANDBOX_TIMEOUT_SECONDS
                       absolute sandbox lifetime in seconds (default 86400).
                       This is a backstop, not the idle policy: the control
                       plane renews it while a task is alive, and stops an
                       idle sandbox through its own policy
  OPENSANDBOX_PUBLIC_URL
                       root used for browser-facing preview URLs, when it is not
                       the same as OPENSANDBOX_API_URL
  --opensandbox-url / --opensandbox-api-key / --opensandbox-image /
  --opensandbox-timeout-seconds override the variables for one run.

Sandbox scope (the "Run this task in a new sandbox" toggle):
  default            one shared sandbox per project/repository, one git
                     worktree per task (dependencies, caches and dev services
                     are shared; working directories are not)
  --scope task       a dedicated sandbox for this task alone
  --scope project    explicitly request the shared project sandbox
Resolution order: task request -> project default -> global default.
"t3x project add --default-scope" sets the project default; the global default
is the profile's sandbox.isolation.
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || rest.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  switch (command) {
    case "serve":
      return serve(rest);
    case "profile":
      return profile(rest);
    case "task":
      return task(rest);
    case "project":
      return project(rest);
    case "sandbox":
      return sandbox(rest);
    case "reconcile":
      return reconcile(rest);
    case "worker":
      return worker(rest);
    case "import-config":
      return importConfig(rest);
    case "doctor":
      return doctor(rest);
    default:
      process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

/**
 * `t3x worker bundle` — pack the worker so a remote sandbox can run it.
 *
 * A sandbox has no access to the control plane's filesystem, so the worker
 * (its compiled entry, the modules it imports and its production dependencies)
 * has to travel as one archive. `serve --worker-bundle` uploads and extracts it
 * into every sandbox it provisions.
 */
async function worker(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "bundle") throw new Error(`unknown worker subcommand ${sub}`);
  const flags = parseFlags(rest);
  const out = path.resolve(flags.out ?? path.join(process.cwd(), "t3x-worker-bundle.tgz"));
  // This file is dist/src/cli.js: dist/src is what ships, its parent is the package.
  const distSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const packageRoot = path.resolve(distSrc, "..", "..");
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "t3x-worker-bundle-"));

  // The tarball root mirrors dist/src, so the entry lands at worker/index.js
  // and its `../contracts/...` imports resolve inside the same root.
  await fsp.cp(distSrc, staging, { recursive: true });
  await fsp.writeFile(
    path.join(staging, "package.json"),
    `${JSON.stringify({ name: "t3x-worker-bundle", private: true, type: "module" }, null, 2)}\n`,
  );

  const manifest = JSON.parse(
    await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };
  const require = createRequire(import.meta.url);
  const modulesDir = path.join(staging, "node_modules");
  await fsp.mkdir(modulesDir, { recursive: true });
  const packed: string[] = [];
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    let entry: string;
    try {
      entry = require.resolve(`${name}/package.json`);
    } catch {
      throw new Error(`dependency ${name} is not installed; run the package install first`);
    }
    const from = path.dirname(entry);
    const to = path.join(modulesDir, name);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(from, to, { recursive: true, dereference: true });
    packed.push(name);
  }

  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tar = spawnSync("tar", ["-czf", out, "-C", staging, "."], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("tar failed while packing the worker bundle");
  await fsp.rm(staging, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        ok: true,
        bundle: out,
        bytes: (await fsp.stat(out)).size,
        dependencies: packed,
        entryInSandbox: DEFAULT_SANDBOX_WORKER_ENTRY,
        use: `t3x serve --worker-bundle ${out} --worker-url https://your-vps.example.com`,
      },
      null,
      2,
    ),
  );
}

function stateDirFrom(args: string[]): string {
  const { values } = parseArgs({
    args,
    options: { "state-dir": { type: "string" } },
    strict: false,
  });
  const dir = (values as Record<string, string | undefined>)["state-dir"];
  return path.resolve(dir ?? path.join(os.homedir(), ".t3x"));
}

/**
 * Run a command against the deployment's own state, with the deployment's own
 * sandbox backend.
 *
 * `ControlPlaneServer.start` falls back to the local directory backend when it
 * is not handed one — which would make `t3x sandbox destroy` delete a directory
 * while the real container kept running. Every command goes through here, so
 * the backend is resolved the same way `serve` resolves it (`--backend`, then
 * the environment).
 */
async function withServer<T>(
  args: string[],
  fn: (server: ControlPlaneServer) => Promise<T>,
  options: { startEffects?: boolean } = {},
): Promise<T> {
  const stateDir = stateDirFrom(args);
  const flags = parseFlags(args);
  const backendKind = (flags.backend ?? "auto") as SandboxBackendKind;
  const backend = await createSandboxBackend({
    stateDir,
    kind: backendKind,
    opensandbox: {
      ...((flags["opensandbox-url"] ?? process.env.OPENSANDBOX_API_URL)
        ? { baseUrl: flags["opensandbox-url"] ?? process.env.OPENSANDBOX_API_URL }
        : {}),
      ...((flags["opensandbox-api-key"] ?? process.env.OPENSANDBOX_API_KEY)
        ? { apiKey: flags["opensandbox-api-key"] ?? process.env.OPENSANDBOX_API_KEY }
        : {}),
      ...((flags["opensandbox-image"] ?? process.env.OPENSANDBOX_IMAGE)
        ? { defaultImage: flags["opensandbox-image"] ?? process.env.OPENSANDBOX_IMAGE }
        : {}),
      ...((flags["opensandbox-timeout-seconds"] ?? process.env.OPENSANDBOX_SANDBOX_TIMEOUT_SECONDS)
        ? {
            defaultTimeoutSeconds: Number(
              flags["opensandbox-timeout-seconds"] ??
                process.env.OPENSANDBOX_SANDBOX_TIMEOUT_SECONDS,
            ),
          }
        : {}),
    },
  });
  const server = await ControlPlaneServer.start({
    stateDir,
    port: 0,
    backend,
    workerEntry: defaultWorkerEntry(),
    autoStartEffects: options.startEffects ?? true,
  });
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

async function serve(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const stateDir = path.resolve(flags["state-dir"] ?? path.join(os.homedir(), ".t3x"));
  const port = Number(flags.port ?? 8087);
  const apiToken = flags["api-token"] ?? process.env.T3X_API_TOKEN ?? null;
  const backendKind = (flags.backend ?? "auto") as SandboxBackendKind;
  const sandboxUrl = flags["opensandbox-url"] ?? process.env.OPENSANDBOX_API_URL;
  const sandboxKey = flags["opensandbox-api-key"] ?? process.env.OPENSANDBOX_API_KEY;
  const sandboxImage = flags["opensandbox-image"] ?? process.env.OPENSANDBOX_IMAGE;
  const sandboxTimeout =
    flags["opensandbox-timeout-seconds"] ?? process.env.OPENSANDBOX_SANDBOX_TIMEOUT_SECONDS;
  const backend = await createSandboxBackend({
    stateDir,
    kind: backendKind,
    opensandbox: {
      ...(sandboxUrl ? { baseUrl: sandboxUrl } : {}),
      ...(sandboxKey ? { apiKey: sandboxKey } : {}),
      ...(sandboxImage ? { defaultImage: sandboxImage } : {}),
      ...(sandboxTimeout ? { defaultTimeoutSeconds: Number(sandboxTimeout) } : {}),
    },
  });

  const server = await ControlPlaneServer.start({
    stateDir,
    port,
    apiToken,
    backend,
    workerEntry: defaultWorkerEntry(),
    ...(flags["worker-url"] ? { publicWorkerUrl: flags["worker-url"] } : {}),
    ...(flags["worker-bundle"] ? { workerBundle: path.resolve(flags["worker-bundle"]) } : {}),
    ...(flags["worker-entry-in-sandbox"]
      ? { workerEntryInSandbox: flags["worker-entry-in-sandbox"] }
      : {}),
  });

  console.log(`t3x control plane listening on http://127.0.0.1:${server.port}`);
  console.log(`  state dir:    ${stateDir}`);
  console.log(`  worker url:   ${server.workerUrl}`);
  console.log(`  backend:      ${server.backend.kind}${backendKind === "auto" ? " (auto)" : ""}`);
  if (server.backend.kind === "opensandbox") {
    console.log(
      `  sandbox api:  ${sandboxUrl ?? `${OPENSANDBOX_DEFAULT_BASE_URL} (local default)`}`,
    );
    console.log(`  sandbox image: ${sandboxImage ?? `${OPENSANDBOX_DEFAULT_IMAGE} (default)`}`);
    const lifetime =
      flags["opensandbox-timeout-seconds"] ?? process.env.OPENSANDBOX_SANDBOX_TIMEOUT_SECONDS;
    console.log(
      `  sandbox life: ${lifetime ? `${lifetime}s` : "24h (default)"} — renewed while a task is alive; idle-stop is policy, not this`,
    );
  }
  console.log(
    `  worker bundle:${flags["worker-bundle"] ? ` ${path.resolve(flags["worker-bundle"])}` : " none (the sandbox must already carry the worker)"}`,
  );
  console.log(`  api auth:     ${apiToken ? "bearer token required" : "open (development)"}`);
  if (server.backend.kind === "opensandbox" && !flags["worker-url"]) {
    console.log(
      "  note: no --worker-url given, so sandboxes are told to dial 127.0.0.1 — set it to the\n" +
        "        control plane's address as reachable from a sandbox (https://host).",
    );
  }

  await server.recovery.recover();
  const sweep = setInterval(() => {
    // The sweep contains its own provider failures; this catch is the last
    // line of defence. An unhandled rejection here exits the process, and
    // systemd restarts it straight into the same failure.
    void server.recovery.sweep().catch((err: unknown) => {
      console.error(`t3x: sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 60_000);
  sweep.unref?.();

  const shutdown = async () => {
    clearInterval(sweep);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function profile(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "add") {
    const flags = parseFlags(rest);
    if (!flags.id || !flags.file) throw new Error("profile add requires --id and --file");
    const body = parseProfileYaml(fs.readFileSync(flags.file, "utf8"));
    await withServer(
      rest,
      async (server) => {
        console.log(
          JSON.stringify(server.profiles.createProfile({ profileId: flags.id!, body }), null, 2),
        );
      },
      { startEffects: false },
    );
    return;
  }
  if (sub === "list") {
    await withServer(
      rest,
      async (server) => {
        console.log(JSON.stringify(server.profiles.listProfiles(), null, 2));
      },
      { startEffects: false },
    );
    return;
  }
  if (sub === "resolve") {
    const flags = parseFlags(rest);
    if (!flags.id) throw new Error("profile resolve requires --id");
    await withServer(
      rest,
      async (server) => {
        const overrides = flags.overrides
          ? (YAML.parse(fs.readFileSync(flags.overrides, "utf8")) as Record<string, unknown>)
          : undefined;
        const resolved = server.profiles.resolveForTask({
          profileId: flags.id!,
          repositoryUrl: flags.repo ?? "git.example.com/team/project",
          ...(overrides ? { taskOverrides: overrides as never } : {}),
        });
        console.log(JSON.stringify(resolved, null, 2));
      },
      { startEffects: false },
    );
    return;
  }
  throw new Error(`unknown profile subcommand ${sub}`);
}

async function task(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const positional = rest.filter((a) => !a.startsWith("--"));
  const flags = parseFlags(rest);

  await withServer(rest, async (server) => {
    switch (sub) {
      case "create": {
        const task = server.tasks.createTask({
          profileId: flags.profile ?? "default",
          repositoryUrl: flags.repo ?? "",
          ...(flags.branch ? { branch: flags.branch } : {}),
          provider: flags.provider ?? "echo",
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.scope ? { scope: flags.scope as "project" | "task" } : {}),
          ...(flags.project ? { projectId: flags.project } : {}),
        });
        await server.effectWorker.drain();
        await waitUntil(() => server.registry.isConnected(task.taskId), 20_000);
        console.log(JSON.stringify(server.tasks.status(task.taskId), null, 2));
        return;
      }
      case "list": {
        console.log(
          JSON.stringify(
            server.tasks.listTasks().map((t) => ({
              taskId: t.taskId,
              state: t.state,
              provider: t.provider,
              sandboxId: t.sandboxId,
              sandboxScope: t.sandboxScope,
              projectId: t.projectId,
              worktreePath: t.worktreePath,
              resumeKind: t.resumeKind,
            })),
            null,
            2,
          ),
        );
        return;
      }
      case "status": {
        console.log(JSON.stringify(server.tasks.status(positional[0]!), null, 2));
        return;
      }
      case "message": {
        const taskId = positional[0]!;
        // Each CLI invocation is its own short-lived control plane, so make
        // sure the task's worker is attached before sending the turn.
        await server.controlPlane.ensureReady(taskId);
        const result = server.tasks.sendMessage(taskId, {
          text: positional.slice(1).join(" ") || flags.text || "",
        });
        await server.effectWorker.drain();
        await waitUntil(() => {
          const status = server.tasks.status(taskId) as { task: { state: string } };
          return status.task.state !== "running";
        }, 60_000);
        console.log(JSON.stringify({ ...result, events: server.tasks.events(taskId) }, null, 2));
        return;
      }
      case "approve": {
        server.tasks.respondToApproval(
          positional[0]!,
          positional[1]!,
          flags.reject !== undefined ? "rejected" : "approved",
        );
        await server.effectWorker.drain();
        console.log(JSON.stringify({ ok: true }, null, 2));
        return;
      }
      case "stop":
      case "resume":
      case "destroy": {
        const taskId = positional[0]!;
        if (sub === "stop") server.tasks.stop(taskId);
        else if (sub === "resume") server.tasks.resume(taskId);
        else server.tasks.destroy(taskId);
        await server.effectWorker.drain();
        console.log(JSON.stringify({ ok: true }, null, 2));
        return;
      }
      case "checkpoint": {
        await server.controlPlane.ensureReady(positional[0]!);
        server.tasks.captureCheckpoint(positional[0]!, positional[1]!);
        await server.effectWorker.drain();
        console.log(JSON.stringify({ ok: true }, null, 2));
        return;
      }
      case "git": {
        await server.controlPlane.ensureReady(positional[0]!);
        console.log(JSON.stringify(await server.tasks.gitStatus(positional[0]!), null, 2));
        return;
      }
      default:
        throw new Error(`unknown task subcommand ${sub}`);
    }
  });
}

async function reconcile(args: string[]): Promise<void> {
  await withServer(args, async (server) => {
    console.log(JSON.stringify(await server.controlPlane.reconcile(), null, 2));
  });
}

/** Project policy: where a project's default sandbox scope lives. */
async function project(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const flags = parseFlags(rest);

  if (sub === "list") {
    await withServer(
      rest,
      async (server) => {
        console.log(JSON.stringify(server.tasks.listProjects(), null, 2));
      },
      { startEffects: false },
    );
    return;
  }

  if (sub === "add") {
    if (!flags.repo) throw new Error("project add requires --repo");
    await withServer(
      rest,
      async (server) => {
        const created = server.tasks.upsertProject({
          ...(flags.id ? { projectId: flags.id } : {}),
          ...(flags.name ? { name: flags.name } : {}),
          repositoryUrl: flags.repo!,
          ...(flags["default-scope"]
            ? { defaultScope: flags["default-scope"] as "project" | "task" }
            : {}),
          ...(flags["max-tasks"] ? { maxConcurrentTasks: Number(flags["max-tasks"]) } : {}),
          ...(flags.profile ? { environmentProfileId: flags.profile } : {}),
        });
        console.log(JSON.stringify(created, null, 2));
      },
      { startEffects: false },
    );
    return;
  }

  if (sub === "sandboxes") {
    await withServer(
      rest,
      async (server) => {
        const projects = server.tasks.listProjects();
        const target = flags.id ?? projects[0]?.projectId;
        if (!target) {
          console.log(JSON.stringify({ projects: [], sandboxes: [] }, null, 2));
          return;
        }
        console.log(
          JSON.stringify(
            { projectId: target, sandboxes: server.tasks.projectSandboxes(target) },
            null,
            2,
          ),
        );
      },
      { startEffects: false },
    );
    return;
  }

  throw new Error(`unknown project subcommand ${sub}`);
}

async function sandbox(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const positional = rest.filter((a) => !a.startsWith("--"));

  await withServer(rest, async (server) => {
    if (sub === "list") {
      console.log(JSON.stringify(server.tasks.listSandboxes(), null, 2));
      return;
    }
    if (sub === "stop" || sub === "destroy") {
      const sandboxId = positional[0];
      if (!sandboxId) throw new Error(`sandbox ${sub} requires a sandbox id`);
      // A stop that will be refused is refused here, before it is queued: the
      // client must not be told ok about something the control plane will not do.
      if (sub === "stop") {
        const refusal = server.controlPlane.stopRefusal(sandboxId);
        if (refusal.refused) {
          if (refusal.reason === "tasks_bound") {
            server.controlPlane.recordStopRefusal(sandboxId, "cli");
          }
          process.stderr.write(
            `${JSON.stringify(
              {
                ok: false,
                error:
                  refusal.reason === "sandbox_not_found"
                    ? "sandbox_not_found"
                    : "sandbox.stop_refused",
                sandboxId,
                taskCount: refusal.taskCount,
                reason: refusal.reason,
              },
              null,
              2,
            )}\n`,
          );
          process.exitCode = 1;
          return;
        }
        server.tasks.stopSandbox(sandboxId);
      } else {
        // Destroying is refused while a task is bound, and saying "ok" about a
        // refusal is how a container outlives the command that removed it.
        const refusal = server.controlPlane.destroyRefusal(sandboxId);
        if (refusal.refused) {
          process.stderr.write(
            `${JSON.stringify(
              {
                ok: false,
                error:
                  refusal.reason === "sandbox_not_found"
                    ? "sandbox_not_found"
                    : "sandbox.destroy_refused",
                sandboxId,
                taskCount: refusal.taskCount,
                reason: refusal.reason,
              },
              null,
              2,
            )}\n`,
          );
          process.exitCode = 1;
          return;
        }
        server.tasks.destroySandbox(sandboxId);
      }
      await server.effectWorker.drain();
      const record = server.tasks.listSandboxes().find((s) => s.sandboxId === sandboxId);
      if (sub === "destroy" && record && record.state !== "deleted") {
        // The effect ran and the record did not move: the backend refused.
        process.stderr.write(
          `${JSON.stringify(
            { ok: false, error: "sandbox_backend_unsupported", sandboxId, state: record.state },
            null,
            2,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: true, sandboxId, action: sub }, null, 2));
      return;
    }
    throw new Error(`unknown sandbox subcommand ${sub}`);
  });
}

async function importConfig(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const home = flags.home ?? os.homedir();
  const name = flags.name ?? "default";
  const targets = (flags.targets ?? "codex,claude,opencode")
    .split(",")
    .map((t: string) => t.trim()) as Array<"codex" | "claude" | "opencode">;

  const result = importLocalConfigs({ home, name, targets });
  const store = new ConfigBundleStore(path.join(stateDirFrom(args), "config-bundles"));
  store.save(result.bundle);
  console.log(
    JSON.stringify(
      {
        name,
        imported: result.imported,
        skipped: result.skipped,
        warnings: result.bundle.warnings,
      },
      null,
      2,
    ),
  );
}

async function doctor(args: string[] = []): Promise<void> {
  const flags = parseFlags(args);
  const workerEntry = defaultWorkerEntry();
  const baseUrl = flags["opensandbox-url"] ?? process.env.OPENSANDBOX_API_URL;
  const apiKey = flags["opensandbox-api-key"] ?? process.env.OPENSANDBOX_API_KEY;
  const image = flags["opensandbox-image"] ?? process.env.OPENSANDBOX_IMAGE;

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      detail: `node ${process.versions.node}`,
    },
    {
      name: "worker entry",
      ok: fs.existsSync(workerEntry),
      detail: workerEntry,
    },
    {
      name: "sandbox api url",
      ok: true,
      detail:
        baseUrl ??
        `${OPENSANDBOX_DEFAULT_BASE_URL} (default; set OPENSANDBOX_API_URL for a remote one)`,
    },
    {
      name: "sandbox api key",
      ok: Boolean(apiKey),
      detail: apiKey
        ? "OPENSANDBOX_API_KEY is set: `serve` picks the OpenSandbox backend automatically"
        : "OPENSANDBOX_API_KEY is not set: the server must be unauthenticated, or `serve` uses the local backend",
    },
    {
      name: "sandbox image",
      ok: true,
      detail: image ?? `${OPENSANDBOX_DEFAULT_IMAGE} (default)`,
    },
    { name: "git", ok: true, detail: "required inside sandboxes for checkpoints" },
  ];

  // Reachability is the question a deployment actually asks: does this URL
  // serve the OpenSandbox lifecycle API, and does this key work against it?
  checks.push(
    await probeOpenSandbox({
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(image ? { defaultImage: image } : {}),
    }),
  );

  console.log(JSON.stringify({ checks }, null, 2));
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

/** Ask the configured lifecycle server for its health, version and sandboxes. */
async function probeOpenSandbox(options: {
  baseUrl?: string;
  apiKey?: string;
  defaultImage?: string;
}): Promise<{ name: string; ok: boolean; detail: string }> {
  const shown = options.baseUrl ?? OPENSANDBOX_DEFAULT_BASE_URL;
  try {
    const backend = await OpenSandboxBackend.create(options);
    const health = await backend.ping();
    const sandboxes = await backend.list();
    return {
      name: "sandbox server reachable",
      ok: health.status === "healthy",
      detail:
        `${shown} answered (status ${health.status}` +
        `${health.version ? `, opensandbox-server ${health.version}` : ""}); ` +
        `${sandboxes.length === 0 ? "no t3x sandboxes" : `${sandboxes.length} t3x sandbox(es)`}`,
    };
  } catch (error) {
    return {
      name: "sandbox server reachable",
      ok: false,
      detail: `${shown} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "";
    }
  }
  return out;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify(errorPayload(err), null, 2)}\n`);
  process.exit(1);
});
