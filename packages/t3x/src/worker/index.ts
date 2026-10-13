/**
 * Execution worker entry point.
 *
 * Runs inside a task sandbox (OpenSandbox container or local sandbox directory),
 * dials out to the control plane and executes provider, workspace, git and
 * checkpoint commands for exactly one task.
 *
 * Usage:
 *   node dist/src/worker/index.js \
 *     --worker-url http://127.0.0.1:8087/worker \
 *     --token <tokenId.secret> \
 *     --task-id task_... --sandbox-id sbox_... \
 *     --workspace-root /workspace/project --state-dir /workspace/../state
 */

import { parseArgs } from "node:util";
import { WorkerTransport } from "./WorkerTransport.js";

function main(): void {
  const { values } = parseArgs({
    options: {
      "worker-url": { type: "string" },
      token: { type: "string" },
      "task-id": { type: "string" },
      "sandbox-id": { type: "string" },
      "workspace-root": { type: "string" },
      "allowed-roots": { type: "string" },
      "state-dir": { type: "string" },
      "config-home": { type: "string" },
    },
    strict: true,
  });

  const required = ["worker-url", "token", "task-id", "sandbox-id", "workspace-root"] as const;
  for (const key of required) {
    if (!values[key]) {
      console.error(`worker: missing required argument --${key}`);
      process.exit(2);
    }
  }

  const transport = new WorkerTransport({
    workerUrl: values["worker-url"]!,
    token: values.token!,
    taskId: values["task-id"]!,
    sandboxId: values["sandbox-id"]!,
    workspaceRoot: values["workspace-root"]!,
    ...(values["allowed-roots"]
      ? { allowedRoots: values["allowed-roots"]!.split(",").filter(Boolean) }
      : {}),
    stateDir: values["state-dir"] ?? `${values["workspace-root"]!}/.t3x-worker`,
    ...(values["config-home"] ? { configHome: values["config-home"] } : {}),
    onFenced: () => {
      console.error("worker: lease fenced by a replacement worker; exiting");
      process.exit(0);
    },
  });

  const shutdown = () => {
    transport.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(`worker: starting for task ${values["task-id"]} sandbox ${values["sandbox-id"]}`);
  void transport.run();
}

main();
