/**
 * The MCP server itself: JSON-RPC over stdio, one message per line.
 *
 * Deliberately dependency-free. MCP's stdio transport is newline-delimited
 * JSON-RPC — `initialize`, `tools/list`, `tools/call` — and every client that
 * matters (OpenClaw, Codex, Claude Desktop, mcp-inspector) speaks exactly that.
 * A bridge that has to be installed next to an agent should not drag a protocol
 * SDK and its transitive tree into the agent's own runtime.
 *
 * stdout carries protocol messages and nothing else; every diagnostic goes to
 * stderr, because one stray `console.log` corrupts the stream.
 */

import * as readline from "node:readline";

import { ControlPlaneClient, ControlPlaneRequestError } from "./ControlPlaneClient.js";
import {
  ToolInputError,
  controlPlaneTools,
  type McpToolDefinition,
  type ToolOutcome,
} from "./tools.js";

/** MCP revisions this server implements. Echoing the client's own keeps them happy. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerOptions {
  client: ControlPlaneClient;
  defaultProfileId?: string;
  startupSeconds?: number;
  serverName?: string;
  serverVersion?: string;
  log?: (line: string) => void;
}

export interface McpServer {
  readonly tools: McpToolDefinition[];
  /** Answer one JSON-RPC message; `null` means "notification, say nothing". */
  handle(message: unknown): Promise<unknown | null>;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const log = options.log ?? (() => {});
  const serverName = options.serverName ?? "t3x";
  const serverVersion = options.serverVersion ?? "0.1.0";
  const tools = controlPlaneTools({
    client: options.client,
    defaultProfileId: options.defaultProfileId ?? "default",
    startupSeconds: options.startupSeconds ?? 300_000,
    log,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const tool = byName.get(name);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool \`${name}\`. Available: ${tools.map((t) => t.name).join(", ")}.`,
          },
        ],
        isError: true,
      };
    }
    try {
      log(`t3: call ${name}`);
      const outcome = await tool.handler(args);
      return {
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
        ...(outcome.isError ? { isError: true } : {}),
      };
    } catch (error) {
      const message = describeError(error);
      log(`t3: ${name} failed: ${message}`);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };

  return {
    tools,
    async handle(message: unknown): Promise<unknown | null> {
      if (Array.isArray(message)) {
        const answers = await Promise.all(message.map((entry) => this.handle(entry)));
        const present = answers.filter((answer) => answer !== null);
        return present.length > 0 ? present : null;
      }
      if (typeof message !== "object" || message === null) {
        return errorResponse(null, -32600, "Invalid Request");
      }
      const request = message as { id?: unknown; method?: unknown; params?: unknown };
      const id = request.id ?? null;
      const method = typeof request.method === "string" ? request.method : "";
      const params = (
        typeof request.params === "object" && request.params !== null ? request.params : {}
      ) as Record<string, unknown>;
      const isNotification = request.id === undefined;

      switch (method) {
        case "initialize": {
          const requested =
            typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : DEFAULT_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: serverName, version: serverVersion },
              instructions:
                "T3 Code remote execution. Every tool starts with t3_ and drives a control plane " +
                "that owns sandboxed coding tasks: create one with t3_run (a prompt, an optional " +
                "repository, and the agent's reply), keep talking with t3_task_message, inspect the " +
                "result with t3_task_exec, t3_task_git and t3_task_files.",
            },
          };
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: tools.map((tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          };
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            typeof params.arguments === "object" && params.arguments !== null
              ? (params.arguments as Record<string, unknown>)
              : {};
          return { jsonrpc: "2.0", id, result: await callTool(name, args) };
        }
        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: [] } };
        case "resources/templates/list":
          return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: [] } };
        case "logging/setLevel":
          return { jsonrpc: "2.0", id, result: {} };
        default:
          if (isNotification) return null;
          return errorResponse(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}

/**
 * Serve MCP on a pair of streams until the input closes.
 *
 * Returns when stdin ends, which is how an MCP client shuts a stdio server
 * down: it closes the pipe, and the process is expected to follow.
 */
export async function runMcpStdioServer(
  options: McpServerOptions & {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  },
): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = createMcpServer({ ...options, log });
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const write = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };

  log(`t3x mcp: serving ${server.tools.length} tools over stdio against ${options.client.baseUrl}`);

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      write(errorResponse(null, -32700, "Parse error"));
      continue;
    }
    try {
      const answer = await server.handle(parsed);
      if (answer !== null) write(answer);
    } catch (error) {
      write(errorResponse(idOf(parsed), -32603, describeError(error)));
    }
  }
  log("t3x mcp: stdin closed, exiting");
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function idOf(message: unknown): unknown {
  if (typeof message === "object" && message !== null && "id" in message) {
    return (message as { id?: unknown }).id ?? null;
  }
  return null;
}

/** An error a model can act on: the code first, then what the control plane said. */
function describeError(error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  if (error instanceof ControlPlaneRequestError) {
    return error.code === "control_plane_unreachable" || error.code === "control_plane_timeout"
      ? `${error.code}: ${error.message}`
      : `${error.code}: ${error.message}${error.details ? ` (${JSON.stringify(error.details)})` : ""}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
