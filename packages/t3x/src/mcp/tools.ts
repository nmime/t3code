/**
 * The tools the MCP bridge exposes, and what each one calls.
 *
 * These are the control plane's own operations, not a new API: the bridge adds
 * a protocol (MCP) and a name, so an agent that speaks MCP — OpenClaw on the
 * VPS, Codex, Claude Desktop — can start a task in a sandbox, talk to it, run a
 * command inside it, read its diff and stop it, without a shell on the box and
 * without ever reaching a sandbox directly.
 */

import {
  ControlPlaneRequestError,
  type ControlPlaneClient,
  type CreateTaskInput,
  type StoredEvent,
  type TaskSummary,
} from "./ControlPlaneClient.js";

export interface ToolOutcome {
  /** Text the calling model reads. Always present. */
  text: string;
  /** Same answer, structured, for clients that prefer it. */
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOutcome>;
}

export interface ToolContext {
  client: ControlPlaneClient;
  /** Profile `t3_task_create` / `t3_run` use when the caller names none. */
  defaultProfileId: string;
  /** How long a task may take to come up before `t3_run` gives up. */
  startupSeconds: number;
  log: (message: string) => void;
}

/** States in which the worker is up and a message is accepted. */
const MESSAGEABLE_STATES = new Set(["ready", "running", "waiting", "completed"]);

export function controlPlaneTools(context: ToolContext): McpToolDefinition[] {
  const { client } = context;

  const taskArg = (args: Record<string, unknown>, key = "taskId"): string => {
    const value = asString(args[key]);
    if (!value) throw new ToolInputError(`\`${key}\` is required.`);
    return value;
  };

  return [
    {
      name: "t3_status",
      title: "T3 control plane status",
      description:
        "Check the T3 control plane this bridge talks to. Returns its URL, whether it answers, how many tasks it owns and which profiles exist. Call this first when a T3 call fails.",
      inputSchema: objectSchema({}),
      handler: async () => {
        const health = await client.health();
        const profiles = await client.listProfiles();
        const names = profiles.profiles.map((profile) =>
          String(profile.profileId ?? profile.id ?? "?"),
        );
        return ok(
          `T3 control plane at ${client.baseUrl} answered ok=true with ${health.tasks} task(s). ` +
            `Profiles: ${names.length > 0 ? names.join(", ") : "none"}.`,
          { baseUrl: client.baseUrl, tasks: health.tasks, profiles: names },
        );
      },
    },
    {
      name: "t3_profiles_list",
      title: "List environment profiles",
      description:
        "List the environment profiles a task can be created with: which agents each profile allows and which is its default. A profile decides the image, the resources and the setup steps of a task's sandbox.",
      inputSchema: objectSchema({}),
      handler: async () => {
        const profiles = await client.listProfiles();
        return ok(JSON.stringify(profiles.profiles, null, 1), { profiles: profiles.profiles });
      },
    },
    {
      name: "t3_task_create",
      title: "Create a T3 task",
      description:
        "Create a task: the control plane provisions a sandbox for it, starts an agent (codex by default) in /workspace/project and returns the task id. The task does nothing until you send it a message — use `t3_run` to create and ask in one step, or `t3_task_message` afterwards. `repositoryUrl` clones a repository into the sandbox; omit it for a scratch task.",
      inputSchema: objectSchema({
        prompt: {
          type: "string",
          description: "Optional first message to send as soon as the task's sandbox is up.",
        },
        profileId: {
          type: "string",
          description: `Environment profile (default: ${context.defaultProfileId}).`,
        },
        provider: {
          type: "string",
          description: "Agent to run: codex, openclaw, claude, opencode, echo.",
        },
        model: { type: "string", description: "Model override for the agent." },
        repositoryUrl: { type: "string", description: "Git repository to clone into the sandbox." },
        branch: { type: "string", description: "Branch to check out." },
        scope: {
          type: "string",
          enum: ["project", "task"],
          description: "Share one sandbox per project, or dedicate one to this task.",
        },
        projectId: { type: "string", description: "Attach the task to an existing project." },
        threadId: {
          type: "string",
          description: "Caller's own thread id, so the task can be found again by thread.",
        },
      }),
      handler: async (args) => {
        const created = await client.createTask(createTaskInput(context, args));
        const task = created.task;
        let reply: string | null = null;
        const prompt = asString(args.prompt);
        if (prompt) {
          reply = await askTask(context, task.taskId, prompt, context.startupSeconds);
          context.log(`t3_task_create: sent the first message to ${task.taskId}`);
        }
        return ok(
          `${describeTask(task)}${reply !== null ? `\n\nReply:\n${reply}` : "\n\nNo message sent yet; the task is idle."}`,
          { task: taskSummary(task), ...(reply !== null ? { reply } : {}) },
        );
      },
    },
    {
      name: "t3_run",
      title: "Run a prompt in a new T3 task",
      description:
        "Create a task, send it a prompt and wait for the agent's answer. This is the one call to reach for: it returns the task id, the final state and the agent's reply text. Give `repositoryUrl` to work on a repository, or leave it out for a scratch task. `waitSeconds` bounds the wait (default 900); when it runs out the task keeps working and `t3_task_wait` collects the answer later.",
      inputSchema: objectSchema(
        {
          prompt: { type: "string", description: "What the agent in the sandbox should do." },
          waitSeconds: {
            type: "number",
            description: "How long to wait for the answer (default 900).",
          },
        },
        ["prompt"],
      ),
      handler: async (args) => {
        const prompt = taskArg(args, "prompt");
        const created = await client.createTask(createTaskInput(context, args));
        const task = created.task;
        const waitMs = seconds(asNumber(args.waitSeconds) ?? 900);
        const reply = await askTask(context, task.taskId, prompt, waitMs);
        const final = await client.getTask(task.taskId).catch(() => task);
        return ok(
          `${describeTask(final)}\n\nReply:\n${reply.length > 0 ? reply : "(the agent produced no assistant text)"}`,
          { task: taskSummary(final), reply },
        );
      },
    },
    {
      name: "t3_task_list",
      title: "List T3 tasks",
      description:
        "List the tasks the control plane owns, newest last, with state, agent, sandbox and worktree. `limit` keeps the most recent ones (default 20).",
      inputSchema: objectSchema({
        limit: {
          type: "number",
          description: "How many of the most recent tasks to return (default 20).",
        },
      }),
      handler: async (args) => {
        const limit = Math.max(1, Math.floor(asNumber(args.limit) ?? 20));
        const tasks = (await client.listTasks()).tasks.slice(-limit);
        return ok(
          tasks.length === 0 ? "No tasks." : tasks.map((task) => describeTask(task)).join("\n"),
          { tasks: tasks.map(taskSummary) },
        );
      },
    },
    {
      name: "t3_task_get",
      title: "Get one T3 task",
      description:
        "Read one task's current record: state, agent, sandbox id, workspace and worktree path, branch, last event sequence.",
      inputSchema: objectSchema({ taskId: { type: "string" } }, ["taskId"]),
      handler: async (args) => {
        const task = await client.getTask(taskArg(args));
        const detail = task.detail ?? {};
        return ok(describeTask(task), {
          task: taskSummary(task),
          sandbox: detail.sandbox ?? null,
          worker: detail.worker ?? null,
          approvals: detail.approvals ?? [],
          checkpoints: detail.checkpoints ?? [],
          pendingEffects: detail.pendingEffects ?? [],
        });
      },
    },
    {
      name: "t3_task_message",
      title: "Send a message to a T3 task",
      description:
        "Send a follow-up message to a task that already exists and wait for its answer. The task keeps its sandbox, its files and the agent's session, so this is how a conversation continues.",
      inputSchema: objectSchema(
        {
          taskId: { type: "string" },
          text: { type: "string", description: "The message." },
          waitSeconds: {
            type: "number",
            description: "How long to wait for the answer (default 900).",
          },
        },
        ["taskId", "text"],
      ),
      handler: async (args) => {
        const taskId = taskArg(args);
        const text = taskArg(args, "text");
        const reply = await askTask(
          context,
          taskId,
          text,
          seconds(asNumber(args.waitSeconds) ?? 900),
        );
        const task = await client.getTask(taskId);
        return ok(`${describeTask(task)}\n\nReply:\n${reply}`, { task: taskSummary(task), reply });
      },
    },
    {
      name: "t3_task_wait",
      title: "Wait for a T3 task to settle",
      description:
        "Wait until a task stops working — it is idle, completed, failed, suspended or waiting for an approval — and return its state plus the agent's latest reply text. Use it after `t3_run` ran out of time.",
      inputSchema: objectSchema(
        {
          taskId: { type: "string" },
          timeoutSeconds: { type: "number", description: "Give up after this long (default 900)." },
        },
        ["taskId"],
      ),
      handler: async (args) => {
        const taskId = taskArg(args);
        const timeoutMs = seconds(asNumber(args.timeoutSeconds) ?? 900);
        const everything = await client.events(taskId, 0, 2000);
        const turn = lastTurn(everything.events);
        const task = turn
          ? await waitForTurn(context, taskId, turn.from, turn.runId, timeoutMs)
          : await client.getTask(taskId);
        const reply = await replyFor(client, taskId, turn?.from ?? 0);
        return ok(
          `${describeTask(task)}\n\nLatest reply:\n${reply.length > 0 ? reply : "(none yet)"}`,
          { task: taskSummary(task), reply },
        );
      },
    },
    {
      name: "t3_task_events",
      title: "Read a T3 task's events",
      description:
        "Read a task's event stream from sequence `from` (default 0). Assistant message chunks are merged into one reply entry; everything else is returned by type with a shortened payload. Use it to see what an agent did step by step.",
      inputSchema: objectSchema(
        {
          taskId: { type: "string" },
          from: { type: "number", description: "First sequence to return (default 0)." },
          limit: { type: "number", description: "Maximum entries to return (default 50)." },
        },
        ["taskId"],
      ),
      handler: async (args) => {
        const taskId = taskArg(args);
        const from = Math.max(0, Math.floor(asNumber(args.from) ?? 0));
        const limit = Math.max(1, Math.floor(asNumber(args.limit) ?? 50));
        const result = await client.events(taskId, from);
        const entries = summariseEvents(result.events).slice(-limit);
        const reply = extractReply(result.events);
        return ok(
          entries.length === 0
            ? `No events after sequence ${from}.`
            : entries.map((entry) => `${entry.seq} ${entry.type} ${entry.detail}`).join("\n"),
          { lastSeq: result.lastSeq, events: entries, reply },
        );
      },
    },
    {
      name: "t3_task_exec",
      title: "Run a shell command in a T3 task's sandbox",
      description:
        "Run a command inside the task's sandbox, in its working directory, and return stdout, stderr and the exit code. This is the direct way to inspect what an agent produced (cat a file, run the tests, `git status`).",
      inputSchema: objectSchema(
        { taskId: { type: "string" }, command: { type: "string", description: "Shell command." } },
        ["taskId", "command"],
      ),
      handler: async (args) => {
        const result = await client.exec(taskArg(args), taskArg(args, "command"));
        return ok(JSON.stringify(result, null, 1), { result });
      },
    },
    {
      name: "t3_task_files",
      title: "List files in a T3 task's sandbox",
      description: "List a directory inside the task's sandbox (default the working directory).",
      inputSchema: objectSchema(
        {
          taskId: { type: "string" },
          path: { type: "string", description: "Directory, default `.`." },
        },
        ["taskId"],
      ),
      handler: async (args) => {
        const path = asString(args.path) ?? ".";
        const files = await client.listFiles(taskArg(args), path);
        return ok(JSON.stringify(files.entries, null, 1), { entries: files.entries });
      },
    },
    {
      name: "t3_task_git",
      title: "Read a T3 task's git status or diff",
      description:
        "Read the task's git status or its diff — the change an agent made in the sandbox. `kind` is `status` (default) or `diff`; `ref` compares against a revision and `staged` reads the index.",
      inputSchema: objectSchema(
        {
          taskId: { type: "string" },
          kind: { type: "string", enum: ["status", "diff"], description: "Default `status`." },
          ref: { type: "string", description: "For `diff`: the revision to compare against." },
          staged: { type: "boolean", description: "For `diff`: read the staged change." },
        },
        ["taskId"],
      ),
      handler: async (args) => {
        const taskId = taskArg(args);
        const kind = asString(args.kind) ?? "status";
        if (kind === "diff") {
          const diff = await client.gitDiff(taskId, {
            ...(asBoolean(args.staged) ? { staged: true } : {}),
            ...(asString(args.ref) ? { ref: asString(args.ref)! } : {}),
          });
          return ok(diff.diff.length > 0 ? diff.diff : "(no diff)", { diff: diff.diff });
        }
        const status = await client.gitStatus(taskId);
        return ok(JSON.stringify(status, null, 1), { status });
      },
    },
    {
      name: "t3_task_stop",
      title: "Stop a T3 task",
      description:
        "Stop a task's sandbox and release it. The task keeps its files and can be resumed; nothing is deleted.",
      inputSchema: objectSchema({ taskId: { type: "string" } }, ["taskId"]),
      handler: async (args) => {
        const taskId = taskArg(args);
        const result = await client.stop(taskId);
        return ok(`Stopped ${taskId}.`, { result });
      },
    },
    {
      name: "t3_task_resume",
      title: "Resume a T3 task",
      description: "Resume a stopped task: reconnect its sandbox and continue the agent's session.",
      inputSchema: objectSchema({ taskId: { type: "string" } }, ["taskId"]),
      handler: async (args) => {
        const taskId = taskArg(args);
        const result = await client.resume(taskId);
        return ok(`Resumed ${taskId}.`, { result });
      },
    },
    {
      name: "t3_task_destroy",
      title: "Destroy a T3 task",
      description:
        "Destroy a task and its sandbox for good. Files inside the sandbox are lost. Ask the user before calling this on a task they did not ask you to discard.",
      inputSchema: objectSchema({ taskId: { type: "string" } }, ["taskId"]),
      handler: async (args) => {
        const taskId = taskArg(args);
        const result = await client.destroy(taskId);
        return ok(`Destroyed ${taskId}.`, { result });
      },
    },
    {
      name: "t3_sandbox_list",
      title: "List sandboxes",
      description:
        "List the sandboxes the control plane owns: state, profile, scope, the tasks bound to each.",
      inputSchema: objectSchema({}),
      handler: async () => {
        const sandboxes = await client.listSandboxes();
        return ok(JSON.stringify(sandboxes.sandboxes, null, 1), { sandboxes: sandboxes.sandboxes });
      },
    },
    {
      name: "t3_sandbox_stop",
      title: "Stop a sandbox",
      description:
        "Stop one sandbox by id. Refused while tasks are still bound to it; stop or destroy those tasks first.",
      inputSchema: objectSchema({ sandboxId: { type: "string" } }, ["sandboxId"]),
      handler: async (args) => {
        const sandboxId = taskArg(args, "sandboxId");
        const result = await client.stopSandbox(sandboxId);
        return ok(`Stopped sandbox ${sandboxId}.`, { result });
      },
    },
    {
      name: "t3_sandbox_destroy",
      title: "Destroy a sandbox",
      description: "Destroy one sandbox by id, with everything inside it.",
      inputSchema: objectSchema({ sandboxId: { type: "string" } }, ["sandboxId"]),
      handler: async (args) => {
        const sandboxId = taskArg(args, "sandboxId");
        const result = await client.destroySandbox(sandboxId);
        return ok(`Destroyed sandbox ${sandboxId}.`, { result });
      },
    },
  ];
}

/** A tool call with arguments the schema does not allow. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Create a task, send one message and wait for the turn.
 *
 * The first message is the one that can race provisioning: the task exists but
 * its worker is not up yet, and the control plane refuses a message then. So a
 * refusal is waited out rather than reported — the caller asked for a task that
 * answers, not for the exact millisecond it became ready.
 */
async function askTask(
  context: ToolContext,
  taskId: string,
  text: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let from = 0;
  let runId = "";
  for (;;) {
    const task = await context.client.getTask(taskId);
    from = task.lastEventSequence;
    if (MESSAGEABLE_STATES.has(task.state) || Date.now() >= deadline) {
      try {
        const accepted = await context.client.sendMessage(taskId, { text });
        runId = String(accepted.runId ?? "");
        break;
      } catch (error) {
        if (!isRetryableMessageRefusal(error) || Date.now() >= deadline) {
          if (Date.now() >= deadline && isRetryableMessageRefusal(error)) {
            throw new Error(
              `Task ${taskId} is still ${task.state} after ${Math.round(timeoutMs / 1000)}s; its sandbox never became ready.`,
            );
          }
          throw error;
        }
        context.log(`t3: ${taskId} is ${task.state}, waiting to send`);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Task ${taskId} is still ${task.state} after ${Math.round(timeoutMs / 1000)}s; it never became ready.`,
      );
    }
    await sleep(1000);
  }
  await waitForTurn(context, taskId, from, runId, Math.max(1, deadline - Date.now()));
  return replyFor(context.client, taskId, from);
}

/**
 * Wait for one turn to end.
 *
 * Waiting on the task's *state* is not enough and was the first version of
 * this: a message is queued by the HTTP call and the turn starts when the
 * effect worker picks it up, so the task is still `ready` for a moment after
 * `POST /messages` returns and a state poll returns before the agent has said
 * anything. The turn's own terminal event — matched by the runId the message
 * answered with — is the only thing that means "this turn is over".
 *
 * A task that moves to `waiting` is not waiting for us: it is waiting for a
 * human to answer an approval, and no amount of polling changes that, so the
 * wait ends there and the caller is told.
 */
async function waitForTurn(
  context: ToolContext,
  taskId: string,
  from: number,
  runId: string,
  timeoutMs: number,
): Promise<TaskSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await context.client.getTask(taskId);
    if (task.state === "waiting" || task.state === "failed" || task.state === "suspended")
      return task;
    const events = await context.client.events(taskId, from, 2000);
    if (hasTerminalTurn(events.events, runId)) return task;
    if (Date.now() >= deadline) {
      context.log(`t3: ${taskId} was still ${task.state} when the wait ran out`);
      return task;
    }
    await sleep(500);
  }
}

/** The runId of the most recent accepted message, and where its events start. */
function lastTurn(events: StoredEvent[]): { runId: string; from: number } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "message.accepted") continue;
    const runId = typeof event.payload?.runId === "string" ? event.payload.runId : "";
    return { runId, from: Math.max(0, event.seq - 1) };
  }
  return null;
}

/** Whether the turn that `runId` names has ended. */
function hasTerminalTurn(events: StoredEvent[], runId: string): boolean {
  return events.some((event) => {
    if (event.type !== "turn.terminal") return false;
    const terminalRun = typeof event.payload?.runId === "string" ? event.payload.runId : "";
    return runId.length === 0 || terminalRun === runId;
  });
}

/** The assistant text of a turn, from the task's own events. */
async function replyFor(client: ControlPlaneClient, taskId: string, from: number): Promise<string> {
  const result = await client.events(taskId, from);
  return extractReply(result.events);
}

/**
 * Merge the assistant message chunks of a task's events into the reply text.
 *
 * A CLI agent streams one `message.updated` per output line, each carrying the
 * line and `streaming: true`; the turn closes the message with an empty,
 * non-streaming chunk. Joining the non-empty chunks in sequence order is the
 * reply, exactly as the thread renders it.
 */
export function extractReply(events: StoredEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== "message.updated") continue;
    const message = event.payload?.message;
    if (!isRecord(message)) continue;
    if (message.role !== "assistant") continue;
    const text = typeof message.text === "string" ? message.text : "";
    if (text.trim().length > 0) lines.push(text);
  }
  return lines.join("\n").trim();
}

/** One readable line per event, with assistant chunks merged. */
export function summariseEvents(events: StoredEvent[]): Array<{
  seq: number;
  type: string;
  detail: string;
}> {
  const out: Array<{ seq: number; type: string; detail: string }> = [];
  let replySeq = 0;
  const replyLines: string[] = [];
  const flush = (): void => {
    if (replyLines.length === 0) return;
    out.push({
      seq: replySeq,
      type: "assistant_reply",
      detail: replyLines.join(" / ").slice(0, 2000),
    });
    replyLines.length = 0;
  };
  for (const event of events) {
    const message = event.payload?.message;
    if (event.type === "message.updated" && isRecord(message) && message.role === "assistant") {
      // The chunk that closes a message carries no text; it is the end marker
      // of the reply, not an event of its own.
      const text = typeof message.text === "string" ? message.text : "";
      if (text.trim().length === 0) continue;
      if (replyLines.length === 0) replySeq = event.seq;
      replyLines.push(text);
      continue;
    }
    flush();
    out.push({ seq: event.seq, type: event.type, detail: shorten(event.payload) });
  }
  flush();
  return out;
}

function describeTask(task: TaskSummary): string {
  const detail = task.detail ?? {};
  const sandbox = isRecord(detail.sandbox) ? detail.sandbox : undefined;
  const approvals = Array.isArray(detail.approvals) ? detail.approvals : [];
  const pending = approvals.filter(
    (approval) => isRecord(approval) && approval.status === "pending",
  ).length;
  const parts = [
    `task ${task.taskId}`,
    `state ${task.state}`,
    `agent ${task.provider}${task.model ? ` (${task.model})` : ""}`,
    task.sandboxId
      ? `sandbox ${task.sandboxId}${sandbox ? ` (${String(sandbox.state)})` : ""}`
      : "no sandbox",
    detail.worker ? "worker attached" : "no worker attached",
    task.worktreePath ? `workdir ${task.worktreePath}` : "",
    task.repositoryUrl ? `repo ${task.repositoryUrl}@${task.branch}` : "scratch workspace",
    pending > 0 ? `${pending} approval(s) waiting` : "",
    `thread ${task.threadId}`,
    `events up to ${task.lastEventSequence}`,
  ].filter((part) => part.length > 0);
  return parts.join(", ");
}

function taskSummary(task: TaskSummary): Record<string, unknown> {
  return {
    taskId: task.taskId,
    threadId: task.threadId,
    state: task.state,
    provider: task.provider,
    model: task.model,
    sandboxId: task.sandboxId,
    sandboxScope: task.sandboxScope,
    worktreePath: task.worktreePath,
    worktreeBranch: task.worktreeBranch,
    workspaceRoot: task.workspaceRoot,
    repositoryUrl: task.repositoryUrl,
    branch: task.branch,
    profileId: task.profileId,
    lastEventSequence: task.lastEventSequence,
  };
}

function createTaskInput(context: ToolContext, args: Record<string, unknown>): CreateTaskInput {
  const scope = asString(args.scope);
  if (scope !== undefined && scope !== "project" && scope !== "task") {
    throw new ToolInputError("`scope` must be `project` or `task`.");
  }
  return {
    profileId: asString(args.profileId) ?? context.defaultProfileId,
    ...(asString(args.provider) ? { provider: asString(args.provider)! } : {}),
    ...(asString(args.model) ? { model: asString(args.model)! } : {}),
    ...(asString(args.repositoryUrl) ? { repositoryUrl: asString(args.repositoryUrl)! } : {}),
    ...(asString(args.branch) ? { branch: asString(args.branch)! } : {}),
    ...(scope ? { scope } : {}),
    ...(asString(args.projectId) ? { projectId: asString(args.projectId)! } : {}),
    ...(asString(args.threadId) ? { threadId: asString(args.threadId)! } : {}),
  };
}

function isRetryableMessageRefusal(error: unknown): boolean {
  return (
    error instanceof ControlPlaneRequestError &&
    (error.code === "task_state_invalid" || error.status === 409 || error.status === 503)
  );
}

function ok(text: string, structured?: Record<string, unknown>): ToolOutcome {
  return structured === undefined ? { text } : { text, structured };
}

/** An MCP tool input schema: a closed object with typed properties. */
function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shorten(payload: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(payload);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return "(unprintable)";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seconds as milliseconds, clamped so a caller cannot ask for an hour by typo. */
function seconds(value: number): number {
  return Math.min(Math.max(value, 1), 3600) * 1000;
}
