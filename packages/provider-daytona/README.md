# @t3tools/provider-daytona

Run a thread's agent inside a **Daytona task sandbox** instead of on the machine
running the T3 server.

This package is the T3 side of that arrangement: a provider *driver*
(`driver: "daytona"`) whose adapter is a proxy to a `@t3tools/daytona` control
plane. T3 keeps owning the app thread, the run bookkeeping and the UI; the
control plane owns the sandbox, the repository, the environment profile, the
agent process and the durable event log.

```
T3 server ── ProviderAdapterV2 ──► @t3tools/provider-daytona ── HTTP + SSE ──► control plane
                                                                                    │
                                                                        Daytona sandbox (worker)
                                                                        agent · repo · git worktree
```

## What maps to what

| T3 | Daytona |
|---|---|
| app thread | task (`POST /tasks`, one per thread) |
| turn | message (`POST /tasks/:id/messages`) |
| interrupt / steer | `POST /tasks/:id/interrupt`, `/steer` |
| approval | runtime request (`POST /tasks/:id/approvals/:id`) |
| thread snapshot | `GET /tasks/:id/snapshot` |
| rollback to a checkpoint | `POST /tasks/:id/checkpoints/:id/restore` |
| provider events | the task's event stream (`?stream=sse`), translated per event |

The sandbox is where the work happens, so a project's tasks can share one
sandbox with a git worktree each — that is the control plane's decision
(`sandboxScope`), not T3's, and it is visible to a client through the snapshot.

## Configuring an instance

```jsonc
{
  "id": "daytona_backend",
  "driver": "daytona",
  "displayName": "Daytona (backend)",
  "config": {
    "controlPlaneUrl": "https://t3x.example.com",
    "apiToken": "…",                      // when the control plane requires one
    "profileId": "typescript-backend",    // environment profile to provision from
    "repositoryUrl": "github.com/nmime/backend",
    "branch": "main",
    "sandboxScope": "project",            // or "task" for a sandbox per thread
    "agent": "codex",                     // codex · claude · opencode · pi · echo
    "model": "default"
  }
}
```

`agent` decides what the sandbox runs; T3's model selection is passed through as
the turn's model. The adapter reads the worker's capability inventory as soon as
a task is ready and reports *those* capabilities, so T3 never offers a control
the sandbox cannot honour — a CLI agent, for instance, cannot be steered.

## What is not supported (yet)

- **Forking** a thread. `canForkThread` is false and `forkThread` fails with
  `ProviderAdapterForkThreadError`. The control plane has the pieces (a task can
  be created in the same project, and the worker can fork a native thread), but
  the cross-task thread plumbing is not wired.
- **Tool items, plans and subagents.** The control plane's normalized protocol
  carries messages, turns and runtime requests; T3's tool/plan/subagent events
  are reported as unsupported rather than faked.
- **Native runtime-mode enforcement.** The sandbox profile carries the
  environment, but T3's runtime modes are enforced at the client boundary
  (`runtimePolicy.enforcement: "client-boundary"`), which the report calls out
  as a real reduction in guarantee.

## Tests

```bash
pnpm --filter @t3tools/provider-daytona test
```

`src/server/controlPlane.test.ts` runs the client against a **real** control
plane from `@t3tools/daytona` — real sandbox directories, a real worker, real
turns — because both halves live in this repository. It covers thread→task
creation, turns, the snapshot a client resumes from, the event stream, an
approval round trip, checkpoint rollback, typed refusals and the shared-sandbox
worktree model.

## Typechecking

```bash
pnpm --filter @t3tools/provider-daytona typecheck   # tsc -p tsconfig.json --noEmit
```

This package's `exports` point at its TypeScript sources, so the moment
`apps/server` imports `@t3tools/provider-daytona/server` its sources join the
**app's** program and are checked with the app's options. Two consequences worth
knowing:

- `apps/server/tsconfig.json` extends `tsconfig.base.json`, which enables
  `erasableSyntaxOnly`. This package's own tsconfig therefore enables it too: a
  constructor parameter property compiles under plain `tsc` here but is a hard
  `TS1294` error in the app. That is exactly how one slipped in once.
- The app's compiler is `tsc-rs` (the Effect language service), whose *style*
  diagnostics (`globalDate`, `globalTimers`, `nodeBuiltinImport`, …) are
  reported only for files that are roots of the program. This package's files
  are dependencies of `apps/server`, never roots, so its plain-Node idioms are
  not flagged — the same is true of the app's own code. The package is
  deliberately plain Node (a control-plane client, not an Effect service), so it
  typechecks with `tsc`, not `tsc-rs`.

Verification actually performed:

| check | result |
| --- | --- |
| `tsc -p packages/provider-daytona/tsconfig.json` | clean |
| `tsc -p packages/daytona/tsconfig.json --noEmit` | clean (57/57 control-plane tests) |
| `tsc-rs --noEmit` over the registration path (`builtInProviderAdapterDrivers.ts`) with the app's options | clean, 1.2 GB peak RSS |
| `tsc-rs --noEmit` over `apps/server/src` (tests/scripts excluded) with the app's options | **0 errors**, 3.3 GB peak RSS |
| `tsc-rs --noEmit -p apps/server/tsconfig.json` (the app's own script) | **not runnable here**: peak RSS 3.9 GB against a hard 4 GB cgroup with swap disabled, OOM-killed before it can report. Needs a machine with more memory. |
