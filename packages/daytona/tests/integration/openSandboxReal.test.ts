/**
 * The OpenSandbox backend against a *real* lifecycle server.
 *
 * Skipped unless `OPENSANDBOX_API_URL` is set (with `OPENSANDBOX_API_KEY`
 * when the server authenticates), because it creates real containers:
 *
 *   OPENSANDBOX_API_URL=https://sandbox.example.com \
 *   OPENSANDBOX_API_KEY=… \
 *   OPENSANDBOX_IMAGE=node:24-slim \
 *   node --test dist/tests/integration/openSandboxReal.test.js
 *
 * It is the test that caught the things the fake could not: that execd's
 * routes really are behind `/proxy/44772`, that a failing command really
 * answers with an `error` event, and that the lifecycle server really applies
 * `resourceLimits` to the container.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenSandboxBackend } from "../../src/execution/backends/opensandbox/OpenSandboxBackend.js";
import type { SandboxSpec } from "../../src/execution/backends/SandboxBackend.js";

const baseUrl = process.env.OPENSANDBOX_API_URL ?? "";
const apiKey = process.env.OPENSANDBOX_API_KEY ?? "";
const image = process.env.OPENSANDBOX_IMAGE ?? "node:24-slim";
const enabled = baseUrl !== "";
const skip = enabled ? false : "set OPENSANDBOX_API_URL to run against a real server";

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    taskId: `task-real-${Date.now()}`,
    snapshot: "",
    platform: "",
    resources: { cpu: 1, memoryGiB: 1, diskGiB: 1 },
    env: { T3X_SMOKE: "1" },
    setup: [],
    workingDirectory: "/workspace/project",
    secrets: [],
    stopAfterIdleMinutes: 10,
    ...overrides,
  };
}

test("health and version answer without a key", { skip }, async () => {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, "healthy");
});

test("a real sandbox runs a command, holds files and reports its state", { skip }, async () => {
  const backend = await OpenSandboxBackend.create({ baseUrl, apiKey, defaultImage: image });
  const request = spec();
  const handle = await backend.create(request);
  try {
    const status = await backend.status(handle.id);
    assert.equal(status.state, "running");
    assert.equal(status.backend, "opensandbox");
    assert.equal(status.taskId, request.taskId, "the task id round-trips through the server");

    const ok = await backend.exec(handle.id, "node -v && echo t3x-ok", {
      cwd: "/workspace/project",
    });
    assert.equal(ok.exitCode, 0, `stdout=${ok.stdout} stderr=${ok.stderr}`);
    assert.match(ok.stdout, /t3x-ok/);

    const failed = await backend.exec(handle.id, "echo to-stdout; echo to-stderr >&2; exit 3");
    assert.equal(failed.exitCode, 3, `stdout=${failed.stdout} stderr=${failed.stderr}`);
    assert.match(failed.stdout, /to-stdout/);
    assert.match(failed.stderr, /to-stderr/);

    await backend.writeFile(
      handle.id,
      "/workspace/project/hello.txt",
      Buffer.from("hi\n", "utf8"),
      0o644,
    );
    assert.equal(
      (await backend.readFile(handle.id, "/workspace/project/hello.txt")).toString("utf8"),
      "hi\n",
    );

    const entries = await backend.listDir(handle.id, "/workspace/project");
    assert.ok(entries.some((entry) => entry.name === "hello.txt" && entry.kind === "file"));

    const link = await backend.previewUrl(handle.id, 3000, 60);
    assert.match(link.url, /\/v1\/sandboxes\/.+\/proxy\/3000\/$/);

    const listed = await backend.list();
    assert.ok(listed.some((sandbox) => sandbox.id === handle.id));
  } finally {
    await backend.destroy(handle.id);
  }
  await assert.rejects(() => backend.status(handle.id), /sandbox/i);
});

test("a detached command outlives the call that started it", { skip }, async () => {
  const backend = await OpenSandboxBackend.create({ baseUrl, apiKey, defaultImage: image });
  const handle = await backend.create(spec());
  try {
    await backend.execDetached(handle.id, "sleep 30 && echo done > /tmp/detached.txt", {
      cwd: "/workspace/project",
    });
    // The call returned; the sandbox is still ours and still healthy.
    assert.equal((await backend.status(handle.id)).state, "running");
    const probe = await backend.exec(handle.id, "pgrep -f 'sleep 30' | head -1");
    assert.equal(
      probe.exitCode,
      0,
      `the detached command is not running: ${probe.stdout}${probe.stderr}`,
    );
  } finally {
    await backend.destroy(handle.id);
  }
});
