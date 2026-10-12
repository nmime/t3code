/**
 * Path spaces.
 *
 * The control plane thinks in *sandbox-absolute* paths (`/workspace/project`,
 * `/workspace/worktrees/<taskId>`), because that is what the profile declares
 * and what the Daytona backend uses. The worker, however, runs in whatever
 * path space its backend lives in: inside a Daytona sandbox that is the same
 * `/workspace/...`; under the local backend the sandbox is a directory tree on
 * this machine, so the same path must be translated to
 * `<stateDir>/sandboxes/<sandboxId>/workspace/...`.
 *
 * One mapper, used everywhere a path crosses into the worker, so a shared
 * sandbox cannot end up with commands pointing at another sandbox's tree.
 */

import * as path from "node:path";
import { LocalBackend } from "./daytona/LocalBackend.js";
import type { SandboxBackend } from "./daytona/SandboxBackend.js";

export type WorkerPathMapper = (sandboxId: string | null, sandboxPath: string) => string;

export function workerPathMapper(backend: SandboxBackend): WorkerPathMapper {
  if (backend instanceof LocalBackend) {
    const root = backend.root;
    return (sandboxId, sandboxPath) =>
      sandboxId ? path.join(root, sandboxId, sandboxPath.replace(/^\//, "")) : sandboxPath;
  }
  return (_sandboxId, sandboxPath) => sandboxPath;
}
