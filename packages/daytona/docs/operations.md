# Operating the control plane

## On the VPS

```bash
git clone https://github.com/nmime/t3-daytona && cd t3-daytona
npm ci && npm run build

# credentials stay on the VPS: they are never written into a sandbox
export DAYTONA_API_KEY=...
export T3X_API_TOKEN=$(openssl rand -hex 32)   # bearer token for clients

node dist/src/cli.js serve --state-dir /var/lib/t3x --port 8087
```

Systemd unit: `deploy/t3x-control-plane.service`.

State lives in one directory:

```
/var/lib/t3x/
  control-plane.sqlite   tasks, events, effects, approvals, profiles, tokens
  secret.key             AES-256-GCM key for the secrets broker (0600)
  config-bundles/*.json  imported agent configuration
  sandboxes/<id>/        local backend sandboxes (dev/test)
```

Back up `control-plane.sqlite` and `secret.key` together: without the key the
stored credentials cannot be decrypted.

## Daytona

```bash
npm install @daytona-io/sdk
export DAYTONA_API_KEY=...
```

`DaytonaBackend` is selected automatically for tasks whose binding has a
sandbox when the control plane is started with that backend; with the SDK absent
the local backend is used and the sandbox is a directory tree under
`--state-dir`. Snapshots named by `runtime.snapshot` in a profile must exist in
the Daytona organization before tasks are created.

Rules the backend enforces:

- the organization API key never enters a sandbox or an agent process;
- preview URLs are port-scoped and expiring (a sandbox-wide preview token would
  also expose control ports);
- `autoStopInterval` is set from the profile, but the orchestrator never relies
  on infrastructure idleness to decide a task finished.

## Credentials

```bash
# store a value centrally; profiles reference it by name
node -e '
const {EventStore}=await import("./dist/src/execution/EventStore.js");
const {SecretsBroker}=await import("./dist/src/execution/SecretsBroker.js");
const store=new EventStore("/var/lib/t3x/control-plane.sqlite");
new SecretsBroker(store,"/var/lib/t3x/secret.key").put("NPM_TOKEN", process.env.NPM_TOKEN, {allowedProfiles:["typescript-backend"]});
' --input-type=module
```

Then in a profile:

```yaml
secrets:
  - name: NPM_TOKEN
    secretRef: NPM_TOKEN
    inject: env
```

## Watching a task

```bash
node dist/src/cli.js task status <taskId>            # binding, worker, approvals, effects
node dist/src/cli.js task git <taskId>               # status + checkpoint refs
curl -N -H "Authorization: Bearer $T3X_API_TOKEN" \
  "http://127.0.0.1:8087/tasks/<taskId>/events?from=0&stream=sse"
```

`GET /tasks/:id/events?from=<seq>` is the multi-device primitive: a phone that
has been offline replays from its last sequence number and never sees a gap.

## Recovery

`serve` runs `recover()` at boot and `sweep()` every minute:

- stuck effects are requeued;
- workers are reattached, or a fresh worker is started for a surviving sandbox;
- tasks whose sandbox disappeared are _restored_ from the pinned profile and
  marked `resumeKind: "restored"` — never claimed as a seamless resume;
- idle tasks are stopped, over-budget tasks are stopped, completed tasks are
  destroyed after their retention window;
- project sandboxes with no task bound to them are stopped once idle and
  destroyed after retention; a project sandbox with tasks still bound is never
  stopped, whatever the clock says;
- orphan sandboxes (no task owns them) are destroyed.

Run it manually with `node dist/src/cli.js reconcile`.

## Sandbox scope and lifecycle

`Settings → Execution → Default sandbox scope` (`--default-scope` on `serve`, or
`sandbox.isolation: per-task` in the profile; `POST /projects` for a project
override) decides where a new task runs:

| Scope               | What it means                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `project` (default) | one sandbox per repository, shared by its tasks; each task gets its own git worktree at `/workspace/worktrees/<taskId>` |
| `task`              | a sandbox of its own, created for the task and destroyed with it                                                        |

Resolution is task request → project default → global default, computed once at
creation and stored on the task (`sandboxScope`, `projectId`, `worktreePath`,
`worktreeBranch`). Changing a default never migrates a task that already exists.

Reuse is gated on compatibility (`sandboxCompatibilityKey`): repository, resolved
profile and digest (snapshot, OS, resources), security policy and credential
trust level. Incompatible tasks never share — the project simply gets a second
sandbox, one per environment. A task with no repository always gets its own
sandbox, and so does a task that would exceed the project sandbox's
`maxConcurrentTasks`.

Lifecycle is reference counted; the control plane is the only thing that stops a
sandbox, and stopping retains files:

```bash
node dist/src/cli.js sandbox list                       # state, tasks bound, last use
node dist/src/cli.js sandbox stop <sandboxId>           # refuses while tasks are bound
node dist/src/cli.js sandbox destroy <sandboxId>        # deletes checkout + worktrees
node dist/src/cli.js project list
node dist/src/cli.js project sandboxes <projectId>
```

`stop` answers `sandbox.stop_refused` (and emits the event of the same name)
while any task is attached; that is deliberate — a task with an approval pending
or a dev server running must not lose its files mid-flight. When the last task
leaves, a project sandbox is stopped, not deleted: `resume` brings the worker
back over the same checkout and worktrees, and retention destroys it later.

## Cost controls

| Policy                          | Default                                             | Where                            |
| ------------------------------- | --------------------------------------------------- | -------------------------------- |
| Stop after idle                 | 30 min (min of policy and profile)                  | `PolicyEngine`                   |
| Stop a project sandbox          | only at refcount 0 **and** idle                     | `PolicyEngine.evaluateSandboxes` |
| Tasks per project sandbox       | 4 (project and profile limit, whichever is tighter) | `sandbox.maxConcurrentTasks`     |
| Delete completed sandboxes      | 48 h                                                | `PolicyEngine`                   |
| Never auto-stop while executing | always                                              | `PolicyEngine`                   |
| Per-task budget                 | unset                                               | `TaskRecord.budgetCents`         |

## Troubleshooting

| Symptom                             | Cause                                             | Fix                                                                    |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `execution_target_unavailable`      | no worker attached                                | `task resume`, or let `reconcile` reattach                             |
| `unauthorized` on the worker socket | token used twice, expired, or for another task    | reattach the worker; tokens are single-use and rotated on each connect |
| `lease_fenced` in worker logs       | a replacement worker took the task                | expected: the stale worker exits                                       |
| `capability_unsupported`            | the provider cannot do that (steer/rollback/fork) | check `GET /tasks/:id` → `worker.providers[].capabilities`             |
| turn stuck in `running`             | provider died mid-turn                            | `turn.start` failure releases the task to `ready` after retries        |
| `profile_invalid`                   | YAML fails schema validation                      | the error lists the offending paths                                    |
