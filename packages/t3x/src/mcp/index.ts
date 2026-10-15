/**
 * `t3x mcp` — the control plane as an MCP server on stdio.
 *
 * This is the bridge that lets an agent elsewhere drive T3: OpenClaw on the VPS
 * adds it as one `mcp.servers` entry and its own agent gets `t3_run`,
 * `t3_task_message`, `t3_task_exec`, `t3_task_git` and the rest as tools.
 *
 *   t3x mcp [--url http://127.0.0.1:8087] [--token TOKEN] [--profile default]
 *
 * The URL and the token come from `T3X_API_URL` and `T3X_API_TOKEN` when the
 * flags are omitted, which is how a supervisor (or an MCP client's own `env`
 * block) hands them over without putting a credential on a command line.
 */

import { ControlPlaneClient } from "./ControlPlaneClient.js";
import { runMcpStdioServer } from "./stdioServer.js";

export * from "./ControlPlaneClient.js";
export * from "./stdioServer.js";
export * from "./tools.js";

export const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:8087";

export interface McpCommandOptions {
  url?: string;
  token?: string;
  profile?: string;
  startupSeconds?: number;
  log?: (line: string) => void;
}

export async function runMcpCommand(options: McpCommandOptions = {}): Promise<void> {
  const baseUrl = options.url ?? process.env.T3X_API_URL ?? DEFAULT_CONTROL_PLANE_URL;
  const token = options.token ?? process.env.T3X_API_TOKEN ?? null;
  const client = new ControlPlaneClient({ baseUrl, token });
  await runMcpStdioServer({
    client,
    defaultProfileId: options.profile ?? process.env.T3X_PROFILE ?? "default",
    ...(options.startupSeconds !== undefined ? { startupSeconds: options.startupSeconds } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}
