# @t3tools/provider-opensandbox

Run a thread's agent inside an **OpenSandbox sandbox** instead of on the machine
running the T3 server.

This package is the T3 side of that arrangement: a provider _driver_
(`driver: "opensandbox"`) whose adapter is a proxy to a `@t3tools/t3x` control
plane. T3 keeps owning the app thread, the run bookkeeping and the UI; the
control plane owns the sandbox, the repository, the environment profile, the
agent process and the durable event log.

```
T3 server ── ProviderAdapterV2 ──► @t3tools/provider-opensandbox ── HTTP + SSE ──► control plane
                                                                                    │
                                                                        OpenSandbox sandbox (worker)
                                                                        agent · repo · git worktree
```

## What maps to what

| T3                       | t3x control plane API                                         |
| ------------------------ | ------------------------------------------------------------- |
| app thread               | task (`POST /tasks`, one per thread)                          |
| turn                     | message (`POST /tasks/:id/messages`)                          |
| interrupt / steer        | `POST /tasks/:id/interrupt`, `/steer`                         |
| approval                 | runtime request (`POST /tasks/:id/approvals/:id`)             |
| thread snapshot          | `GET /tasks/:id/snapshot`                                     |
| rollback to a checkpoint | `POST /tasks/:id/checkpoints/:id/restore`                     |
| provider events          | the task's event stream (`?stream=sse`), translated per event |

The sandbox is where the work happens, so a project's tasks can share one
sandbox with a git worktree each — that is the control plane's decision
(`sandboxScope`), not T3's, and it is visible to a client through the snapshot.

## Setting it up

Three things have to be true: a control plane is running, the driver is in the
server's built-in list, and an instance points at the control plane.

### 1. Run a control plane

The sandbox side lives in [`@t3tools/t3x`](../t3x). Build it, define an
environment profile, and serve:

```bash
pnpm --filter @t3tools/t3x build
node packages/t3x/dist/src/cli.js import-config --home ~ --name mac-config-v1
node packages/t3x/dist/src/cli.js serve --state-dir ~/.t3-opensandbox --port 8087
```

Set `OPENSANDBOX_API_KEY` on the control plane to provision real OpenSandbox sandboxes;
without it the local backend uses directories, which is what the tests do. Check
it with `curl -s localhost:8087/health` and `curl -s localhost:8087/profiles`.
Give the control plane an `--api-token` if it is reachable from anywhere but
localhost, and pass the same token to the instance below.

### 2. Confirm the driver is registered

`apps/server/src/provider/builtInDrivers.ts` lists `OpenSandboxDriver` in
`BUILT_IN_DRIVERS`. That array is what `ProviderInstanceRegistry` resolves
`ServerSettings.providerInstances` against, so it — not
`orchestration-v2/builtInProviderAdapterDrivers.ts`, which nothing in the runtime
reads — is what makes `"driver": "opensandbox"` a live provider instead of an
_unavailable shadow_ snapshot in Settings.

### 3. Add an instance

**Settings → Providers → Add provider → OpenSandbox.** The form is the schema in
`src/settings.ts`; every field is documented there. It writes one entry into the
server settings' `providerInstances` map:

```jsonc
{
  "providerInstances": {
    "opensandbox_backend": {
      "driver": "opensandbox",
      "displayName": "OpenSandbox (backend)",
      "config": {
        "enabled": true,
        "controlPlaneUrl": "https://t3x.example.com",
        "apiToken": "…", // only if the control plane requires one
        "profileId": "typescript-backend", // an environment profile it knows
        "repositoryUrl": "github.com/nmime/backend", // omit for a scratch workspace
        "branch": "main",
        "sandboxScope": "project", // or "task" for a sandbox per thread
        "agent": "codex", // codex · claude · opencode · pi · echo
        "model": "default",
      },
    },
  },
}
```

`apiToken` is a secret field: it is kept in the server's secret store and is
never sent into a sandbox or to an agent.

`hasDefaultInstance` is `false`, so no instance is auto-created — an OpenSandbox
provider means nothing until it has a URL. Until you add one, no thread routes to
it.

### 4. Use it

Pick the instance in the composer, or set it as a project's default provider.
From then on, a thread is a **task** on the control plane: T3 sends the first
turn, the control plane provisions the sandbox (or reuses the project's), creates
the task's git worktree, starts the agent, and streams events back. Approvals,
interrupts, steering, snapshots and checkpoint rollback all go through the same
route. `t3x task status <taskId>` on the control plane shows the scope, project,
worktree and sandbox that thread landed on.

`agent` decides what the sandbox runs; T3's model selection is passed through as
the turn's model. The adapter reads the worker's capability inventory as soon as
a task is ready and reports _those_ capabilities, so T3 never offers a control
the sandbox cannot honour — a CLI agent, for instance, cannot be steered.

The instance's status line in Settings is the **control plane's** health, as the
driver probes it: reachable, token accepted, and the named environment profile
present. A failure says which of the three it was.

## What is not supported

- **Tool items, plans and subagents.** The control plane's normalized protocol
  carries messages, turns and runtime requests; T3's tool/plan/subagent events
  are reported as unsupported rather than faked.
- **Review guides.** `generateReviewGuide` is refused with
  `investigationUnsupported`: it is the one text-generation operation that needs
  read-only tools over several turns, and the sandbox's one-shot invocation has
  no read-only mode to promise. Every other operation generates (below), so T3
  falls back for this one operation only.
- **Forking a dedicated sandbox.** A thread whose sandbox is its own has no
  project to fork into — its conversation lives in a worker no other task can
  reach — so `forkThread` refuses it with `capability_unsupported`. Threads in a
  shared project sandbox fork normally.

## Forking

`forkThread` creates a task in the source's project, so the fork shares the
sandbox and gets its own worktree based on the source's branch head: committed
work comes along, uncommitted work does not, because a worktree belongs to one
task and two agents must not write the same files. The conversation comes along
as a native thread fork, and the worker reports what it inherited (`forkedFrom`,
`messageCount`) on the fork's `thread.updated`.

The control plane does **not** replay the source's messages into the fork's
event log: T3 carries its own copy of the conversation into the new thread, and
replaying them would append every message a second time.

## Text generation

Commit messages, change-request content, branch names and thread titles run in
the sandbox: the prompt T3 builds is handed to the agent there, one-shot, and its
reply is decoded against the operation's own schema. The adapter implements T3's
`ProviderTextGeneration` through `fromRunner` over the control plane's
`POST /text-generation`, so T3's prompts and reply parsing are used unchanged.

The endpoint resolves the caller's `cwd` to the task that owns it — its worktree,
or the shared base checkout, where the task worked in most recently — and a
workspace no task owns is refused with `task_not_found` rather than guessed at.
Generation is not a turn: nothing is written to the task's event log, so a
generated commit message never appears in the thread that asked for it.

## Runtime modes

A profile names the strongest T3 runtime mode it permits:

```yaml
agents:
  allowed: [codex]
  maxRuntimeMode: auto-accept-edits # approval-required < auto-accept-edits < auto < full-access
```

The control plane enforces it: a turn stronger than the pinned profile's cap is
refused with `capability_unsupported` before anything reaches a sandbox, and the
mode a turn runs under is recorded with the turn and passed to the sandbox. A
project or task layer may tighten the cap, never loosen it.

The snapshot carries `runtimeModeCap`, and the adapter reports
`runtimePolicy.enforcement: "native"` only when the cap restricts something. With
the default cap of `full-access` nothing is restricted and it still reports
`client-boundary` rather than overclaiming; how the agent's own flags map to a
mode is the profile's business, not this adapter's.

## Tests

```bash
pnpm --filter @t3tools/provider-opensandbox test
```

`src/server/controlPlane.test.ts` runs the client against a **real** control
plane from `@t3tools/t3x` — real sandbox directories, a real worker, real
turns — because both halves live in this repository. It covers thread→task
creation, turns, the snapshot a client resumes from, the event stream, an
approval round trip, checkpoint rollback, forking, text generation, the
runtime-mode cap, typed refusals and the shared-sandbox worktree model.

### The end-to-end test through T3's own orchestration

`apps/server/src/orchestration-v2/Adapters/OpenSandboxAdapterV2.e2e.test.ts` is the
one test that does not stop at the control-plane boundary. It dispatches a real
`thread.create` and `message.dispatch` through T3's real orchestrator, session
manager, turn-start service, `RunExecutionService` and `ProviderEventIngestor`,
over the real v1 driver and the real adapter, against a real control plane with
a real worker process — and asserts what T3's own projection holds afterwards:
the user's message, the agent's reply under the runtime mode the thread asked
for, one provider thread carrying the worker's native id, and one provider turn.

```bash
pnpm --filter @t3tools/t3x build     # the test imports the built control plane
node_modules/.bin/vp test run apps/server/src/orchestration-v2/Adapters/OpenSandboxAdapterV2.e2e.test.ts --no-file-parallelism
```

It needs `TestProviderHost` in the runtime context (the replay harness does not
provide it, because replay adapters never ask for it) — that is the one piece of
setup the test does that the replay harness does not.

Writing it found five contract bugs the boundary-level tests could not see, all
of which are now covered by `src/server/events.test.ts`:

- `providerSession.createdAt`/`updatedAt` were JavaScript `Date`s where T3's
  schema wants `DateTime.Utc`, so the session's own activity write failed and
  took the turn start with it. The `as never` casts that hid this are gone.
- mapped messages and turns carried the _control plane's_ run id, so T3's run
  router dropped every one of them (`ownsRun`) and the run never completed;
- `providerTurn.runAttemptId` was null, so T3 never recognized its own root turn
  and dropped `turn.terminal` with it;
- the user's own message was mapped back into T3, duplicating it;
- the adapter minted its own provider-thread row instead of adopting the
  provisional row T3 hands over as `existingProviderThread`, and re-keyed the
  thread from the worker's native id on `thread.updated` — either one leaves two
  provider-thread rows per app thread, with `activeProviderThreadId` flapping
  between them.

### What the tests still do not prove

One leg, and it is environmental rather than code: a _remote_ sandbox dialing a
control plane across a network boundary. Everywhere a control plane and its
worker can reach each other (the local backend, a VPS, a self-hosted OpenSandbox
deployment), the path is the same code and is covered — the local suite runs the
real child process over a real WebSocket, and the e2e test above runs the whole
loop. On Daytona's restricted-egress tiers a task sandbox cannot reach a control
plane hosted anywhere else, which is why the backend moved to a self-hosted
OpenSandbox deployment; there the run stops with `task.worker_attach_failed`
after the bundle lands and the worker process starts. `packages/t3x/README.md`
says the same thing from the control plane's side.

## Renamed from Daytona

The package, the driver and the control plane were named after Daytona, the
managed sandbox product this integration was first built against. The backend is
now a self-hosted OpenSandbox deployment, so the names followed it:

| before                                 | now                             |
| -------------------------------------- | ------------------------------- |
| `@t3tools/provider-daytona`            | `@t3tools/provider-opensandbox` |
| `DaytonaDriver`                        | `OpenSandboxDriver`             |
| `DaytonaAdapterV2Driver`               | `OpenSandboxAdapterV2Driver`    |
| `DAYTONA_DRIVER`                       | `OPENSANDBOX_DRIVER`            |
| `driver: "daytona"`                    | `driver: "opensandbox"`         |
| `@t3tools/daytona` (the control plane) | `@t3tools/t3x`                  |

Two names are kept on purpose, because they are stored rather than imported: a
`providerInstances` entry that still says `"driver": "daytona"` is renamed when
the server loads its settings (`PROVIDER_DRIVER_RENAMES` in
`apps/server/src/serverSettings.ts`), and an environment profile that still says
`apiVersion: t3-daytona/v1` still parses. Nothing writes either any more.

## Typechecking

```bash
pnpm --filter @t3tools/provider-opensandbox typecheck   # tsc -p tsconfig.json --noEmit
```

This package's `exports` point at its TypeScript sources, so the moment
`apps/server` imports `@t3tools/provider-opensandbox/server` its sources join the
**app's** program and are checked with the app's options. Two consequences worth
knowing:

- `apps/server/tsconfig.json` extends `tsconfig.base.json`, which enables
  `erasableSyntaxOnly`. This package's own tsconfig therefore enables it too: a
  constructor parameter property compiles under plain `tsc` here but is a hard
  `TS1294` error in the app. That is exactly how one slipped in once.
- The app's compiler is `tsc-rs` (the Effect language service), whose _style_
  diagnostics (`globalDate`, `globalTimers`, `nodeBuiltinImport`, …) are
  reported only for files that are roots of the program. This package's files
  are dependencies of `apps/server`, never roots, so its plain-Node idioms are
  not flagged — the same is true of the app's own code. The package is
  deliberately plain Node (a control-plane client, not an Effect service), so it
  typechecks with `tsc`, not `tsc-rs`.

Verification actually performed:

| check                                                                                                    | result                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -p packages/provider-opensandbox/tsconfig.json`                                                     | clean                                                                                                                                                    |
| `tsc -p packages/t3x/tsconfig.json --noEmit`                                                             | clean (57/57 control-plane tests)                                                                                                                        |
| `tsc-rs --noEmit` over the registration path (`builtInProviderAdapterDrivers.ts`) with the app's options | clean, 1.2 GB peak RSS                                                                                                                                   |
| `tsc-rs --noEmit` over `apps/server/src` (tests/scripts excluded) with the app's options                 | **0 errors**, 3.1 GB peak RSS                                                                                                                            |
| `tsc-rs --noEmit` over the web settings entry (`providerDriverMeta.ts`) with the app's options           | clean                                                                                                                                                    |
| `tsc-rs --noEmit -p apps/server/tsconfig.json` (the app's own script)                                    | **not runnable here**: peak RSS 3.9 GB against a hard 4 GB cgroup with swap disabled, OOM-killed before it can report. Needs a machine with more memory. |
