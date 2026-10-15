# @t3tools/t3x — task sandboxes for T3 Code

A provider-agnostic remote execution system for [T3 Code](https://github.com/pingdotgg/t3code):
an always-on **VPS control plane** that owns conversation state, task
orchestration, environment profiles, secrets and scheduling, and **sandbox
containers** that own the repository, the agent process, MCP servers, Git and
tests. The sandboxes come from a self-hosted **OpenSandbox** lifecycle server
(the Docker runtime), reached over its HTTP API — see
[Sandbox provider](#sandbox-provider-opensandbox). By default a project shares
**one sandbox per repository**, and each task gets its own **git worktree**
inside it; a task can opt out and run in a sandbox of its own (see
[Sandbox scope](#sandbox-scope)).

It lives in this repository as a workspace package. T3 reaches it through
[`@t3tools/provider-opensandbox`](../provider-opensandbox), the provider driver that
proxies a thread's agent into a sandbox; this package owns the sandbox side —
tasks, environment profiles, sandbox lifecycle, the execution worker and the
client HTTP API. It runs on its own (a VPS, a laptop) and has no dependency on
T3's source tree.

This repository implements the architecture described in the technical report
_"T3 Code + VPS + task sandboxes"_, section by section.

**[docs/coding.md](./docs/coding.md) is the operator's guide**: install, model
gateway, profile, agents (codex, OpenClaw, claude, opencode), starting a coding
task from the app / the API / the CLI, deploying both halves, and a
troubleshooting table of the failures that actually happened.

Run it: `pnpm --filter @t3tools/t3x build && node packages/t3x/dist/src/cli.js serve`.

```
Mac GUI / phone GUI / CLI
        │  REST + SSE (task state, messages, approvals, event replay)
        ▼
┌──────────────────────────── VPS ────────────────────────────┐
│ Control plane                                               │
│   event store · command receipts · durable effect outbox    │
│   task state machine · environment profiles · policy engine │
│   worker registry (leases + fencing) · secrets broker       │
│   RemoteProviderAdapter · RemoteWorkspaceService            │
└───────────────┬─────────────────────────────────────────────┘
                │  authenticated outbound WebSocket, per sandbox
                ▼
┌───────────── sandbox container (per project, or per task) ──┐
│ execution worker (one per sandbox, many tasks bound to it)  │
│   provider runtimes (Codex / Claude / OpenCode / Pi / echo) │
│   base checkout + one git worktree per task                 │
│   MCP servers · provider processes · hidden-ref checkpoints │
└─────────────────────────────────────────────────────────────┘
```

## Design rules the code enforces

| Rule (from the report)                                                         | Where                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Execution target routing is separate from provider selection                   | `src/contracts/execution.ts`, `src/execution/ExecutionTargetResolver.ts`       |
| One sandbox per task; a task survives many turns and providers                 | `src/execution/SandboxControlPlane.ts`                                         |
| Scope is resolved once at task creation and never migrated later               | `src/contracts/sandboxScope.ts`, `SandboxControlPlane.createTask`              |
| A shared sandbox is reused only for a compatible environment                   | `ProjectSandboxStore.findReusableSandbox`, `sandboxCompatibilityKey`           |
| Every task works in its own git worktree, never in the shared checkout         | `SandboxControlPlane.assignWorkspace`, `WorkspaceRuntimeHost.worktree`         |
| A sandbox outlives its tasks only while something needs it (refcount)          | `ProjectSandboxStore.attachTask/releaseTask`, `PolicyEngine.evaluateSandboxes` |
| The control plane stops sandboxes explicitly; no provider idle timer           | `PolicyEngine`, `POST /sandboxes/:id/stop`                                     |
| The worker dials **out**; no worker port is exposed                            | `src/execution/WorkerConnectionRegistry.ts`, `src/worker/WorkerTransport.ts`   |
| Commands are idempotent by `effectId`; a retried `turn.start` never runs twice | `src/worker/CommandDedupe.ts`, `src/execution/EffectWorker.ts`                 |
| Worker leases with fencing epochs                                              | `WorkerConnectionRegistry`, `WorkerTransport`                                  |
| No silent local fallback for files/git/checkpoints                             | `src/execution/RemoteWorkspaceService.ts`                                      |
| Policy enforcement cannot be overridden by project or task layers              | `src/contracts/environmentProfile.ts`                                          |
| Resolved profile + digest pinned at task creation                              | `src/execution/EnvironmentProfileService.ts`                                   |
| Credentials are separate from configuration; never copied wholesale            | `src/execution/SecretsBroker.ts`                                               |
| Resume (same sandbox) vs restore (recreated environment) are distinct          | `SandboxControlPlane.resume/restore`, `TaskResumeKind`                         |
| Cost controls: never auto-stop an executing task; delete only after retention  | `src/execution/PolicyEngine.ts`                                                |

## Quick start

```bash
npm install
npm run build

# optional: real sandboxes instead of the local directory backend
export OPENSANDBOX_API_URL=https://sandbox.example.com   # opensandbox-server
export OPENSANDBOX_API_KEY=...
export OPENSANDBOX_IMAGE=t3x-sandbox:latest

# 1. define an environment profile
cat > profiles/typescript-backend.yaml <<'YAML'
apiVersion: t3x/v1
kind: EnvironmentProfile
metadata: { name: typescript-backend, version: 3 }
runtime:
  snapshot: node24-dev-v3
  resources: { cpu: 4, memoryGiB: 8 }
project:
  workingDirectory: /workspace/project
  setup: ["corepack enable", "pnpm install --frozen-lockfile"]
  allowedRepositories: ["github.com/nmime/*"]
environment: { NODE_ENV: development }
agents:
  allowed: [codex, claude, opencode]
  defaults: { provider: codex, permissionMode: supervised }
configuration:
  sources:
    - profile: mac-config-v1
sandbox:
  isolation: per-project        # share one sandbox per repository (default)
  maxConcurrentTasks: 4         # past this, a task spills into its own sandbox
  stopAfterIdleMinutes: 30
  deleteAfterCompletedHours: 48
YAML

# 2. import local agent configuration (Codex / Claude / OpenCode), secrets stripped
node dist/src/cli.js import-config --home ~ --name mac-config-v1

# 3. run the control plane (the sandbox backend is picked up from OPENSANDBOX_API_URL)
node dist/src/cli.js serve --state-dir ~/.t3x --port 8087 \
  --worker-url https://control-plane.example.com \
  --worker-bundle t3x-worker.tgz

# 4. create a task (provisions a sandbox and attaches a worker)
node dist/src/cli.js task create --profile typescript-backend \
  --repo github.com/nmime/backend --provider codex

# the per-task toggle: "run this task in a new sandbox"
node dist/src/cli.js task create --profile typescript-backend \
  --repo github.com/nmime/backend --provider codex --scope task

# 5. talk to it
node dist/src/cli.js task message <taskId> "implement the payment endpoint"
node dist/src/cli.js task status  <taskId>     # scope, project, worktree, sandbox
node dist/src/cli.js task git     <taskId>
node dist/src/cli.js project list              # projects and their sandboxes
node dist/src/cli.js sandbox list              # refcounts, state, last use
```

## Sandbox scope

A task runs either in the **project sandbox** — one sandbox per repository,
shared by every task of that project — or in a **sandbox of its own**. Shared is
the default; the per-task toggle ("Run this task in a new sandbox" in the GUI,
`--scope task` on the CLI) buys a dedicated sandbox for one task.

Sharing a sandbox never means sharing a working directory: every task gets its
own **git worktree** at `/workspace/worktrees/<taskId>` on branch
`t3x/<taskId>`, created from the base checkout when the task is provisioned.
Dependencies, package caches, dev servers and MCP processes are shared; files,
diffs and checkpoints are per task. Worktrees are not a security boundary — two
tasks that must not see each other's credentials get different sandboxes.

Scope is resolved **once**, at task creation, and written into the task record:

```
task request scope  →  project default (ProjectExecutionPolicy.defaultScope)
                    →  global default (--default-scope, or per-task when the
                       profile sets sandbox.isolation: per-task)
```

`PolicyEnforcement.requireTaskIsolation` in the resolved profile outranks all
three: with it set, every task gets its own sandbox and no project or task
setting can make it share.

Changing a default afterwards never migrates an existing or running task; it
applies to tasks created next. A project sandbox is created **lazily**, with the
first task that resolves to it.

A project sandbox is reused only when it is **compatible** with the task: same
repository, same Environment Profile (including snapshot, OS and resources), and
same security policy. Compatibility is a digest, `sandboxCompatibilityKey`; a
project whose tasks need two different environments simply owns two sandboxes,
one per environment, so an incompatible task never lands in someone else's
sandbox. Credentials are part of that digest, so a task whose secrets carry a
different trust level gets its own sandbox rather than a worktree next door.

Two cases produce a dedicated sandbox even when the scope says `project`:

- the task has **no repository** (there is nothing to worktree);
- the project sandbox is **full** — `maxConcurrentTasks` tasks are already bound
  to it (the tighter of `ProjectExecutionPolicy.maxConcurrentTasks` and the
  profile's `sandbox.maxConcurrentTasks`). The task is created with
  `sandboxScope: "task"` and a `task.sandbox_scope_overridden` event explains
  why, so the client can show the toggle as "forced for this task".

Lifecycle is **reference counted**, and the control plane drives it explicitly —
the provider's own idle timer is never the thing that decides:

- `ProjectSandboxStore.attachTask` on provision, `releaseTask` on stop, destroy
  or completion; the sandbox record carries the count.
- A sandbox is stopped only at count 0 **and** idle past
  `stopAfterIdleMinutes`; a turn, an approval or a background process keeps it
  alive regardless of the clock (`PolicyEngine.evaluateSandboxes`).
- `POST /sandboxes/:id/stop` and `t3x sandbox stop` refuse while any task is
  bound (`sandbox.stop_refused`), so a client cannot cut the legs off a running
  task.
- Stopping never deletes: the checkout, the worktrees and the state directory
  survive, and `resume` restarts the worker over the same files. Deletion is a
  separate act — `POST /sandboxes/:id/destroy`, or the retention rule once the
  sandbox has been stopped, empty, past `deleteAfterCompletedHours`.
- When the **last** task leaves, a project sandbox is stopped, not destroyed; a
  dedicated sandbox is destroyed with its task, as before.
- Every sandbox is recorded, project or dedicated (with `projectId: null`), so
  the settings page lists them all and stop/destroy work for either kind.

```
GET  /projects                    POST /projects        (defaultScope, maxConcurrentTasks)
GET  /projects/:id/sandboxes
GET  /sandboxes                   POST /sandboxes/:id/stop   POST /sandboxes/:id/destroy
```

`t3x task status <taskId>` reports `sandboxScope`, `projectId`, `worktreePath`,
`worktreeBranch`, the resolved `binding` and, for a shared sandbox, the other
tasks it is `sharedWith`.

## Tests

The suite is the report's §9 acceptance list, executed against real processes:
real worker child processes over real WebSockets, real sandbox directory trees,
real Git repositories.

```bash
npm test               # everything
npm run test:unit
npm run test:integration
```

| Report §9 scenario                                                                                        | Test                                                                        |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. Separate sandboxes per provider (Codex / Claude / OpenCode)                                            | `tests/integration/lifecycle.test.ts`                                       |
| 2. Import reusable environment configuration                                                              | `tests/unit/controlPlane.test.ts`, `tests/integration/workspace.test.ts`    |
| 3. Mac → phone → Mac on the same conversation                                                             | `tests/integration/lifecycle.test.ts`                                       |
| 4. Interrupt, approve and resume remotely                                                                 | `tests/integration/lifecycle.test.ts`                                       |
| 5. Diffs, git state and checkpoints bound to the correct sandbox                                          | `tests/integration/workspace.test.ts`                                       |
| 6. Stop/restart a sandbox, continue the native session                                                    | `tests/integration/recovery.test.ts`                                        |
| 7. Kill the worker, reconnect without duplicating a turn                                                  | `tests/integration/recovery.test.ts`                                        |
| 8. Kill the control plane, recover and reconcile                                                          | `tests/integration/recovery.test.ts`                                        |
| 9. Duplicate commands, expired credentials, deleted sandboxes                                             | `tests/unit/controlPlane.test.ts`, `tests/integration/recovery.test.ts`     |
| 10. Cross-task isolation (files, credentials, RPC)                                                        | `tests/integration/isolation.test.ts`                                       |
| 11. Sandbox scope: shared project sandbox, worktree per task, toggle, compatibility, refcounted lifecycle | `tests/integration/sandboxScope.test.ts`, `tests/unit/sandboxScope.test.ts` |

Plus: the protocol and state machine (`tests/unit/protocol.test.ts`), profile
layering and policy (`tests/unit/environmentProfile.test.ts`), and the client
surfaces — HTTP API and CLI — driven as a Mac/phone client would drive them
(`tests/integration/cli.test.ts`).

## Documentation

- [`docs/setup.md`](docs/setup.md) — the ordered walkthrough: prerequisites,
  build, the OpenSandbox server and sandbox image, profile, worker bundle,
  `serve`, the T3 instance, the first thread, the verification ladder and
  troubleshooting.
- [`docs/t3-integration.md`](docs/t3-integration.md) — which T3 source files this
  replaces or extends, and in what order to do it.
- [`docs/operations.md`](docs/operations.md) — VPS deployment, sandbox-server
  setup, credentials, recovery and troubleshooting.
- [`profiles/`](profiles) — example environment profiles.
- [`deploy/t3x-control-plane.service`](deploy/t3x-control-plane.service) — systemd unit.
- [`deploy/host-t3-app.sh`](deploy/host-t3-app.sh) — the same host, running the
  T3 Code app itself (web UI + server) behind nginx, with one OpenSandbox
  provider instance pointed at this control plane.
- [`deploy/sandbox-image/Dockerfile`](deploy/sandbox-image/Dockerfile) — the image
  every sandbox is built from.
- [`deploy/ci.yml`](deploy/ci.yml) — GitHub Actions workflow (copy to
  `.github/workflows/ci.yml`; pushing a workflow file needs a token with the
  `workflow` scope).

## Layout

```
src/contracts/          execution · environmentProfile · workerProtocol · errors
src/execution/          control plane (VPS side)
src/execution/backends/ SandboxBackend, local/LocalBackend, opensandbox/OpenSandboxBackend
src/orchestration-v2/   RemoteProviderAdapter (T3-shaped provider surface)
src/worker/             execution worker (sandbox side) + provider runtimes
src/config-importer/    Mac → Linux configuration import + secret redaction
src/cli.ts              t3x CLI
profiles/               example environment profiles
```

### Wiring into a T3 fork

`src/orchestration-v2/RemoteProviderAdapter.ts` implements the same operation
set as T3's `ProviderAdapterV2` (open/ensure/resume thread, start/interrupt/
steer turn, runtime requests, rollback, fork, event stream) and returns T3-shaped
normalized events. In a fork of `pingdotgg/t3code` it replaces the local
adapter in `ProviderAdapterRegistry` for tasks whose execution target is a
sandbox, while `apps/server/src/git/*` and the checkpoint store are routed
through `RemoteWorkspaceService` instead of local paths. See
`docs/t3-integration.md`.

## Sandbox provider (OpenSandbox)

The sandboxes are **OpenSandbox** containers
(<https://github.com/opensandbox-group/OpenSandbox>, Apache-2.0): a lifecycle
REST API (`opensandbox-server`) plus an agent, `execd`, injected into each
sandbox container. The Docker runtime on one host is enough — no Kubernetes, no
microVMs.

`OpenSandboxBackend` talks to it over plain HTTP:

| `SandboxBackend`         | OpenSandbox                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `create`                 | `POST /v1/sandboxes` (image, entrypoint, `resourceLimits`, env, timeout)                     |
| `status` / `list`        | `GET /v1/sandboxes/{id}` / `GET /v1/sandboxes?page=…`                                        |
| `stop` / `start`         | `POST /v1/sandboxes/{id}/pause` / `…/resume`                                                 |
| `destroy`                | `DELETE /v1/sandboxes/{id}`                                                                  |
| `snapshot`               | `POST /v1/sandboxes/{id}/snapshots` (fsb/Kubernetes runtimes; the Docker runtime refuses it) |
| `exec`                   | `POST /v1/sandboxes/{id}/proxy/44772/command` — a stream of JSON events                      |
| `execDetached`           | the same route with `background: true`; the id is the `init` event's text                    |
| `readFile` / `writeFile` | `…/files/download?path=…` / `…/files/upload` (multipart, metadata as a file part)            |
| `listDir`                | `…/directories/list?path=…&depth=1`                                                          |
| `previewUrl`             | `https://<sandbox-host>/v1/sandboxes/{id}/proxy/{port}/` — the one path needing no API key   |

```bash
export OPENSANDBOX_API_URL=https://sandbox.example.com
export OPENSANDBOX_API_KEY=...
export OPENSANDBOX_IMAGE=t3x-sandbox:latest   # deploy/sandbox-image/Dockerfile
node dist/src/cli.js worker bundle --out t3x-worker.tgz
node dist/src/cli.js serve --state-dir ~/.t3x --port 8087 \
  --worker-url https://control-plane.example.com \
  --worker-bundle t3x-worker.tgz
```

With a URL or a key set, `serve` picks the OpenSandbox backend on its own
(`--backend auto`, the default); `--backend local` keeps the directory backend
for development. `t3x doctor` reports which backend a host would use, whether
the server answered, and which version it is.

Four things a real deployment has to get right, each of which is a silent
failure otherwise:

- **`--worker-url` is the address a sandbox dials.** The default
  `http://127.0.0.1:<port>/worker` is only correct when the worker runs on the
  same host as the control plane. Sandboxes dial _out_, so this must be an
  address reachable from inside a sandbox; the control plane needs no inbound
  port of its own.
- **The worker has to exist inside the sandbox.** A sandbox has no access to
  the control plane's filesystem, so `t3x worker bundle` packs the compiled
  worker and its production dependencies, and `--worker-bundle` uploads and
  unpacks it into `<sandbox home>/.t3x-worker` on provisioning. Without it the
  worker entry points at a path that does not exist in the sandbox.
- **The image has to be on the Docker host.** Sandboxes are containers from
  `OPENSANDBOX_IMAGE` (`deploy/sandbox-image/Dockerfile`: Node 24, git, pnpm, a
  toolchain). The lifecycle server starts them; a missing image is a failed
  create.
- **`resourceLimits` are cgroup limits.** A profile's `runtime.resources`
  become `cpu`/`memory` limits on the container, so a task cannot take the host
  down with it. A profile that names a `runtime.snapshot` instead asks the
  server to restore one — a Docker deployment has none, which is why profiles
  here are image-backed.

Credentials follow the same rule as the rest of the system — the sandbox
server's API key never enters a sandbox, and never reaches an agent:

- `inject: env` secrets are set as sandbox environment variables at creation;
- `inject: headers` secrets need a `hostAllowlist` in the profile, and are
  refused: this backend has no outbound substitution layer (OpenSandbox's
  credential vault is an egress feature), so declaring one is an error rather
  than a silent no-op;
- there is no API to attach either to a _running_ sandbox, so `injectSecrets`
  after creation is refused with `sandbox_backend_unsupported`.

Preview links need no token and do not expire (`PreviewLink.token === null`,
`expiresAt === null`): the sandbox's own ports stay bound to loopback
(`publish_host = 127.0.0.1`), and the only way in is the lifecycle server's
proxy path, which is exactly the URL `previewUrl` returns.

### What the tests prove against the real API

`tests/integration/openSandboxReal.test.ts` runs only when
`OPENSANDBOX_API_URL` is set, and otherwise reports as skipped:

| Test                 | What it does against a real server                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| health and version   | `GET /health` answers without a key                                                                 |
| create, use, destroy | setup steps, environment variables, file round-trip, directory listing, preview link, list, destroy |
| detached command     | a background command started through `execDetached` is still running after the call returns         |

`tests/unit/openSandboxBackend.test.ts` runs the same code against a fake
lifecycle server that answers exactly what `opensandbox-server` 1.1.1 answered
when this backend was written — including the two things a first draft gets
wrong: the exit status of a failed command lives in an `error` event, and an
upload's metadata must be a file part.

### The end-to-end smoke test

```bash
OPENSANDBOX_API_URL=https://sandbox.example.com OPENSANDBOX_API_KEY=... \
  node packages/t3x/scripts/sandbox-smoke/run.mjs
```

It creates a sandbox through the backend, ships the built package into it, and
runs `scripts/sandbox-smoke/smoke.sh` there: the control plane **and** the
worker inside that one sandbox (so the worker's WebSocket is real, without
having to cross a network boundary), covering task creation, worker attach, a
real turn, the runtime-mode cap, fork, text generation, sandbox scope and
reference counting, stop refusal, per-worktree git state and checkpoints — 43
checks. The sandbox is deleted afterwards, including when a check fails.
`T3X_SMOKE_KEEP=1` leaves it for inspection.

**What those tests still do not prove.** The worker's dial _into_ the control
plane is not exercised from a sandbox on a _different_ host from the control
plane in this deployment: the smoke test runs both in one sandbox on purpose.
What is proven is the bundle landing and the worker process starting inside a
real sandbox, and — on the T3 side —
`apps/server/src/orchestration-v2/Adapters/OpenSandboxAdapterV2.e2e.test.ts`, which
drives a dispatched message all the way through T3's own orchestrator, ingestor
and projection against a real control plane and a real worker. The socket
itself is covered by the local-backend suite (a real child process over a real
WebSocket), and the deployment that motivated all of this runs the sandbox
server on the same host as the control plane, where the dial is a normal
outbound HTTPS request.

## License

MIT
