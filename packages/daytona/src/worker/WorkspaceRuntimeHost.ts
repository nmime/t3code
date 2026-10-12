/**
 * Workspace runtime host.
 *
 * Runs inside a sandbox and owns the repository checkouts, git operations and
 * hidden-git-ref checkpoints. Everything here is sandbox-local: the VPS-side
 * RemoteWorkspaceService only forwards commands.
 *
 * A shared project sandbox holds one base checkout plus one git worktree per
 * task, so every command names the root it applies to (`root`). Roots are
 * validated against the sandbox's allowed roots, which is what keeps a command
 * for one task from reaching another sandbox's tree.
 *
 * Checkpoints follow T3's model — hidden git refs
 * (`refs/t3x/checkpoints/*`) captured through a temporary index so capturing
 * never disturbs the working tree or the index the agent is using.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { PathOutsideWorkspaceError, ExecutionError } from "../contracts/errors.js";
import type { GitStatus, WorkspaceEntry } from "../contracts/execution.js";
import type {
  CheckpointCapturePayload,
  CheckpointDiffPayload,
  CheckpointRestorePayload,
  WorkspaceExecPayload,
  WorkspaceGitPayload,
  WorkspaceListPayload,
  WorkspaceReadPayload,
  WorkspaceWorktreePayload,
  WorkspaceWritePayload,
} from "../contracts/workerProtocol.js";

const CHECKPOINT_REF_PREFIX = "refs/t3x/checkpoints";
const MAX_OUTPUT = 256 * 1024;

export class WorkspaceRuntimeHost {
  /** Root the worker starts in (the sandbox's base checkout). */
  private readonly workspaceRoot: string;
  /** Roots commands may name: the sandbox workspace tree, worktrees included. */
  private readonly allowedRoots: string[];

  constructor(workspaceRoot: string, allowedRoots?: string[]) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.allowedRoots = (
      allowedRoots && allowedRoots.length > 0
        ? allowedRoots
        : [path.dirname(this.workspaceRoot), this.workspaceRoot]
    ).map((r) => path.resolve(r));
  }

  /** True when `target` is inside one of the sandbox's allowed roots. */
  private isAllowed(target: string): boolean {
    const resolved = path.resolve(target);
    return this.allowedRoots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  }

  /** Absolute path of a command's root, validated against the allowed roots. */
  private rootOf(root?: string): string {
    if (!root) return this.workspaceRoot;
    const resolved = path.resolve(root);
    if (!this.isAllowed(resolved)) throw new PathOutsideWorkspaceError(root);
    return resolved;
  }

  /** Workspace-relative resolution inside a root, with an escape guard. */
  private resolve(target: string, root?: string): string {
    const base = this.rootOf(root);
    const resolved = path.resolve(base, target);
    const rel = path.relative(base, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathOutsideWorkspaceError(target);
    }
    return resolved;
  }

  async read(payload: WorkspaceReadPayload): Promise<{ dataBase64: string; size: number }> {
    const data = await fs.readFile(this.resolve(payload.path, payload.root));
    return { dataBase64: data.toString("base64"), size: data.length };
  }

  async write(payload: WorkspaceWritePayload): Promise<{ path: string; size: number }> {
    const target = this.resolve(payload.path, payload.root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const data = Buffer.from(payload.dataBase64, "base64");
    await fs.writeFile(
      target,
      data,
      payload.mode !== undefined ? { mode: payload.mode } : undefined,
    );
    return { path: payload.path, size: data.length };
  }

  async list(payload: WorkspaceListPayload): Promise<{ entries: WorkspaceEntry[] }> {
    const dir = this.resolve(payload.path === "" ? "." : payload.path, payload.root);
    const names = await fs.readdir(dir);
    const entries: WorkspaceEntry[] = [];
    for (const name of names) {
      const st = await fs.lstat(path.join(dir, name));
      entries.push({
        name,
        path: path.posix.join(payload.path, name),
        kind: st.isFile()
          ? "file"
          : st.isDirectory()
            ? "directory"
            : st.isSymbolicLink()
              ? "symlink"
              : "other",
        size: st.size,
        modifiedAt: st.mtimeMs,
      });
    }
    return { entries };
  }

  async exec(payload: WorkspaceExecPayload): Promise<{ exitCode: number; output: string }> {
    const cwd = payload.cwd ? this.resolve(payload.cwd, payload.root) : this.rootOf(payload.root);
    const result = await run("bash", ["-lc", payload.command], {
      cwd,
      env: { ...(process.env as Record<string, string>), ...(payload.env ?? {}) },
      timeoutMs: payload.timeoutMs ?? 120_000,
    });
    return {
      exitCode: result.code,
      output: truncate(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`),
    };
  }

  async git(
    payload: WorkspaceGitPayload,
  ): Promise<GitStatus | { output: string } | { branch: string; branches: string[] }> {
    const cwd = this.rootOf(payload.root);
    switch (payload.operation) {
      case "status":
        return await this.gitStatus(cwd);
      case "diff": {
        const result = await run("git", ["diff", "--no-color", ...(payload.args ?? [])], {
          cwd,
          timeoutMs: 60_000,
        });
        return { output: truncate(result.stdout) };
      }
      case "log": {
        const result = await run(
          "git",
          ["log", "--oneline", "-n", "20", ...(payload.args ?? [])],
          { cwd, timeoutMs: 60_000 },
        );
        return { output: truncate(result.stdout) };
      }
      case "branch": {
        const result = await run("git", ["branch", "--list", ...(payload.args ?? [])], {
          cwd,
          timeoutMs: 60_000,
        });
        const branches = result.stdout
          .split("\n")
          .map((line) => line.replace(/^\*?\s+/, "").trim())
          .filter(Boolean);
        const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd,
          timeoutMs: 60_000,
        });
        return { branch: head.stdout.trim(), branches };
      }
      case "commit": {
        const result = await run("git", ["commit", ...(payload.args ?? [])], {
          cwd,
          timeoutMs: 60_000,
        });
        return { output: truncate(`${result.stdout}${result.stderr}`) };
      }
      case "show-ref": {
        const result = await run("git", ["for-each-ref", CHECKPOINT_REF_PREFIX], {
          cwd,
          timeoutMs: 60_000,
        });
        return { output: truncate(result.stdout) };
      }
      default:
        throw new ExecutionError("internal", `unknown git operation ${String(payload.operation)}`);
    }
  }

  // -- worktrees -----------------------------------------------------------

  /**
   * Worktree management for a shared sandbox: the base checkout stays on its
   * own branch while every task gets an independent branch and directory.
   */
  async worktree(
    payload: WorkspaceWorktreePayload,
  ): Promise<
    | { path: string; branch: string; created: true }
    | { removed: boolean; path: string }
    | { worktrees: Array<{ path: string; branch: string }> }
  > {
    const projectRoot = this.rootOf(payload.projectRoot);

    switch (payload.operation) {
      case "create": {
        if (!payload.path) {
          throw new ExecutionError("internal", "worktree create requires a path");
        }
        const target = this.resolveAllowed(payload.path);
        const args = ["worktree", "add"];
        if (payload.force) args.push("--force");
        if (payload.branch) args.push("-b", payload.branch);
        args.push(target);
        if (payload.baseRef) args.push(payload.baseRef);
        const result = await run("git", args, { cwd: projectRoot, timeoutMs: 180_000 });
        if (result.code !== 0) {
          throw new ExecutionError(
            "internal",
            `git worktree add failed: ${truncate(result.stderr)}`,
            { path: target },
          );
        }
        const branch =
          payload.branch ??
          (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: target,
            timeoutMs: 60_000,
          })).stdout.trim();
        return { path: target, branch, created: true };
      }
      case "remove": {
        if (!payload.path) {
          throw new ExecutionError("internal", "worktree remove requires a path");
        }
        const target = this.resolveAllowed(payload.path);
        const result = await run("git", ["worktree", "remove", "--force", target], {
          cwd: projectRoot,
          timeoutMs: 120_000,
        });
        await run("git", ["worktree", "prune"], { cwd: projectRoot, timeoutMs: 60_000 });
        return { removed: result.code === 0, path: target };
      }
      case "list": {
        const result = await run("git", ["worktree", "list", "--porcelain"], {
          cwd: projectRoot,
          timeoutMs: 60_000,
        });
        const worktrees: Array<{ path: string; branch: string }> = [];
        let current: { path: string; branch: string } | null = null;
        for (const line of result.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (current) worktrees.push(current);
            current = { path: line.slice("worktree ".length).trim(), branch: "" };
          } else if (line.startsWith("branch ") && current) {
            current.branch = line
              .slice("branch ".length)
              .trim()
              .replace(/^refs\/heads\//, "");
          }
        }
        if (current) worktrees.push(current);
        return { worktrees };
      }
      default:
        throw new ExecutionError(
          "internal",
          `unknown worktree operation ${String(payload.operation)}`,
        );
    }
  }

  /** Absolute path inside the sandbox workspace tree (worktrees included). */
  private resolveAllowed(target: string): string {
    const resolved = path.resolve(target);
    if (!this.isAllowed(resolved)) throw new PathOutsideWorkspaceError(target);
    return resolved;
  }

  private async gitStatus(cwd: string): Promise<GitStatus> {
    const porcelain = await run(
      "git",
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
      { cwd, timeoutMs: 60_000 },
    );
    if (porcelain.code !== 0) {
      throw new ExecutionError("internal", `git status failed: ${porcelain.stderr}`, { cwd });
    }

    let branch = "HEAD";
    let ahead = 0;
    let behind = 0;
    const entries: GitStatus["entries"] = [];

    for (const line of porcelain.stdout.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        branch = line.slice("# branch.head ".length).trim();
      } else if (line.startsWith("# branch.ab ")) {
        const match = line.match(/# branch\.ab \+(\d+) -(\d+)/);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (line.startsWith("2 ")) {
        const parts = line.split(" ");
        const xy = parts[1] ?? "..";
        const pathPart = parts.slice(9).join(" ");
        const [renamed, original] = pathPart.split("\t");
        entries.push({
          path: renamed ?? pathPart,
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
          ...(original ? { renamedFrom: original } : {}),
        });
      } else if (line.startsWith("1 ")) {
        const parts = line.split(" ");
        const xy = parts[1] ?? "..";
        entries.push({
          path: parts.slice(8).join(" "),
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
        });
      } else if (line.startsWith("? ")) {
        entries.push({ path: line.slice(2), index: "?", worktree: "?", untracked: true });
      }
    }

    const refs = await run(
      "git",
      ["for-each-ref", "--format=%(refname:short)", CHECKPOINT_REF_PREFIX],
      { cwd, timeoutMs: 60_000 },
    );

    return {
      branch,
      ahead,
      behind,
      clean: entries.length === 0,
      entries,
      checkpoints: refs.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        // `%(refname:short)` drops the leading `refs/`, so strip either form.
        .map((ref) =>
          ref
            .replace(/^refs\/t3x\/checkpoints\//, "")
            .replace(/^t3x\/checkpoints\//, ""),
        ),
    };
  }

  // -- checkpoints ---------------------------------------------------------

  /**
   * Capture the current worktree into a hidden ref without touching the live
   * index: the tree is built through a temporary index file.
   */
  async captureCheckpoint(
    payload: CheckpointCapturePayload & { root?: string },
  ): Promise<{ checkpointId: string; digest: string }> {
    const cwd = this.rootOf(payload.root);
    const tmpIndex = path.join(cwd, ".git", "t3x-index");
    const cleanup = async () => {
      if (existsSync(tmpIndex)) await fs.rm(tmpIndex, { force: true });
    };

    try {
      // Seed the temp index with HEAD so deletions are captured correctly.
      await run("git", ["read-tree", "HEAD"], {
        cwd,
        timeoutMs: 60_000,
        env: { GIT_INDEX_FILE: tmpIndex },
      });
      await run("git", ["add", "-A", "--force"], {
        cwd,
        timeoutMs: 120_000,
        env: { GIT_INDEX_FILE: tmpIndex },
      });
      const tree = await run("git", ["write-tree"], {
        cwd,
        timeoutMs: 60_000,
        env: { GIT_INDEX_FILE: tmpIndex },
      });
      if (tree.code !== 0) {
        throw new ExecutionError("internal", `checkpoint capture failed: ${tree.stderr}`);
      }
      const treeHash = tree.stdout.trim();

      const head = await run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 60_000 });
      const parents = head.code === 0 ? ["-p", head.stdout.trim()] : [];
      const commit = await run(
        "git",
        ["commit-tree", treeHash, ...parents, "-m", `t3x checkpoint ${payload.checkpointId}`],
        { cwd, timeoutMs: 60_000 },
      );
      if (commit.code !== 0) {
        throw new ExecutionError("internal", `checkpoint commit failed: ${commit.stderr}`);
      }
      const digest = commit.stdout.trim();
      await run("git", ["update-ref", `${CHECKPOINT_REF_PREFIX}/${payload.checkpointId}`, digest], {
        cwd,
        timeoutMs: 60_000,
      });
      return { checkpointId: payload.checkpointId, digest };
    } finally {
      await cleanup();
    }
  }

  async restoreCheckpoint(
    payload: CheckpointRestorePayload & { root?: string },
  ): Promise<{ checkpointId: string; restored: true }> {
    const cwd = this.rootOf(payload.root);
    const ref = `${CHECKPOINT_REF_PREFIX}/${payload.checkpointId}`;
    const exists = await run("git", ["rev-parse", "--verify", ref], { cwd, timeoutMs: 60_000 });
    if (exists.code !== 0) {
      throw new ExecutionError("task_not_found", `checkpoint ${payload.checkpointId} not found`, {
        checkpointId: payload.checkpointId,
      });
    }
    const restore = await run(
      "git",
      ["restore", `--source=${ref}`, "--staged", "--worktree", "."],
      { cwd, timeoutMs: 120_000 },
    );
    if (restore.code !== 0) {
      throw new ExecutionError("internal", `checkpoint restore failed: ${restore.stderr}`);
    }
    if (payload.cleanUntracked) {
      await run("git", ["clean", "-fd"], { cwd, timeoutMs: 120_000 });
    }
    return { checkpointId: payload.checkpointId, restored: true };
  }

  async diffCheckpoints(
    payload: CheckpointDiffPayload & { root?: string },
  ): Promise<{ output: string }> {
    const cwd = this.rootOf(payload.root);
    const from = payload.fromCheckpointId
      ? `${CHECKPOINT_REF_PREFIX}/${payload.fromCheckpointId}`
      : "HEAD";
    const to = payload.toCheckpointId
      ? `${CHECKPOINT_REF_PREFIX}/${payload.toCheckpointId}`
      : "WORKTREE";
    const result =
      to === "WORKTREE"
        ? await run("git", ["diff", "--no-color", from], { cwd, timeoutMs: 60_000 })
        : await run("git", ["diff", "--no-color", from, to], { cwd, timeoutMs: 60_000 });
    return { output: truncate(result.stdout) };
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...(process.env as Record<string, string>), ...(options.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err) });
    });
  });
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n...[truncated]` : text;
}
