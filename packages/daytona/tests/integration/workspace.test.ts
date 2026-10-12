/**
 * Integration: report §9 scenarios 2 and 5.
 *
 *  2. Import a reusable environment configuration and verify provider
 *     settings, tools, skills and MCP servers land in the sandbox.
 *  5. Verify that diffs, Git state and checkpoints refer to the correct
 *     sandbox — never to a different repository on the VPS.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createTask,
  sandboxHome,
  sandboxWorkspace,
  startTestServer,
  tempStateDir,
  testProfile,
  waitFor,
} from "../helpers.js";
import { importLocalConfigs } from "../../src/config-importer/importer.js";

async function initRepo(server: Awaited<ReturnType<typeof startTestServer>>, taskId: string) {
  const result = await server.tasks.execute(
    taskId,
    [
      "git init -q -b main",
      "git config user.email t3x@example.com",
      "git config user.name t3x",
      "printf 'line one\\n' > app.ts",
      "git add -A",
      "git commit -qm 'initial commit'",
    ].join(" && "),
  );
  assert.equal(result.exitCode, 0, result.output);
}

test("scenario 5: git state, diffs and checkpoints belong to the task sandbox", async () => {
  const server = await startTestServer({ stateDir: tempStateDir() });
  try {
    const taskA = await createTask(server);
    const taskB = await createTask(server);
    await initRepo(server, taskA.taskId);
    await initRepo(server, taskB.taskId);

    // Clean tree on the task's own branch.
    const status = await server.tasks.gitStatus(taskA.taskId);
    assert.equal(status.clean, true);
    assert.equal(status.branch, "main");

    // A file written through the remote workspace service shows up in *that*
    // sandbox and nowhere else.
    await server.workspace.writeFile(taskA.taskId, "feature.ts", Buffer.from("export {};\n"));
    const afterWrite = await server.tasks.gitStatus(taskA.taskId);
    assert.ok(afterWrite.entries.some((e) => e.path === "feature.ts" && e.untracked));
    assert.ok(
      fs.existsSync(path.join(sandboxWorkspace(server, taskA), "feature.ts")),
      "file lands in task A's sandbox",
    );
    assert.ok(
      !fs.existsSync(path.join(sandboxWorkspace(server, taskB), "feature.ts")),
      "and not in task B's sandbox",
    );

    // Checkpoint capture + diff + restore.
    await server.tasks.captureCheckpoint(taskA.taskId, "cp1", "before refactor");
    await server.effectWorker.drain();
    const withCheckpoint = await server.tasks.gitStatus(taskA.taskId);
    assert.ok(withCheckpoint.checkpoints.includes("cp1"));

    await server.workspace.writeFile(taskA.taskId, "app.ts", Buffer.from("line one\nline two\n"));
    const diff = await server.workspace.diffCheckpoints(taskA.taskId, "cp1", null);
    assert.match(diff, /\+line two/);

    await server.workspace.restoreCheckpoint(taskA.taskId, "cp1");
    const restored = await server.workspace.readFile(taskA.taskId, "app.ts");
    assert.equal(restored.toString(), "line one\n");

    // The checkpoint registry is per task.
    const statusB = await server.tasks.gitStatus(taskB.taskId);
    assert.deepEqual(statusB.checkpoints, []);

    // Workspace paths cannot escape the task's sandbox.
    await assert.rejects(
      () => server.tasks.listDir(taskA.taskId, "../"),
      /escapes the task workspace/,
    );

    // A task with no worker refuses workspace operations instead of falling
    // back to the VPS filesystem.
    server.registry.dropConnection(taskB.taskId, "test");
    await assert.rejects(
      () => server.tasks.gitStatus(taskB.taskId),
      /Execution target for task .* is unavailable/,
    );
  } finally {
    await server.stop();
  }
});

test("scenario 2: imported configuration is provisioned into the sandbox", async () => {
  const stateDir = tempStateDir();
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "t3x-mac-home-"));
  fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    'model = "gpt-5-codex"\nopenai_api_key = "sk-abcdefghijklmnop1234"\n',
  );
  fs.writeFileSync(path.join(home, ".codex", "skills", "review.md"), "# code review skill\n");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ mcp: { filesystem: { command: "npx", args: ["-y", "mcp-fs"] } } }),
  );

  const server = await startTestServer({ stateDir });
  try {
    // Import on the VPS, store as a reusable bundle.
    const imported = importLocalConfigs({ home, name: "mac-config-v1" });
    server.bundles.save(imported.bundle);
    assert.equal(server.bundles.get("mac-config-v1")!.files.length, 3);

    server.profiles.createProfile({
      profileId: "with-config",
      body: testProfile({
        configuration: { sources: [{ profile: "mac-config-v1" }] },
      }) as never,
    });

    const task = await createTask(server, { profileId: "with-config" });
    const sandboxHomeDir = sandboxHome(server, task);

    // Provider settings, skills and MCP definitions arrive in the sandbox.
    const codexConfig = fs.readFileSync(path.join(sandboxHomeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexConfig, /model = "gpt-5-codex"/);
    assert.ok(!codexConfig.includes("sk-abcdefghijklmnop1234"), "credentials never travel");
    assert.ok(fs.existsSync(path.join(sandboxHomeDir, ".codex", "skills", "review.md")));
    const opencode = JSON.parse(
      fs.readFileSync(path.join(sandboxHomeDir, ".config", "opencode", "opencode.json"), "utf8"),
    ) as { mcp: { filesystem: { command: string } } };
    assert.equal(opencode.mcp.filesystem.command, "npx");

    // The event log records which configuration files were applied.
    const applied = server.tasks
      .events(task.taskId)
      .find((e) => e.type === "task.configuration_applied");
    assert.ok(applied, "configuration application is auditable");
    assert.equal((applied!.payload.files as string[]).length, 3);

    // The task still runs turns with the imported configuration in place.
    server.tasks.sendMessage(task.taskId, { text: "review the diff" });
    await server.effectWorker.drain();
    await waitFor(() => server.tasks.getTask(task.taskId).state === "ready", 15_000, "turn");
  } finally {
    await server.stop();
  }
});
