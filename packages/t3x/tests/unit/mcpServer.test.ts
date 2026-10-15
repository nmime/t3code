/**
 * The MCP bridge, at the protocol level.
 *
 * The bridge is what lets an agent elsewhere — OpenClaw on the VPS — drive T3,
 * so the things that have to hold are the ones a client depends on: the tool
 * list is complete and each schema is a closed object, a control-plane failure
 * comes back as a *tool* error (not a broken JSON-RPC stream), and nothing but
 * protocol messages ever reaches stdout.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";

import { ControlPlaneClient } from "../../src/mcp/ControlPlaneClient.js";
import { createMcpServer, runMcpStdioServer } from "../../src/mcp/stdioServer.js";
import type { StoredEvent } from "../../src/mcp/ControlPlaneClient.js";
import { extractReply, summariseEvents } from "../../src/mcp/tools.js";

/** A control plane that answers from a table instead of a socket. */
function stubClient(
  routes: Record<string, { status?: number; body: unknown }>,
  seen: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [],
): ControlPlaneClient {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    seen.push({
      method: init?.method ?? "GET",
      path,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const match = routes[`${init?.method ?? "GET"} ${path.split("?")[0]}`];
    if (!match) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: path } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new ControlPlaneClient({ baseUrl: "http://127.0.0.1:8087", token: "tok", fetchImpl });
}

function server(
  routes: Record<string, { status?: number; body: unknown }>,
  seen: Array<never> = [],
) {
  return createMcpServer({
    client: stubClient(routes, seen as never),
    defaultProfileId: "default",
    startupSeconds: 1000,
    log: () => {},
  });
}

test("initialize, tools/list: every tool has a closed schema and a description", async () => {
  const mcp = server({});
  const init = (await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  })) as {
    result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown };
  };
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "t3x");

  const listed = (await mcp.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })) as {
    result: {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    };
  };
  const names = listed.result.tools.map((tool) => tool.name);
  for (const expected of [
    "t3_status",
    "t3_task_create",
    "t3_run",
    "t3_task_message",
    "t3_task_wait",
    "t3_task_exec",
    "t3_task_git",
    "t3_task_files",
    "t3_task_events",
    "t3_task_stop",
    "t3_task_destroy",
    "t3_sandbox_list",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  for (const tool of listed.result.tools) {
    assert.ok(tool.name.startsWith("t3_"), `${tool.name} is not namespaced`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} schema is not an object`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} schema is open`);
  }
});

test("a tool call reaches the control plane with the bearer token and answers", async () => {
  const seen: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const mcp = server(
    {
      "GET /health": { body: { ok: true, tasks: 7 } },
      "GET /profiles": { body: { profiles: [{ profileId: "default", version: 4 }] } },
    },
    seen as never,
  );
  const answer = (await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "t3_status", arguments: {} },
  })) as {
    result: { content: Array<{ text: string }>; isError?: boolean; structuredContent?: unknown };
  };

  assert.equal(answer.result.isError, undefined);
  assert.match(answer.result.content[0]!.text, /answered ok=true with 7 task/);
  assert.match(answer.result.content[0]!.text, /default/);
  assert.equal(seen[0]!.headers.authorization, "Bearer tok");
});

test("a control-plane refusal is a tool error with its code, not a broken stream", async () => {
  const mcp = server({
    "GET /tasks/task_x": {
      status: 401,
      body: { error: { code: "unauthorized", message: "bad token" } },
    },
  });
  const answer = (await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "t3_task_get", arguments: { taskId: "task_x" } },
  })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0]!.text, /^unauthorized: bad token/);
});

test("a missing argument is refused before any request is made", async () => {
  const seen: Array<unknown> = [];
  const mcp = server({}, seen as never);
  const answer = (await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "t3_run", arguments: {} },
  })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0]!.text, /`prompt` is required/);
  assert.equal(seen.length, 0);
});

test("an unknown tool names the ones that exist", async () => {
  const mcp = server({});
  const answer = (await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "t3_nope", arguments: {} },
  })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0]!.text, /Unknown tool .*t3_run/s);
});

test("notifications get no answer and an unknown method is a JSON-RPC error", async () => {
  const mcp = server({});
  assert.equal(
    await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    null,
  );
  const unknown = (await mcp.handle({ jsonrpc: "2.0", id: 9, method: "nope", params: {} })) as {
    error: { code: number; message: string };
  };
  assert.equal(unknown.error.code, -32601);
});

test("the assistant reply is the streamed chunks, and only the assistant's", () => {
  const events: StoredEvent[] = [
    { seq: 1, type: "turn.updated", payload: { turn: { status: "running" } } },
    { seq: 2, type: "message.updated", payload: { message: { role: "user", text: "do it" } } },
    {
      seq: 3,
      type: "message.updated",
      payload: { message: { role: "assistant", text: "line one", streaming: true } },
    },
    {
      seq: 4,
      type: "message.updated",
      payload: { message: { role: "assistant", text: "line two", streaming: true } },
    },
    {
      seq: 5,
      type: "message.updated",
      payload: { message: { role: "assistant", text: "", streaming: false } },
    },
  ];
  assert.equal(extractReply(events), "line one\nline two");
  const summarised = summariseEvents(events);
  assert.equal(summarised.length, 3);
  assert.equal(summarised[2]!.type, "assistant_reply");
  assert.equal(summarised[2]!.detail, "line one / line two");
});

test("stdio: a line in, a line out, and stdout carries nothing else", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const log: string[] = [];
  const running = runMcpStdioServer({
    client: stubClient({
      "GET /health": { body: { ok: true, tasks: 1 } },
      "GET /profiles": { body: { profiles: [{ profileId: "default" }] } },
    }),
    log: (line) => log.push(line),
    input,
    output,
  });

  const lines: string[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line);
  });

  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`,
  );
  input.write("not json\n");
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "t3_status", arguments: {} } })}\n`,
  );
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  input.end();
  await running;

  assert.equal(lines.length, 3, `expected 3 answers, got ${lines.join(" | ")}`);
  const answers = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(
    (answers[0] as { result: { protocolVersion: string } }).result.protocolVersion,
    "2024-11-05",
  );
  assert.equal((answers[1] as { error: { code: number } }).error.code, -32700);
  assert.match(
    JSON.stringify((answers[2] as { result: { content: Array<{ text: string }> } }).result),
    /answered ok=true/,
  );
  for (const line of lines)
    assert.doesNotMatch(line, /serving 1[0-9] tools/, "logs leaked to stdout");
  assert.ok(
    log.some((line) => line.includes("serving")),
    "the server should log to its own channel",
  );
});
