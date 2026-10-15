/**
 * The MCP bridge against a real control plane and a real worker.
 *
 * This is the path OpenClaw takes: an MCP client spawns `t3x mcp`, the bridge
 * speaks the client HTTP API with a bearer token, and a task in a sandbox
 * answers. The unit tests cover the protocol; this covers the claim that an
 * agent elsewhere can actually drive T3 through it — create a task from a
 * repository, read its answer, run a command inside it, read its git status,
 * and shut the server down by closing stdin.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import { localOriginRepo, startTestServer, tempStateDir, testProfile } from "../helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

interface JsonRpcAnswer {
  id?: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
    serverInfo?: { name: string };
    protocolVersion?: string;
  };
  error?: { code: number; message: string };
}

/** A JSON-RPC client over the bridge's own pipes. */
function bridgeClient(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, (answer: JsonRpcAnswer) => void>();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    const answer = JSON.parse(line) as JsonRpcAnswer;
    const resolve = answer.id === undefined ? undefined : pending.get(answer.id);
    if (resolve) {
      pending.delete(answer.id!);
      resolve(answer);
    }
  });
  let nextId = 1;
  return async (method: string, params: unknown = {}): Promise<JsonRpcAnswer> => {
    const id = nextId++;
    const answer = new Promise<JsonRpcAnswer>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answer;
  };
}

const text = (answer: JsonRpcAnswer): string =>
  (answer.result?.content ?? []).map((part) => part.text).join("\n");

/**
 * The reply text without whitespace. A streaming provider's chunks are joined
 * line by line, which is exact for a CLI agent (one chunk per output line) and
 * can split a word for the deterministic echo runtime, whose chunks are
 * arbitrary halves. The test is about the text arriving, not the spacing.
 */
const flatten = (value: string): string => value.replace(/\s+/g, "");

test("MCP: an external client drives a real T3 task", async () => {
  const stateDir = tempStateDir("t3x-mcp-");
  const server = await startTestServer({
    stateDir,
    autoStartEffects: true,
    apiToken: "bridge-token",
  });
  server.profiles.createProfile({ profileId: "test", body: testProfile() as never });
  const origin = localOriginRepo();

  const child = spawn(
    "node",
    [
      cli,
      "mcp",
      "--url",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "bridge-token",
      "--profile",
      "test",
      "--startup-seconds",
      "120",
    ],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr: string[] = [];
  readline
    .createInterface({ input: child.stderr, crlfDelay: Infinity })
    .on("line", (line) => stderr.push(line));
  const rpc = bridgeClient(child);

  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "openclaw-test", version: "1" },
    });
    assert.equal(init.result?.serverInfo?.name, "t3x");

    const tools = await rpc("tools/list");
    assert.ok((tools.result?.tools ?? []).length >= 15);

    const status = await rpc("tools/call", { name: "t3_status", arguments: {} });
    assert.equal(status.result?.isError, undefined);
    assert.match(text(status), /answered ok=true/);

    // The whole point: one call that starts a task and comes back with the answer.
    const run = await rpc("tools/call", {
      name: "t3_run",
      arguments: {
        prompt: "say hello from the bridge",
        repositoryUrl: origin.url,
        waitSeconds: 120,
      },
    });
    assert.equal(run.result?.isError, undefined, text(run));
    const structured = run.result?.structuredContent as
      | { task?: { taskId?: string }; reply?: string }
      | undefined;
    const taskId = String(structured?.task?.taskId ?? "");
    assert.match(taskId, /^task_/, `no task id in ${text(run)}`);
    assert.match(flatten(text(run)), /echo\[[a-z-]+\]:sayhellofromthebridge/);

    // The task really ran in a sandbox on a real checkout.
    const exec = await rpc("tools/call", {
      name: "t3_task_exec",
      arguments: { taskId, command: "pwd && ls && cat README.md" },
    });
    assert.equal(exec.result?.isError, undefined, text(exec));
    assert.match(text(exec), /shared project/);

    const git = await rpc("tools/call", {
      name: "t3_task_git",
      arguments: { taskId, kind: "status" },
    });
    assert.equal(git.result?.isError, undefined, text(git));

    const list = await rpc("tools/call", { name: "t3_task_list", arguments: { limit: 5 } });
    assert.match(text(list), new RegExp(taskId));

    // A follow-up message continues the same task, in the same sandbox.
    const followUp = await rpc("tools/call", {
      name: "t3_task_message",
      arguments: { taskId, text: "and again", waitSeconds: 120 },
    });
    assert.match(flatten(text(followUp)), /echo\[[a-z-]+\]:andagain/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await server.stop();
  }

  assert.match(stderr.join("\n"), /serving \d+ tools over stdio/);
  assert.doesNotMatch(stderr.join("\n"), /Error|error TS/);
});

test("MCP: a wrong token is reported as a tool error, not a hang", async () => {
  const server = await startTestServer({
    stateDir: tempStateDir("t3x-mcp-auth-"),
    apiToken: "right",
  });
  const child = spawn(
    "node",
    [
      cli,
      "mcp",
      "--url",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "wrong",
      "--profile",
      "test",
    ],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
  );
  const rpc = bridgeClient(child);
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    const answer = await rpc("tools/call", { name: "t3_status", arguments: {} });
    assert.equal(answer.result?.isError, true);
    assert.match(text(answer), /unauthorized/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await server.stop();
  }
});
