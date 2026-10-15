/**
 * Client HTTP API (report §8: Mac GUI, phone GUI and CLI connect to the same
 * VPS; no client needs to stay online).
 *
 * Thin JSON/SSE layer over TaskService: task lifecycle, messages, approvals,
 * event replay (`?from=<seq>` — multi-device continuity), remote git/workspace
 * inspection and profile management. Sandboxes are never reachable from a
 * client directly.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorPayload, ExecutionError } from "../contracts/errors.js";
import type { SandboxScope } from "../contracts/sandboxScope.js";
import type { TaskService } from "./TaskService.js";
import type { EnvironmentProfileService } from "./EnvironmentProfileService.js";
import type { SandboxControlPlane } from "./SandboxControlPlane.js";
import type { ProjectSandboxStore } from "./ProjectSandboxStore.js";
import type { WorkerConnectionRegistry } from "./WorkerConnectionRegistry.js";

export interface HttpApiDeps {
  tasks: TaskService;
  profiles: EnvironmentProfileService;
  controlPlane: SandboxControlPlane;
  projects?: ProjectSandboxStore;
  registry?: WorkerConnectionRegistry;
  /** If set, every request must carry `Authorization: Bearer <token>`. */
  apiToken?: string | null;
}

/**
 * HTTP status for a control-plane error code, so a client can branch on the
 * response instead of parsing the body: "already exists" is not the same as
 * "malformed", and neither is "you are not allowed to".
 */
export function statusForErrorCode(code: string): number {
  switch (code) {
    case "task_not_found":
    case "profile_not_found":
    case "sandbox_not_found":
    case "secret_not_found":
      return 404;
    case "idempotency_conflict":
    case "sandbox_stop_refused":
    case "lease_fenced":
    case "task_state_invalid":
      return 409;
    case "unauthorized":
      return 401;
    case "secret_policy_violation":
    case "path_outside_workspace":
    case "approval_required":
      return 403;
    case "capability_unsupported":
    case "sandbox_backend_unsupported":
      return 422;
    case "worker_unavailable":
    case "execution_target_unavailable":
      return 503;
    default:
      return 400;
  }
}

export class HttpApi {
  constructor(private readonly deps: HttpApiDeps) {}

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://control-plane");
      const body = await readJson(req);

      if (this.deps.apiToken) {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${this.deps.apiToken}`) {
          return send(res, 401, { error: { code: "unauthorized", message: "bad token" } });
        }
      }

      const method = req.method ?? "GET";
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, tasks: this.deps.tasks.listTasks().length });
      }

      if (path === "/profiles") {
        if (method === "GET") {
          return send(res, 200, { profiles: this.deps.profiles.listProfiles() });
        }
        if (method === "POST") {
          const created = this.deps.profiles.createProfile({
            profileId: String(body.profileId ?? body.name ?? "default"),
            body: body.body as never,
          });
          return send(res, 201, created);
        }
      }

      // Project execution policy: the sandbox scope default lives per project.
      if (path === "/projects") {
        if (method === "GET") return send(res, 200, { projects: this.deps.tasks.listProjects() });
        if (method === "POST") {
          const project = this.deps.tasks.upsertProject({
            ...(body.projectId ? { projectId: String(body.projectId) } : {}),
            ...(body.name ? { name: String(body.name) } : {}),
            repositoryUrl: String(body.repositoryUrl ?? ""),
            ...(body.defaultScope !== undefined
              ? { defaultScope: body.defaultScope as SandboxScope | null }
              : {}),
            ...(body.environmentProfileId !== undefined
              ? { environmentProfileId: body.environmentProfileId as string | null }
              : {}),
            ...(body.maxConcurrentTasks !== undefined
              ? { maxConcurrentTasks: Number(body.maxConcurrentTasks) }
              : {}),
          });
          return send(res, 201, { project });
        }
      }

      const projectMatch = path.match(/^\/projects\/([^/]+)\/sandboxes$/);
      if (projectMatch && method === "GET") {
        return send(res, 200, {
          sandboxes: this.deps.tasks.projectSandboxes(decodeURIComponent(projectMatch[1]!)),
        });
      }

      // Project sandboxes are visible to clients (never reachable directly).
      if (path === "/sandboxes" && method === "GET") {
        return send(res, 200, { sandboxes: this.deps.tasks.listSandboxes() });
      }

      const sandboxMatch = path.match(/^\/sandboxes\/([^/]+)\/(stop|destroy)$/);
      if (sandboxMatch && method === "POST") {
        const sandboxId = decodeURIComponent(sandboxMatch[1]!);
        const action = sandboxMatch[2]!;
        // Stopping is refused while any task is bound to the sandbox: a task
        // with an approval pending or a dev server running must not lose its
        // files mid-flight. Say so, instead of answering ok and doing nothing.
        const refusal = this.deps.controlPlane.stopRefusal(sandboxId);
        if (action === "stop" && refusal.refused) {
          if (refusal.reason === "tasks_bound") {
            this.deps.controlPlane.recordStopRefusal(sandboxId, "client");
          }
          return send(res, refusal.reason === "sandbox_not_found" ? 404 : 409, {
            error: {
              code:
                refusal.reason === "sandbox_not_found"
                  ? "sandbox_not_found"
                  : "sandbox_stop_refused",
              message:
                refusal.reason === "sandbox_not_found"
                  ? `Sandbox ${sandboxId} does not exist.`
                  : `Sandbox ${sandboxId} still has ${refusal.taskCount} task(s) bound; it is stopped when the last one leaves.`,
              details: { sandboxId, taskCount: refusal.taskCount, reason: refusal.reason },
            },
          });
        }
        if (action === "stop") this.deps.tasks.stopSandbox(sandboxId);
        else this.deps.tasks.destroySandbox(sandboxId);
        return send(res, 202, { ok: true, sandboxId, action });
      }

      if (path === "/tasks") {
        if (method === "GET") return send(res, 200, { tasks: this.deps.tasks.listTasks() });
        if (method === "POST") {
          const task = this.deps.tasks.createTask(body as never);
          return send(res, 201, { task });
        }
      }

      const taskMatch = path.match(/^\/tasks\/([^/]+)(.*)$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]!);
        const rest = taskMatch[2] ?? "";

        if (rest === "" && method === "GET") {
          return send(res, 200, this.deps.tasks.status(taskId));
        }

        if (rest === "/events" && method === "GET") {
          const from = Number(url.searchParams.get("from") ?? 0);
          const mode = url.searchParams.get("stream") ?? "json";
          const events = this.deps.tasks.events(taskId, from);
          if (mode === "sse") {
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            for (const event of events) {
              res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            const detach = attachLive(this.deps.tasks, taskId, res, from);
            req.on("close", () => detach());
            return;
          }
          return send(res, 200, {
            events,
            lastSeq: events.length ? events[events.length - 1]!.seq : from,
          });
        }

        if (rest === "/messages" && method === "POST") {
          const result = this.deps.tasks.sendMessage(taskId, {
            text: String(body.text ?? ""),
            ...(body.model ? { model: String(body.model) } : {}),
            ...(body.runtimeMode ? { runtimeMode: String(body.runtimeMode) as never } : {}),
            ...(body.interactionMode
              ? { interactionMode: String(body.interactionMode) as never }
              : {}),
          });
          return send(res, 202, result);
        }

        if (rest === "/fork" && method === "POST") {
          const threadId = String(body.threadId ?? "").trim();
          if (!threadId) {
            throw new ExecutionError(
              "protocol_violation",
              "POST /tasks/:id/fork needs the new thread's id in `threadId`",
              { taskId },
            );
          }
          return send(res, 201, {
            task: this.deps.tasks.forkTask({ sourceTaskId: taskId, threadId }),
          });
        }

        const approvalMatch = rest.match(/^\/approvals\/([^/]+)$/);
        if (approvalMatch && method === "POST") {
          this.deps.tasks.respondToApproval(
            taskId,
            decodeURIComponent(approvalMatch[1]!),
            String(body.decision ?? "approved") as "approved" | "rejected" | "cancelled",
            body.answer,
          );
          return send(res, 202, { ok: true });
        }

        if (rest === "/steer" && method === "POST") {
          return send(res, 202, this.deps.tasks.steer(taskId, String(body.text ?? "")));
        }
        if (rest === "/interrupt" && method === "POST") {
          return send(res, 202, this.deps.tasks.interrupt(taskId));
        }
        if (rest === "/snapshot" && method === "GET") {
          return send(res, 200, { snapshot: this.deps.tasks.snapshot(taskId) });
        }
        const rollbackMatch = rest.match(/^\/checkpoints\/([^/]+)\/restore$/);
        if (rollbackMatch && method === "POST") {
          return send(
            res,
            202,
            this.deps.tasks.rollback(taskId, decodeURIComponent(rollbackMatch[1]!)),
          );
        }

        if (rest === "/stop" && method === "POST") {
          this.deps.tasks.stop(taskId);
          return send(res, 202, { ok: true });
        }
        if (rest === "/resume" && method === "POST") {
          this.deps.tasks.resume(taskId);
          return send(res, 202, { ok: true });
        }
        if (rest === "/destroy" && method === "POST") {
          this.deps.tasks.destroy(taskId);
          return send(res, 202, { ok: true });
        }
        if (rest === "/checkpoints" && method === "POST") {
          this.deps.tasks.captureCheckpoint(
            taskId,
            String(body.checkpointId ?? `cp_${Date.now()}`),
            body.label ? String(body.label) : undefined,
          );
          return send(res, 202, { ok: true });
        }
        if (rest === "/git/status" && method === "GET") {
          return send(res, 200, await this.deps.tasks.gitStatus(taskId));
        }
        if (rest === "/git/diff" && method === "GET") {
          const ref = url.searchParams.get("ref");
          return send(res, 200, {
            diff: await this.deps.tasks.gitDiff(taskId, {
              staged: url.searchParams.get("staged") === "true",
              ...(ref ? { ref } : {}),
            }),
          });
        }
        if (rest === "/exec" && method === "POST") {
          return send(
            res,
            200,
            await this.deps.tasks.execute(taskId, String(body.command ?? "true")),
          );
        }
        if (rest === "/files" && method === "GET") {
          return send(res, 200, {
            entries: await this.deps.tasks.listDir(taskId, url.searchParams.get("path") ?? "."),
          });
        }
      }

      // Text generation: one prompt, no conversation. Resolved by the app
      // thread when the caller names one — the path it also sends is the app's
      // own checkout, which no task owns — and by the sandbox workspace
      // otherwise.
      if (path === "/text-generation" && method === "POST") {
        const cwd = String(body.cwd ?? "").trim();
        const threadId = String(body.threadId ?? "").trim();
        const prompt = String(body.prompt ?? "");
        if ((!cwd && !threadId) || !prompt) {
          throw new ExecutionError(
            "protocol_violation",
            "POST /text-generation needs `prompt` and either `threadId` or `cwd`",
            {},
          );
        }
        return send(res, 200, {
          ...(await this.deps.tasks.generateText({
            ...(cwd ? { cwd } : {}),
            ...(threadId ? { threadId } : {}),
            prompt,
            ...(body.model ? { model: String(body.model) } : {}),
          })),
        });
      }

      if (path === "/reconcile" && method === "POST") {
        return send(res, 200, await this.deps.controlPlane.reconcile());
      }

      return send(res, 404, { error: { code: "not_found", message: `${method} ${path}` } });
    } catch (err) {
      const error = errorPayload(err);
      return send(res, statusForErrorCode(error.code), { error });
    }
  };
}

function attachLive(
  tasks: TaskService,
  taskId: string,
  res: ServerResponse,
  from: number,
): () => void {
  let last = from;
  const interval = setInterval(() => {
    try {
      const events = tasks.events(taskId, last);
      for (const event of events) {
        last = event.seq;
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      clearInterval(interval);
    }
  }, 200);
  return () => clearInterval(interval);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
