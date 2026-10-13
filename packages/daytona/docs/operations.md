# Operating the control plane

## On the VPS

The control plane ships inside the T3 fork as the `@t3tools/daytona` workspace
package, so the checkout is the fork itself:

```bash
git clone https://github.com/nmime/t3code && cd t3code
git checkout feat/daytona-sandboxes
npx --yes pnpm@11.10.0 install --ignore-scripts --prefer-offline
pnpm --filter @t3tools/daytona build
npm install @daytonaio/sdk        # the Daytona backend, optional but required for real sandboxes

# credentials stay on the VPS: they are never written into a sandbox
export DAYTONA_API_KEY=...
export T3X_API_TOKEN=$(openssl rand -hex 32)   # bearer token for clients

node packages/daytona/dist/src/cli.js worker bundle --out /var/lib/t3x/worker.tgz
node packages/daytona/dist/src/cli.js serve --state-dir /var/lib/t3x --port 8087 \
  --worker-url https://control-plane.example.com \
  --worker-bundle /var/lib/t3x/worker.tgz
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
npm install @daytonaio/sdk        # the real package name; @daytona-io/sdk does not exist
export DAYTONA_API_KEY=...

# 1. pack the worker so a sandbox can run it
node dist/src/cli.js worker bundle --out /var/lib/t3x/worker.tgz

# 2. run the control plane with a dialable address and that bundle
node dist/src/cli.js serve --state-dir /var/lib/t3x --port 8087 \
  --worker-url https://control-plane.example.com \
  --worker-bundle /var/lib/t3x/worker.tgz
```

`serve --backend auto` (the default) uses Daytona when `DAYTONA_API_KEY` is set
and `@daytonaio/sdk` resolves, and the local directory backend otherwise;
`--backend local|daytona` forces one. `t3x doctor` says which one a host picks.
Snapshots named by `runtime.snapshot` in a profile must exist in the Daytona
organization before tasks are created; creating from a snapshot ignores the
profile's `runtime.resources`, because the snapshot fixes them.

Three requirements that fail silently when missed:

| Requirement             | Why                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--worker-url`          | sandboxes dial _out_, so this must be an address reachable from inside a sandbox — not `127.0.0.1`                 |
| `--worker-bundle`       | a sandbox cannot see the control plane's filesystem; the worker is uploaded and unpacked into `<home>/.t3x-worker` |
| a writable profile path | `project.workingDirectory` must be writable by the sandbox user (`/workspace` is read-only on some images)         |

Rules the backend enforces:

- the organization API key never enters a sandbox or an agent process;
- `inject: env` secrets are set at creation (`envVars`), `inject: headers`
  secrets require a `hostAllowlist` and are mounted as organization secrets so
  the value is substituted on outbound requests instead of living in the
  sandbox; neither can be attached to an existing sandbox, and that is refused
  rather than ignored;
- preview links are port-scoped and token-scoped (`getPreviewLink`); pass the
  token as `X-Daytona-Preview-Token` when the sandbox is private;
- `autoStopInterval` is set from the profile, but the orchestrator never relies
  on infrastructure idleness to decide a task finished.

### Verifying a Daytona host

```bash
node dist/src/cli.js doctor                      # node, worker entry, SDK, API key
DAYTONA_API_KEY=... node --test packages/daytona/dist/tests/integration/daytonaReal.test.js
```

The real-API suite creates sandboxes and deletes them again; set
`T3X_DAYTONA_TEST_SNAPSHOT` to a snapshot your organization actually has.

One environmental limit is worth knowing before blaming the code: **restricted
egress tiers**. A sandbox on such a tier can reach package registries and
Daytona's own API and nothing else, so a worker inside it cannot dial a control
plane hosted anywhere else (the failure shows up as `task.worker_attach_failed`
after the worker starts and its socket is reset). Run the control plane on a
host the sandbox can reach, or lift the tier's network restrictions.

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

`stop` answers `409 sandbox_stop_refused` (and emits the event of the same name)
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

| Symptom                             | Cause                                                                                                                    | Fix                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `execution_target_unavailable`      | no worker attached                                                                                                       | `task resume`, or let `reconcile` reattach                                   |
| `unauthorized` on the worker socket | token used twice, expired, or for another task                                                                           | reattach the worker; tokens are single-use and rotated on each connect       |
| `lease_fenced` in worker logs       | a replacement worker took the task                                                                                       | expected: the stale worker exits                                             |
| `capability_unsupported` (422)      | the provider cannot do that (steer/rollback/fork)                                                                        | check `GET /tasks/:id` → `worker.providers[].capabilities`                   |
| `sandbox_stop_refused` (409)        | tasks are still bound to the sandbox                                                                                     | stop the tasks first; the sandbox stops itself when the last one leaves      |
| `task.worker_attach_failed`         | the worker started but could not reach the control plane                                                                 | check `--worker-url` is reachable from a sandbox and the tier's egress rules |
| HTTP statuses                       | `404` missing, `409` conflict/refusal, `401`/`403` credentials and policy, `422` unsupported capability, `503` no worker | branch on the status; the body always carries the same `code`                |
| turn stuck in `running`             | provider died mid-turn                                                                                                   | `turn.start` failure releases the task to `ready` after retries              |
| `profile_invalid`                   | YAML fails schema validation                                                                                             | the error lists the offending paths                                          |
