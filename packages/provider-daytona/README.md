# @t3tools/provider-daytona

Run a thread's agent inside a **Daytona task sandbox** instead of on the machine
running the T3 server.

This package is the T3 side of that arrangement: a provider _driver_
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

| T3                       | Daytona                                                       |
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

The sandbox side lives in [`@t3tools/daytona`](../daytona). Build it, define an
environment profile, and serve:

```bash
pnpm --filter @t3tools/daytona build
node packages/daytona/dist/src/cli.js import-config --home ~ --name mac-config-v1
node packages/daytona/dist/src/cli.js serve --state-dir ~/.t3-daytona --port 8087
```

Set `DAYTONA_API_KEY` on the control plane to provision real Daytona sandboxes;
without it the local backend uses directories, which is what the tests do. Check
it with `curl -s localhost:8087/health` and `curl -s localhost:8087/profiles`.
Give the control plane an `--api-token` if it is reachable from anywhere but
localhost, and pass the same token to the instance below.

### 2. Confirm the driver is registered

`apps/server/src/provider/builtInDrivers.ts` lists `DaytonaDriver` in
`BUILT_IN_DRIVERS`. That array is what `ProviderInstanceRegistry` resolves
`ServerSettings.providerInstances` against, so it — not
`orchestration-v2/builtInProviderAdapterDrivers.ts`, which nothing in the runtime
reads — is what makes `"driver": "daytona"` a live provider instead of an
_unavailable shadow_ snapshot in Settings.

### 3. Add an instance

**Settings → Providers → Add provider → Daytona.** The form is the schema in
`src/settings.ts`; every field is documented there. It writes one entry into the
server settings' `providerInstances` map:

```jsonc
{
  "providerInstances": {
    "daytona_backend": {
      "driver": "daytona",
      "displayName": "Daytona (backend)",
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

`hasDefaultInstance` is `false`, so no instance is auto-created — a Daytona
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

## What is not supported (yet)

- **Forking** a thread. `canForkThread` is false and `forkThread` fails with
  `ProviderAdapterForkThreadError`. The control plane has the pieces (a task can
  be created in the same project, and the worker can fork a native thread), but
  the cross-task thread plumbing is not wired.
- **Tool items, plans and subagents.** The control plane's normalized protocol
  carries messages, turns and runtime requests; T3's tool/plan/subagent events
  are reported as unsupported rather than faked.
- **Application text generation.** Commit messages, PR bodies, branch names,
  thread titles and review guides are not generated: they would have to come
  from a model inside the sandbox, and this integration does not run one for
  that. T3 is told the operation is unsupported, so it falls back rather than
  waiting on a model that will never answer.
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
| `tsc -p packages/provider-daytona/tsconfig.json`                                                         | clean                                                                                                                                                    |
| `tsc -p packages/daytona/tsconfig.json --noEmit`                                                         | clean (57/57 control-plane tests)                                                                                                                        |
| `tsc-rs --noEmit` over the registration path (`builtInProviderAdapterDrivers.ts`) with the app's options | clean, 1.2 GB peak RSS                                                                                                                                   |
| `tsc-rs --noEmit` over `apps/server/src` (tests/scripts excluded) with the app's options                 | **0 errors**, 3.1 GB peak RSS                                                                                                                            |
| `tsc-rs --noEmit` over the web settings entry (`providerDriverMeta.ts`) with the app's options           | clean                                                                                                                                                    |
| `tsc-rs --noEmit -p apps/server/tsconfig.json` (the app's own script)                                    | **not runnable here**: peak RSS 3.9 GB against a hard 4 GB cgroup with swap disabled, OOM-killed before it can report. Needs a machine with more memory. |
