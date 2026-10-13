# @t3tools/daytona — task sandboxes for T3 Code

A provider-agnostic remote execution system for T3 Code: an always-on **VPS
control plane** that owns conversation state, task orchestration, environment
profiles, secrets and scheduling, and **Daytona sandboxes** that own the
repository, the agent process, MCP servers, Git and tests.

It lives in this repository as a workspace package. T3 reaches it through
[`@t3tools/provider-daytona`](../provider-daytona), the provider driver that
proxies a thread's agent into a sandbox; this package owns the sandbox side —
tasks, environment profiles, sandbox lifecycle, the execution worker and the
client HTTP API. It runs on its own (a VPS, a laptop) and has no dependency on
T3's source tree.

Run it: `pnpm --filter @t3tools/daytona build && node packages/daytona/dist/src/cli.js serve`.

A provider-agnostic remote execution system for [T3 Code](https://github.com/pingdotgg/t3code):
an always-on **VPS control plane** that owns conversation state, task
orchestration, environment profiles, secrets and scheduling, and **Daytona
sandboxes** that own the repository, the agent process, MCP servers, Git and
tests. By default a project shares **one sandbox per repository**, and each task
gets its own **git worktree** inside it; a task can opt out and run in a sandbox
of its own (see [Sandbox scope](#sandbox-scope)).

This repository implements the architecture described in the technical report
_"T3 Code + VPS + Daytona task sandboxes"_, section by section.

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
┌────────────── Daytona sandbox (per project, or per task) ───┐
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
npm install @daytonaio/sdk

# 1. define an environment profile
cat > profiles/typescript-backend.yaml <<'YAML'
apiVersion: t3-daytona/v1
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

# 3. run the control plane (Daytona backend automatically when DAYTONA_API_KEY is set)
node dist/src/cli.js serve --state-dir ~/.t3-daytona --port 8087 \
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
Daytona's idle timer is never the thing that decides:

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

- [`docs/t3-integration.md`](docs/t3-integration.md) — which T3 source files this
  replaces or extends, and in what order to do it.
- [`docs/operations.md`](docs/operations.md) — VPS deployment, Daytona setup,
  credentials, recovery and troubleshooting.
- [`profiles/`](profiles) — example environment profiles.
- [`deploy/t3x-control-plane.service`](deploy/t3x-control-plane.service) — systemd unit.
- [`deploy/ci.yml`](deploy/ci.yml) — GitHub Actions workflow (copy to
  `.github/workflows/ci.yml`; pushing a workflow file needs a token with the
  `workflow` scope).

## Layout

```
src/contracts/          execution · environmentProfile · workerProtocol · errors
src/execution/          control plane (VPS side)
src/execution/daytona/  SandboxBackend, LocalBackend, DaytonaBackend
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

## Running against real Daytona sandboxes

`DaytonaBackend` maps to the Daytona TypeScript SDK, package name
**`@daytonaio/sdk`** (verified against 0.224.0): snapshots and images, process
execution, file transfer, stop/start, organization secrets and port preview
links.

```bash
npm install @daytonaio/sdk            # or: pnpm add @daytonaio/sdk --filter @t3tools/daytona
export DAYTONA_API_KEY=...
node dist/src/cli.js worker bundle --out t3x-worker.tgz
node dist/src/cli.js serve --state-dir ~/.t3x-daytona --port 8087 \
  --worker-url https://control-plane.example.com \
  --worker-bundle t3x-worker.tgz
```

With `DAYTONA_API_KEY` set, `serve` picks the Daytona backend on its own
(`--backend auto`, the default); `--backend local` keeps the directory backend
for development. `t3x doctor` reports which backend a host would use, and
whether the SDK resolves.

Three things a real deployment has to get right, each of which is a silent
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
- **Snapshots decide the resources.** Creating from a snapshot ignores the
  profile's `runtime.resources` (the snapshot fixes cpu/memory/disk); the
  profile's numbers apply only when the profile names no snapshot and the
  sandbox is built from an image. `runtime.snapshot` must name a snapshot that
  exists in the organization.

Credentials follow the same rule as the rest of the system — the organization
API key never enters a sandbox, and never reaches an agent:

- `inject: env` secrets are set as sandbox environment variables at creation;
- `inject: headers` secrets need a `hostAllowlist` in the profile, and become
  organization secrets that the platform substitutes on outbound requests to
  those hosts, so the value never lands in the sandbox's filesystem;
- Daytona has no API to attach either to a _running_ sandbox, so
  `injectSecrets` after creation is refused with `sandbox_backend_unsupported`
  rather than silently doing nothing.

Preview links are token-scoped rather than time-limited
(`PreviewLink.expiresAt === null`); when the sandbox is private, pass the token
as `X-Daytona-Preview-Token`.

### What the tests prove against the real API

`tests/integration/daytonaReal.test.ts` runs only when `DAYTONA_API_KEY` is set
and the SDK resolves, and otherwise reports as skipped:

| Test                       | What it does against real Daytona                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| SDK and authentication     | loads `@daytonaio/sdk` and lists the organization's managed sandboxes                                                                |
| create, use, destroy       | setup steps, environment variables, file round-trip, `git clone` + `git worktree`, preview link, stop/start retaining files, destroy |
| control plane provisioning | a task provisions a real sandbox, clones its repository and creates the task's worktree                                              |
| worker bundle              | `t3x worker bundle` output is uploaded, unpacked and started inside a real sandbox                                                   |

`T3X_DAYTONA_TEST_SNAPSHOT` (default `daytona-small`) selects the snapshot;
`T3X_DAYTONA_TEST_REPO` the repository the control-plane test clones.

**What those tests still do not prove.** The worker's dial _into_ the control
plane is not exercised end to end from a real sandbox in a network where the
control plane is not reachable: the tests stop at that boundary (the run ends
with `task.worker_attach_failed`). What is proven for that leg is the bundle
landing and the worker process starting inside the sandbox; the socket itself
is covered by the local-backend suite, where the worker is a real child process
over a real WebSocket.

## License

MIT
