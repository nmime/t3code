import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ControlPlaneServer } from "../src/execution/ControlPlaneServer.js";
import { ProcessWorkerLauncher } from "../src/execution/SandboxControlPlane.js";
import type { TaskRecord } from "../src/contracts/execution.js";

export function tempStateDir(prefix = "t3x-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestServer extends ControlPlaneServer {
  launcher: ProcessWorkerLauncher;
}

export async function startTestServer(options: {
  stateDir: string;
  port?: number;
  policy?: unknown;
  attachTimeoutMs?: number;
}): Promise<TestServer> {
  const launcher = new ProcessWorkerLauncher();
  const server = (await ControlPlaneServer.start({
    stateDir: options.stateDir,
    port: options.port ?? 0,
    launcher,
    autoStartEffects: false,
    ...(options.policy ? { policy: options.policy } : {}),
    workerAttachTimeoutMs: options.attachTimeoutMs ?? 30_000,
  })) as TestServer;
  server.launcher = launcher;
  return server;
}

export function testProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: "t3-daytona/v1",
    kind: "EnvironmentProfile",
    metadata: { name: "test-profile", version: 1 },
    runtime: { snapshot: "node24-dev-v3", resources: { cpu: 2, memoryGiB: 4 } },
    project: { workingDirectory: "/workspace/project", setup: [] },
    environment: { NODE_ENV: "development" },
    agents: { allowed: ["echo", "codex", "claude"], defaults: { provider: "echo" } },
    ...overrides,
  };
}

/** Create a task, run its provision effect and wait for the worker to attach. */
export async function createTask(
  server: TestServer,
  input: {
    profileId?: string;
    profile?: Record<string, unknown>;
    provider?: string;
    repositoryUrl?: string;
    branch?: string;
    model?: string;
    budgetCents?: number | null;
    /** "project" (default) shares one sandbox per repo; "task" is dedicated. */
    scope?: "project" | "task";
    projectId?: string;
  } = {},
): Promise<TaskRecord> {
  const profileId = input.profileId ?? "test";
  if (!server.profiles.listProfiles().some((p) => p.profileId === profileId)) {
    server.profiles.createProfile({
      profileId,
      body: (input.profile ?? testProfile()) as never,
    });
  }
  const task = server.tasks.createTask({
    profileId,
    repositoryUrl: input.repositoryUrl ?? "",
    provider: input.provider ?? "echo",
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.budgetCents !== undefined ? { budgetCents: input.budgetCents } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  await server.effectWorker.drain();
  await waitFor(() => server.registry.isConnected(task.taskId), 30_000, "worker attach");
  return server.tasks.getTask(task.taskId);
}

/** Send a message and wait until the task is no longer running. */
export async function sendMessage(server: TestServer, taskId: string, text: string): Promise<void> {
  server.tasks.sendMessage(taskId, { text });
  await server.effectWorker.drain();
  await waitFor(() => server.tasks.getTask(taskId).state !== "running", 30_000, "turn to finish");
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Create a fake CLI agent on PATH (used to exercise the real CLI runtime). */
export function fakeAgentBinDir(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-bin-"));
  const file = path.join(dir, "codex");
  fs.writeFileSync(file, script, { mode: 0o755 });
  return dir;
}

export function sandboxWorkspace(server: TestServer, task: TaskRecord): string {
  if (!task.sandboxId) throw new Error("task has no sandbox");
  return path.join(server.stateDir, "sandboxes", task.sandboxId, "workspace", "project");
}

export function sandboxHome(server: TestServer, task: TaskRecord): string {
  if (!task.sandboxId) throw new Error("task has no sandbox");
  return path.join(server.stateDir, "sandboxes", task.sandboxId, "home");
}

/** Local (host) path of a sandbox-absolute path inside a task's sandbox. */
export function sandboxPath(
  server: TestServer,
  sandboxId: string,
  sandboxAbsolute: string,
): string {
  return path.join(server.stateDir, "sandboxes", sandboxId, sandboxAbsolute.replace(/^\//, ""));
}

/**
 * The worker's state directory inside a sandbox: provider-native session state,
 * the effect ledger and the event spool live here, and they have to survive a
 * stop/resume of the sandbox.
 */
export function sandboxStateDir(server: TestServer, sandboxId: string): string {
  return sandboxPath(server, sandboxId, "/workspace/.t3x-state");
}

/**
 * Local directory the task's agent actually works in: its own worktree in a
 * shared project sandbox, or the checkout of its dedicated sandbox.
 */
export function taskWorkspace(server: TestServer, task: TaskRecord): string {
  if (!task.sandboxId) throw new Error("task has no sandbox");
  const target = task.worktreePath || task.profile.body.project.workingDirectory;
  return sandboxPath(server, task.sandboxId, target);
}

/** A real git repository on disk that tasks can clone and branch from. */
export function localOriginRepo(prefix = "t3x-origin-"): { url: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const run = (command: string) => {
    const result = spawnSync("bash", ["-c", command], { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git setup failed: ${command}\n${result.stderr}`);
    }
  };
  run("git init -q -b main");
  run("git config user.email t3x@example.com");
  run("git config user.name t3x");
  fs.writeFileSync(path.join(dir, "README.md"), "# shared project\n");
  fs.writeFileSync(path.join(dir, "shared.txt"), "shared\n");
  run("git add -A && git commit -qm 'initial commit'");
  return { url: dir, dir };
}
