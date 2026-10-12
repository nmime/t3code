# Wiring this into a T3 Code fork

The report's conclusion is that this system is an _extension_ to T3's
Orchestration V2, not a standalone replacement: conversation state, projections
and the event log stay on the VPS, while provider sessions, Git, checkpoints and
the repository move into the task sandbox.

This document maps every module here onto the T3 source it replaces or extends,
using the real paths from `pingdotgg/t3code` (main branch).

## 1. What stays exactly as it is

| T3 component                                                           | Why it stays                                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/server/src/orchestration-v2/EventStore.ts` + `EventSink.ts`      | Authoritative conversation state lives on the VPS, as this project's `EventStore` does for execution state. |
| `apps/server/src/orchestration-v2/EffectOutbox.ts` + `EffectWorker.ts` | The transactional outbox pattern is reused verbatim; execution adds effect kinds instead of a second queue. |
| `apps/server/src/orchestration-v2/CommandReceiptStore.ts`              | Command receipts already give idempotent client retries.                                                    |
| `packages/contracts` (chat, thread, projection schemas)                | Clients (Mac, mobile) must keep speaking the schemas they already speak.                                    |
| Approval / runtime-request projections                                 | The remote path re-emits the same `runtime_request.updated` shape.                                          |

## 2. Provider execution: `RemoteProviderAdapter`

T3 has **two** driver layers, and a remote provider needs both.

The runtime layer is the **provider instance** driver
(`packages/provider-core/src/server/driver.ts`, `ProviderDriver`). On boot,
`apps/server/src/provider/ProviderInstanceRegistryHydration.ts` hydrates
`ProviderInstanceRegistry` from `ServerSettings.providerInstances`, resolving
each entry's `driver` slug against **`apps/server/src/provider/builtInDrivers.ts`
(`BUILT_IN_DRIVERS`)**. Anything not in that array is not an error: it becomes an
_unavailable shadow_ snapshot, and no thread can route to it. A new provider is
therefore registered there, and the driver it names must return a whole
`ProviderInstance` — snapshot, continuation identity, text generation and
`orchestrationAdapter`.

The adapter layer is the **orchestration-v2** driver
(`packages/provider-core/src/server/adapterDriver.ts`,
`ProviderAdapterDriver`), which is what `ProviderAdapterRegistryV2` looks up by
`ProviderInstanceId` — through the instance the v1 driver produced, not through a
list. `apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts` collects
the v2 adapter drivers, but at the time of writing nothing in the runtime imports
it: its only consumer is `Adapters/AcpRegistryAdapterV2.test.ts`, which asserts
the ACP registry's kind is in the set. Registering a driver _only_ there leaves
the provider unusable in a running server. Put it in both: the v1 driver in
`builtInDrivers.ts` (what runs), the v2 adapter driver in
`builtInProviderAdapterDrivers.ts` (what the sibling packages do, and what the
replay tests build from).

`@t3tools/provider-daytona` follows exactly this split: `DaytonaDriver` (v1) in
`apps/server/src/provider/builtInDrivers.ts`, `DaytonaAdapterV2Driver` (v2) in
`builtInProviderAdapterDrivers.ts`, its settings form in
`apps/web/src/components/settings/providerDriverMeta.ts`, and its settings schema
shared by both halves through the package's `./settings` export.

The adapter itself implements the same operation set as `ProviderAdapterV2` in
`packages/provider-core/src/server/ProviderAdapter.ts`:

| T3 operation                    | Remote implementation                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `openSession`                   | `session.open` command to the task worker                                                 |
| `ensureThread` / `resumeThread` | `thread.ensure` / `thread.resume`                                                         |
| `startTurn`                     | `turn.start` (idempotent by `effectId`)                                                   |
| `interrupt` / `steerRun`        | `turn.interrupt` / `turn.steer`, gated on capability flags                                |
| `respondRuntimeRequest`         | `runtime_request.respond`                                                                 |
| `rollbackThread` / `forkThread` | `thread.rollback` / `thread.fork`, gated on capability flags                              |
| `events` stream                 | Worker events persisted by `WorkerConnectionRegistry`, replayed from the store, then live |

`capabilities()` comes from the worker's advertised inventory, so
`ProviderAdapterCapabilitiesError`-style mistakes (claiming steering for a CLI
agent that cannot steer) become `CapabilityUnsupportedError` at the call site —
see `tests/integration/lifecycle.test.ts`.

## 3. Orchestration: new effect kinds

`EffectWorker.ts` in this repository mirrors T3's effect worker. Register these
kinds alongside the existing `provider-turn.start`, `provider-turn.interrupt`,
`runtime-request.respond`, `provider-thread.rollback` and `checkpoint.capture`
effects:

| New effect                                                    | Work                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `task.provision`                                              | Resolve the pinned profile, create the sandbox, inject secrets, clone the repo, apply configuration sources, start the worker |
| `task.ensure_ready`                                           | Attach (or reattach) the worker before a turn starts                                                                          |
| `task.stop` / `task.resume` / `task.restore` / `task.destroy` | Lifecycle, with `resume` vs `restore` kept distinct                                                                           |
| `turn.start`                                                  | Ensure thread, mark running, start the turn with the effect id as idempotency key                                             |
| `checkpoint.capture` / `checkpoint.restore`                   | Route to the sandbox's hidden git refs                                                                                        |

`ProviderSessionManager` and `ProviderTurnStartService` in
`apps/server/src/orchestration-v2/` should call `SandboxControlPlane.ensureReady`
before starting a turn; everything else in those files keeps working because the
adapter is still a `ProviderAdapterV2`.

## 4. Git and checkpoints: the dangerous path

`apps/server/src/git/GitWorkflowService.ts` and
`apps/server/src/checkpointing/CheckpointStore.ts` currently take local working
directories. In the fork they must take a task id and route through
`RemoteWorkspaceService` (this repository), which:

- resolves the task's execution target,
- fails with `ExecutionTargetUnavailableError` when no worker is attached,
- never falls back to a VPS path.

That is what prevents the failure the report calls out: a correct remote
conversation next to diffs read from a different repository. Checkpoints keep
T3's model — hidden refs — but the refs are `refs/t3x/checkpoints/*` inside the
sandbox, captured through a temporary index so the agent's index is untouched.

## 5. Environment profiles and secrets

- `EnvironmentProfileService` replaces ad-hoc provider-instance settings with a
  versioned, layered profile. The resolved profile and its digest are pinned on
  the task (`TaskRecord.profileDigest`) and re-verified on recovery.
- `SecretsBroker` holds credential _values_; profiles hold references. A profile
  can only materialize what policy allows, and `redact()` scrubs values from
  anything that leaves the control plane.
- Provider-native logins (ChatGPT OAuth, Claude/Cursor interactive login) still
  need their own lifecycle — the report is explicit that header substitution
  does not cover body credentials or native login stores.

## 6. Clients

Nothing in the chat protocol changes. Additions for the GUI:

- `POST /tasks` (repository, profile, provider, overrides, **`scope`**,
  **`projectId`**) — `scope: "task"` is the "Run this task in a new sandbox"
  toggle
- `GET /tasks/:id` (binding, sandbox, worker, approvals, checkpoints, **scope,
  worktree, sharedWith**)
- `GET /tasks/:id/events?from=<seq>` (JSON) or `&stream=sse`
- `POST /tasks/:id/messages`, `POST /tasks/:id/approvals/:requestId`
- `POST /tasks/:id/stop|resume|destroy`, `POST /tasks/:id/checkpoints`
- `GET /tasks/:id/git/status`, `GET /tasks/:id/git/diff`
- `GET /projects`, `POST /projects` (`defaultScope`, `maxConcurrentTasks`)
- `GET /projects/:id/sandboxes`, `GET /sandboxes`
- `POST /sandboxes/:id/stop|destroy`

The sandbox controls are what a GUI needs to draw the execution settings page:
list the projects and their sandboxes, show which tasks share one, and offer
stop/destroy — with `sandbox.stop_refused` telling the client that a task is
still attached.

Stock mobile clients keep working for chat and approvals; the new management
surfaces (profiles, sandbox controls) live in the modified web/desktop frontend
until a custom mobile build ships, exactly as the report warns.

## 7. Sandbox scope: one sandbox per project, a worktree per task

T3 has no notion of an execution target, so the scope lives on our side and the
fork only has to pass it through. What changes in the fork:

- Task creation sends `scope` and `projectId` alongside the provider instance.
  The GUI toggle is the per-task `scope: "task"`; the default comes from the
  control plane, so a client that knows nothing about scope still works.
- The working directory of a turn is no longer a T3 concept: it is the task's
  worktree (`/workspace/worktrees/<taskId>`), and the control plane passes it to
  the provider runtime. Anything in the fork that assumed "the repository
  checkout" must ask `GET /tasks/:id` for `worktreePath` instead.
- `apps/server/src/git/*` and the checkpoint store keep going through
  `RemoteWorkspaceService`; they are now root-relative to that worktree, and the
  base checkout is never handed to a task.
- Threads are still T3's unit of conversation. They are deliberately _not_ the
  unit of isolation: many threads (and many tasks) can share one sandbox, and
  each still gets its own worktree.
- The frontend needs one new page for execution settings: the project list with
  `defaultScope` and `maxConcurrentTasks`, the sandboxes under each project,
  their state and how many tasks are bound, and the stop/destroy actions.

Two rules the fork must not break, because the control plane cannot enforce them
for a client that bypasses the API: never run a provider against the shared base
checkout, and never treat a worktree as a credential boundary.

## 8. Order of work (report §11)

1. Pin a T3 V2 commit; keep the V2 event schema.
2. Prove one remote worker: one sandbox, one non-Codex provider, real GUI
   events and approvals. `tests/integration/lifecycle.test.ts` is that proof.
3. Add persistent task control: bindings, lifecycle, reconciliation, resumable
   native sessions, remote filesystem/Git (`SandboxControlPlane`,
   `TaskRecoveryService`, `RemoteWorkspaceService`).
4. Add environment profiles, configuration sources, secret references and task
   overrides (`EnvironmentProfileService`, `ConfigBundleStore`, `SecretsBroker`).
5. Expand providers: Codex, Claude, OpenCode/OmniRoute, Pi through the same
   bridge (`ProviderRuntimeHost`).
6. Validate the Mac-to-phone workflow, permissions, security and recovery
   (`tests/integration/recovery.test.ts`, `isolation.test.ts`).
7. Add sandbox scope: project sandboxes with a worktree per task, the per-task
   toggle, compatibility gating and a reference-counted lifecycle
   (`tests/integration/sandboxScope.test.ts`).
