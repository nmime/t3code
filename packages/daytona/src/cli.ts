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
import YAML from "yaml";
import { ControlPlaneServer, defaultWorkerEntry } from "./execution/ControlPlaneServer.js";
import { parseProfileYaml } from "./contracts/environmentProfile.js";
import { importLocalConfigs } from "./config-importer/importer.js";
import { ConfigBundleStore } from "./config-importer/ConfigBundle.js";
import { errorPayload } from "./contracts/errors.js";

const USAGE = `t3x — T3 Code remote execution control plane

Usage:
  t3x serve [--state-dir DIR] [--port N] [--api-token TOKEN]
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
  t3x doctor

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
  if (!command || command === "help" || command === "--help") {
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
    case "import-config":
      return importConfig(rest);
    case "doctor":
      return doctor();
    default:
      process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

function stateDirFrom(args: string[]): string {
  const { values } = parseArgs({
    args,
    options: { "state-dir": { type: "string" } },
    strict: false,
  });
  const dir = (values as Record<string, string | undefined>)["state-dir"];
  return path.resolve(dir ?? path.join(os.homedir(), ".t3-daytona"));
}

async function withServer<T>(
  args: string[],
  fn: (server: ControlPlaneServer) => Promise<T>,
  options: { startEffects?: boolean } = {},
): Promise<T> {
  const stateDir = stateDirFrom(args);
  const server = await ControlPlaneServer.start({
    stateDir,
    port: 0,
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
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      port: { type: "string" },
      "api-token": { type: "string" },
    },
    strict: false,
  });
  const v = values as Record<string, string | undefined>;
  const stateDir = path.resolve(v["state-dir"] ?? path.join(os.homedir(), ".t3-daytona"));
  const port = Number(v.port ?? 8087);
  const apiToken = v["api-token"] ?? process.env.T3X_API_TOKEN ?? null;

  const server = await ControlPlaneServer.start({
    stateDir,
    port,
    apiToken,
    workerEntry: defaultWorkerEntry(),
  });

  console.log(`t3x control plane listening on http://127.0.0.1:${server.port}`);
  console.log(`  state dir:    ${stateDir}`);
  console.log(`  worker url:   ${server.workerUrl}`);
  console.log(`  backend:      ${server.backend.kind}`);
  console.log(`  api auth:     ${apiToken ? "bearer token required" : "open (development)"}`);

  await server.recovery.recover();
  const sweep = setInterval(() => {
    void server.recovery.sweep();
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
        console.log(
          JSON.stringify({ ...result, events: server.tasks.events(taskId) }, null, 2),
        );
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
      if (sub === "stop") server.tasks.stopSandbox(sandboxId);
      else server.tasks.destroySandbox(sandboxId);
      await server.effectWorker.drain();
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

async function doctor(): Promise<void> {
  const workerEntry = defaultWorkerEntry();
  const checks = [
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
      name: "daytona sdk",
      ok: true,
      detail: fs.existsSync(path.join(process.cwd(), "node_modules", "@daytona-io"))
        ? "installed"
        : "not installed (local backend only)",
    },
    { name: "git", ok: true, detail: "required inside sandboxes for checkpoints" },
  ];
  console.log(JSON.stringify({ checks }, null, 2));
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
