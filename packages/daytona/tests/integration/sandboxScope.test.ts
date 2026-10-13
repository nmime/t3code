/**
 * Integration: sandbox scope — one shared sandbox per project/repository by
 * default, a dedicated sandbox per task on request.
 *
 * What has to hold for the revised model to be honest:
 *
 *  1. tasks of one project share one sandbox, but never one working directory:
 *     each gets its own branch and git worktree, and the agent runs there;
 *  2. the "run this task in a new sandbox" toggle really produces a dedicated
 *     sandbox with an independent checkout;
 *  3. reuse happens only between compatible environments (profile, snapshot,
 *     credential trust domain) — otherwise a separate sandbox is provisioned;
 *  4. the project sandbox is reference counted: it survives while any task
 *     needs it and is never stopped by infrastructure idleness;
 *  5. resolution order is task -> project -> global, and changing a default
 *     never migrates a task that already exists.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createTask,
  fakeAgentBinDir,
  localOriginRepo,
  sandboxPath,
  sendMessage,
  startTestServer,
  taskWorkspace,
  tempStateDir,
  testProfile,
  waitFor,
} from "../helpers.js";
import { PolicyEngine } from "../../src/execution/PolicyEngine.js";
import { projectIdForRepository } from "../../src/contracts/sandboxScope.js";

test("project scope: one sandbox per project, one worktree per task", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const taskA = await createTask(server, { repositoryUrl: origin.url });
    const taskB = await createTask(server, { repositoryUrl: origin.url });

    // One sandbox for the project.
    assert.equal(taskA.sandboxScope, "project");
    assert.equal(taskA.sandboxId, taskB.sandboxId, "tasks of one project share a sandbox");
    assert.equal(taskA.projectId, projectIdForRepository(origin.url));
    assert.equal(server.projects.taskCount(taskA.sandboxId!), 2, "reference counted");

    // ...but never one working directory.
    assert.equal(taskA.worktreePath, `/workspace/worktrees/${taskA.taskId}`);
    assert.notEqual(taskA.worktreePath, taskB.worktreePath);
    const dirA = taskWorkspace(server, taskA);
    const dirB = taskWorkspace(server, taskB);
    assert.ok(fs.existsSync(path.join(dirA, "shared.txt")), "worktree A holds the checkout");
    assert.ok(fs.existsSync(path.join(dirB, "shared.txt")), "worktree B holds the checkout");

    // The base checkout plus two worktrees, each on its own branch.
    const worktrees = await server.workspace.listWorktrees(taskA.taskId);
    assert.equal(worktrees.length, 3, `expected base + 2 worktrees, got ${worktrees.length}`);
    const statusA = await server.tasks.gitStatus(taskA.taskId);
    const statusB = await server.tasks.gitStatus(taskB.taskId);
    assert.equal(statusA.branch, `t3x/${taskA.taskId}`);
    assert.equal(statusB.branch, `t3x/${taskB.taskId}`);

    // Writes land in that task's worktree only.
    await server.workspace.writeFile(taskA.taskId, "only-a.txt", Buffer.from("a"));
    assert.ok(fs.existsSync(path.join(dirA, "only-a.txt")));
    assert.ok(!fs.existsSync(path.join(dirB, "only-a.txt")));
    const base = sandboxPath(server, taskA.sandboxId!, "/workspace/project");
    assert.ok(!fs.existsSync(path.join(base, "only-a.txt")), "base checkout stays clean");

    // Both tasks can run a turn in the same sandbox.
    await sendMessage(server, taskA.taskId, "hello from A");
    await sendMessage(server, taskB.taskId, "hello from B");
    assert.equal(server.registry.isConnected(taskA.taskId), true);
    assert.equal(server.registry.isConnected(taskB.taskId), true);
  } finally {
    await server.stop();
  }
});

test("the toggle: a task can run in a sandbox of its own", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const shared = await createTask(server, { repositoryUrl: origin.url });
    const dedicated = await createTask(server, {
      repositoryUrl: origin.url,
      scope: "task",
    });

    assert.equal(dedicated.sandboxScope, "task");
    assert.notEqual(dedicated.sandboxId, shared.sandboxId, "dedicated sandbox is not shared");
    // A dedicated sandbox keeps the plain checkout; it has nothing to share.
    assert.equal(dedicated.worktreePath, "/workspace/project");
    assert.ok(fs.existsSync(path.join(taskWorkspace(server, dedicated), "shared.txt")));
    // The shared sandbox's other tasks are unaffected by the new one.
    assert.equal(server.projects.taskCount(shared.sandboxId!), 1);
  } finally {
    await server.stop();
  }
});

test("the agent runs in the task's worktree, not in a shared directory", async () => {
  const origin = localOriginRepo();
  const binDir = fakeAgentBinDir(
    ["#!/usr/bin/env bash", 'echo "codex agent running in $PWD"', "echo done"].join("\n"),
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const taskA = await createTask(server, { repositoryUrl: origin.url, provider: "codex" });
    const taskB = await createTask(server, { repositoryUrl: origin.url, provider: "codex" });
    assert.equal(taskA.sandboxId, taskB.sandboxId);

    await sendMessage(server, taskA.taskId, "where am I");
    const events = server.tasks.events(taskA.taskId);
    const text = JSON.stringify(events);
    const expected = taskWorkspace(server, taskA);
    assert.ok(
      text.includes(expected),
      `provider output should name task A's worktree (${expected})`,
    );
    assert.ok(
      !text.includes(taskWorkspace(server, taskB)),
      "task A's events must not mention task B's worktree",
    );
  } finally {
    await server.stop();
    process.env.PATH = originalPath;
  }
});

test("reuse only between compatible environments", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    server.profiles.createProfile({
      profileId: "node24",
      body: testProfile() as never,
    });
    server.profiles.createProfile({
      profileId: "python312",
      body: testProfile({
        runtime: { snapshot: "python312-dev-v1", resources: { cpu: 2, memoryGiB: 4 } },
      }) as never,
    });
    server.profiles.createProfile({
      profileId: "node24-secrets",
      body: testProfile({
        secrets: [{ name: "DEPLOY_TOKEN", secretRef: "DEPLOY_TOKEN" }],
      }) as never,
    });
    server.secrets.put("DEPLOY_TOKEN", "s3cret", { allowedProfiles: ["node24-secrets"] });

    const a = await createTask(server, { profileId: "node24", repositoryUrl: origin.url });
    const sameEnvironment = await createTask(server, {
      profileId: "node24",
      repositoryUrl: origin.url,
    });
    const otherSnapshot = await createTask(server, {
      profileId: "python312",
      repositoryUrl: origin.url,
    });
    const otherCredentials = await createTask(server, {
      profileId: "node24-secrets",
      repositoryUrl: origin.url,
    });

    assert.equal(a.sandboxId, sameEnvironment.sandboxId, "same environment is reused");
    assert.notEqual(
      a.sandboxId,
      otherSnapshot.sandboxId,
      "a different snapshot never shares a sandbox",
    );
    assert.notEqual(
      a.sandboxId,
      otherCredentials.sandboxId,
      "a different credential trust domain never shares a sandbox",
    );
    // The incompatible environment is still project-scoped: its own tasks will
    // reuse it, so the project holds one sandbox per environment.
    assert.equal(otherSnapshot.sandboxScope, "project");
    assert.equal(
      server.projects.listProjectSandboxes(a.projectId!).filter((s) => s.state !== "deleted")
        .length,
      3,
    );
  } finally {
    await server.stop();
  }
});

test("resolution order: task request, project default, global default", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    // Global default comes from the profile: per-task isolation.
    server.profiles.createProfile({
      profileId: "isolated",
      body: testProfile({ sandbox: { isolation: "per-task" } }) as never,
    });
    const globalDefault = await createTask(server, {
      profileId: "isolated",
      repositoryUrl: origin.url,
    });
    assert.equal(globalDefault.sandboxScope, "task");

    // A project default overrides the global default.
    const project = server.tasks.upsertProject({
      repositoryUrl: origin.url,
      defaultScope: "project",
    });
    const projectDefault = await createTask(server, {
      profileId: "isolated",
      repositoryUrl: origin.url,
      projectId: project.projectId,
    });
    assert.equal(projectDefault.sandboxScope, "project");

    // A task request overrides the project default, in both directions.
    const explicitTask = await createTask(server, {
      profileId: "isolated",
      repositoryUrl: origin.url,
      projectId: project.projectId,
      scope: "task",
    });
    assert.equal(explicitTask.sandboxScope, "task");

    // Changing a default never migrates an existing task.
    server.tasks.upsertProject({ repositoryUrl: origin.url, defaultScope: "task" });
    const afterChange = await createTask(server, {
      profileId: "isolated",
      repositoryUrl: origin.url,
      projectId: project.projectId,
    });
    assert.equal(afterChange.sandboxScope, "task", "new task follows the new default");
    assert.equal(
      server.tasks.getTask(projectDefault.taskId).sandboxScope,
      "project",
      "the running task keeps the scope it was created with",
    );
    assert.equal(
      server.tasks.getTask(projectDefault.taskId).sandboxId,
      projectDefault.sandboxId,
      "and is not moved to another sandbox",
    );
  } finally {
    await server.stop();
  }
});

test("administrator policy can forbid shared sandboxes", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({
    stateDir: tempStateDir(),
    policy: { requireTaskIsolation: true },
  });
  try {
    const a = await createTask(server, { repositoryUrl: origin.url });
    const b = await createTask(server, { repositoryUrl: origin.url });
    assert.equal(a.sandboxScope, "task");
    assert.equal(b.sandboxScope, "task");
    assert.notEqual(a.sandboxId, b.sandboxId);
  } finally {
    await server.stop();
  }
});

test("concurrency limit spills the next task into its own sandbox", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    server.tasks.upsertProject({ repositoryUrl: origin.url, maxConcurrentTasks: 1 });
    const a = await createTask(server, { repositoryUrl: origin.url });
    const b = await createTask(server, { repositoryUrl: origin.url });

    assert.equal(a.sandboxScope, "project");
    assert.notEqual(a.sandboxId, b.sandboxId);
    assert.equal(b.sandboxScope, "task", "the spill is recorded as a dedicated sandbox");
    const override = server.tasks
      .events(b.taskId)
      .find((e) => e.type === "task.sandbox_scope_overridden");
    assert.ok(override, "the override is explained in the task's event stream");
  } finally {
    await server.stop();
  }
});

test("reference counting: the project sandbox outlives its tasks", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const a = await createTask(server, { repositoryUrl: origin.url });
    const b = await createTask(server, { repositoryUrl: origin.url });
    const sandboxId = a.sandboxId!;
    const dirB = taskWorkspace(server, b);

    // Stopping one task does not stop the sandbox the other one needs.
    server.tasks.stop(a.taskId);
    await server.effectWorker.drain();
    assert.equal(server.projects.taskCount(sandboxId), 1);
    assert.equal((await server.backend.status(sandboxId)).state, "running");
    await sendMessage(server, b.taskId, "still working");

    // The policy engine refuses to stop a sandbox with tasks bound to it.
    assert.equal(await server.controlPlane.stopSandbox(sandboxId, "test"), false);
    assert.equal((await server.backend.status(sandboxId)).state, "running");

    // Destroying the first task removes only its worktree.
    server.tasks.destroy(a.taskId);
    await server.effectWorker.drain();
    assert.equal((await server.backend.status(sandboxId)).state, "running");
    assert.ok(!fs.existsSync(taskWorkspace(server, a)), "the finished task's worktree is gone");
    assert.ok(fs.existsSync(dirB), "the other task's worktree stays");

    // The last task leaving stops the project sandbox and keeps its files.
    server.tasks.destroy(b.taskId);
    await server.effectWorker.drain();
    assert.equal(server.projects.taskCount(sandboxId), 0);
    assert.equal((await server.backend.status(sandboxId)).state, "stopped");
    assert.ok(
      fs.existsSync(path.join(sandboxPath(server, sandboxId, "/workspace/project"), "shared.txt")),
      "stopping retains the project environment",
    );

    // Retention policy eventually deletes the unused environment.
    const engine = new PolicyEngine(
      server.store,
      { idleStopMinutes: 0, deleteCompletedAfterHours: 0, enforceBudget: true },
      server.projects,
    );
    const decisions = engine.evaluate(Date.now() + 1);
    assert.ok(
      decisions.some(
        (d) => d.scope === "sandbox" && d.action === "destroy" && d.sandboxId === sandboxId,
      ),
      "an unused project sandbox is eventually destroyed",
    );
    assert.equal(await server.controlPlane.destroySandbox(sandboxId, "retention"), true);
    assert.equal(server.projects.getSandbox(sandboxId)?.state, "deleted");
  } finally {
    await server.stop();
  }
});

test("a stopped project sandbox resumes for its tasks, worktrees intact", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const a = await createTask(server, { repositoryUrl: origin.url });
    await server.workspace.writeFile(a.taskId, "work-in-progress.txt", Buffer.from("wip"));
    const sandboxId = a.sandboxId!;

    server.tasks.stop(a.taskId);
    await server.effectWorker.drain();
    assert.equal(await server.controlPlane.stopSandbox(sandboxId, "idle"), true);
    assert.equal((await server.backend.status(sandboxId)).state, "stopped");

    // Resume re-attaches the same sandbox, its worktree and its worker.
    server.tasks.resume(a.taskId);
    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(a.taskId), 30_000, "worker reattach");
    const resumed = server.tasks.getTask(a.taskId);
    assert.equal(resumed.sandboxId, sandboxId, "resume reuses the project sandbox");
    assert.equal(resumed.state, "ready");
    assert.equal(resumed.resumeKind, "resumed");
    assert.ok(
      fs.existsSync(path.join(taskWorkspace(server, resumed), "work-in-progress.txt")),
      "the task's worktree survived the stop",
    );
    await sendMessage(server, a.taskId, "back to work");
  } finally {
    await server.stop();
  }
});

test("client surface reports scope, worktree and shared-sandbox facts", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const a = await createTask(server, { repositoryUrl: origin.url });
    const b = await createTask(server, { repositoryUrl: origin.url });

    const status = server.tasks.status(a.taskId) as Record<string, unknown>;
    assert.equal(status.sandboxScope, "project");
    assert.equal(status.worktreePath, `/workspace/worktrees/${a.taskId}`);
    assert.equal(status.sharedWith, 1, "one other task shares the sandbox");
    assert.equal((status.binding as { scope: string }).scope, "project");

    const sandboxes = server.tasks.listSandboxes();
    assert.equal(sandboxes.length, 1);
    assert.deepEqual((sandboxes[0]!.boundTasks as string[]).sort(), [a.taskId, b.taskId].sort());
    assert.equal(server.tasks.projectSandboxes(a.projectId!).length, 1);
    assert.equal(server.tasks.listProjects()[0]!.projectId, a.projectId);
  } finally {
    await server.stop();
  }
});

/**
 * The execution settings page a GUI has to draw: the project list with its
 * default scope, the sandboxes under a project and which tasks share one, the
 * per-task toggle, and stop/destroy — all over the client HTTP API, the way the
 * Mac and phone clients reach them.
 */
test("HTTP API: projects, sandboxes and the scope toggle", async () => {
  const origin = localOriginRepo();
  const server = await startTestServer({ stateDir: tempStateDir() });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (url: string, payload: unknown = {}) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    server.profiles.createProfile({ profileId: "test", body: testProfile() as never });

    // Settings -> Execution: a project default.
    const created = (await (
      await post("/projects", {
        repositoryUrl: origin.url,
        defaultScope: "project",
        maxConcurrentTasks: 2,
      })
    ).json()) as { project: { projectId: string; defaultScope: string } };
    assert.equal(created.project.defaultScope, "project");

    // A task created the way the GUI creates one: no scope of its own.
    const first = (await (
      await post("/tasks", {
        profileId: "test",
        repositoryUrl: origin.url,
        provider: "echo",
        projectId: created.project.projectId,
      })
    ).json()) as { task: { taskId: string; sandboxScope: string; sandboxId: string } };
    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(first.task.taskId), 30_000, "worker");
    assert.equal(first.task.sandboxScope, "project");

    // ...and the same page's toggle: "run this task in a new sandbox".
    const toggled = (await (
      await post("/tasks", {
        profileId: "test",
        repositoryUrl: origin.url,
        provider: "echo",
        projectId: created.project.projectId,
        scope: "task",
      })
    ).json()) as { task: { taskId: string; sandboxScope: string; sandboxId: string } };
    await server.effectWorker.drain();
    await waitFor(() => server.registry.isConnected(toggled.task.taskId), 30_000, "worker");
    assert.equal(toggled.task.sandboxScope, "task");

    // What the settings page reads back.
    const projects = (await (await fetch(`${base}/projects`)).json()) as {
      projects: Array<{ projectId: string }>;
    };
    assert.equal(projects.projects.length, 1);
    const listed = (await (await fetch(`${base}/sandboxes`)).json()) as {
      sandboxes: Array<{ sandboxId: string; scope: string; boundTasks: string[] }>;
    };
    assert.equal(listed.sandboxes.length, 2, "the project sandbox and the task's own");
    const shared = listed.sandboxes.find((s) => s.boundTasks.includes(first.task.taskId));
    assert.ok(shared, "the shared project sandbox is listed");
    assert.notEqual(shared.sandboxId, toggled.task.sandboxId);
    assert.equal(shared.scope, "project");

    const projectSandboxes = (await (
      await fetch(`${base}/projects/${created.project.projectId}/sandboxes`)
    ).json()) as { sandboxes: Array<{ sandboxId: string }> };
    assert.deepEqual(
      projectSandboxes.sandboxes.map((s) => s.sandboxId),
      [shared.sandboxId],
    );

    // Stopping a sandbox a task still needs is refused, and says why.
    const refusedStop = await post(`/sandboxes/${shared.sandboxId}/stop`);
    assert.equal(refusedStop.status, 409);
    assert.equal(
      ((await refusedStop.json()) as { error: { code: string } }).error.code,
      "sandbox_stop_refused",
    );
    await server.effectWorker.drain();
    assert.equal((await server.backend.status(shared.sandboxId)).state, "running");
    assert.ok(
      server.store.eventsSince(shared.sandboxId, 0).some((e) => e.type === "sandbox.stop_refused"),
      "the refusal is on the sandbox's stream",
    );

    // Once the tasks are gone it stops, and only then can be destroyed.
    await post(`/tasks/${first.task.taskId}/destroy`);
    await post(`/tasks/${toggled.task.taskId}/destroy`);
    await server.effectWorker.drain();
    assert.equal((await server.backend.status(shared.sandboxId)).state, "stopped");
    await post(`/sandboxes/${shared.sandboxId}/destroy`);
    await server.effectWorker.drain();
    assert.equal(server.projects.getSandbox(shared.sandboxId)?.state, "deleted");
  } finally {
    await server.stop();
  }
});
