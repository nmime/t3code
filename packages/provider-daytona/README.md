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
