# Operating the control plane

## On the VPS

The control plane ships inside the T3 fork as the `@t3tools/daytona` workspace
package, so the checkout is the fork itself:

```bash
git clone https://github.com/nmime/t3code && cd t3code
git checkout feat/daytona-sandboxes
npx --yes pnpm@11.10.0 install --ignore-scripts --prefer-offline
pnpm --filter @t3tools/daytona build

# credentials stay on the VPS: they are never written into a sandbox
export OPENSANDBOX_API_URL=https://sandbox.example.com   # opensandbox-server
export OPENSANDBOX_API_KEY=...
export OPENSANDBOX_IMAGE=t3x-sandbox:latest
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

## The sandbox provider (OpenSandbox)

The control plane never talks to Docker itself: it talks to an OpenSandbox
lifecycle server over HTTP, and that server runs the sandbox containers.

```bash
# 1. pack the worker so a sandbox can run it
node dist/src/cli.js worker bundle --out /var/lib/t3x/worker.tgz

# 2. run the control plane with a dialable address and that bundle
node dist/src/cli.js serve --state-dir /var/lib/t3x --port 8087 \
  --worker-url https://control-plane.example.com \
  --worker-bundle /var/lib/t3x/worker.tgz
```

`serve --backend auto` (the default) uses OpenSandbox when
`OPENSANDBOX_API_URL` or `OPENSANDBOX_API_KEY` is set, and the local directory
backend otherwise; `--backend local|opensandbox` forces one. `t3x doctor` says
which one a host picks, and whether the server answered.

### Installing the sandbox server

`deploy/t3x-bootstrap.sh` does this, and it is what the reference deployment
runs. By hand, on the host that will run sandboxes:

```bash
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
uv venv --python 3.12 /opt/opensandbox/venv
uv pip install --python /opt/opensandbox/venv/bin/python opensandbox-server==1.1.1
docker pull opensandbox/execd:release-1.1.1
docker build -t t3x-sandbox:latest packages/daytona/deploy/sandbox-image
```

`/etc/opensandbox/sandbox.toml` holds the server's own configuration
(`[server] api_key`, `eip`, `[runtime] execd_image`, `[docker] publish_host`),
`deploy/t3x-bootstrap.sh` writes it, and `docs/setup.md` §2 explains every key
that matters. The service is `opensandbox.service`, user `osb`, in the `docker`
group, state under `/var/lib/opensandbox`:

```bash
systemctl status opensandbox | journalctl -u opensandbox -f
curl -s http://127.0.0.1:8080/health
curl -s -H "OPEN-SANDBOX-API-KEY: $OPENSANDBOX_API_KEY" \
  "$OPENSANDBOX_API_URL/v1/sandboxes?pageSize=50"
```

Deleting a sandbox through the API deletes its container; nothing else in the
lifecycle is manual. The sandbox image is rebuilt with `docker build` — a task
sees the new image from its next sandbox, and existing sandboxes keep the one
they were created from.

Three requirements that fail silently when missed:

| Requirement             | Why                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--worker-url`          | sandboxes dial _out_, so this must be an address reachable from inside a sandbox — not `127.0.0.1`                 |
| `--worker-bundle`       | a sandbox cannot see the control plane's filesystem; the worker is uploaded and unpacked into `<home>/.t3x-worker` |
| a writable profile path | `project.workingDirectory` must be writable by the sandbox user (`/workspace` is read-only on some images)         |

Rules the backend enforces:

- the sandbox server's API key never enters a sandbox or an agent process;
- `inject: env` secrets are set as sandbox environment variables at creation;
  `inject: headers` secrets are refused (`sandbox_backend_unsupported`), because
  this backend has no outbound substitution layer — declaring one is an error,
  not a silent no-op;
- neither can be attached to an existing sandbox, and that is refused rather
  than ignored;
- preview links are port-scoped, need no token and do not expire: the sandbox's
  ports stay bound to loopback and the only way in is the server's proxy path;
- the sandbox's own timeout is set from the profile, but the orchestrator never
  relies on infrastructure idleness to decide a task finished.

### Verifying a sandbox host

```bash
node dist/src/cli.js doctor                      # node, worker entry, endpoint, key, image, reachability
node dist/src/cli.js doctor --opensandbox-url https://sandbox.example.com
OPENSANDBOX_API_URL=https://sandbox.example.com OPENSANDBOX_API_KEY=... \
  node --test packages/daytona/dist/tests/integration/openSandboxReal.test.js
```

`doctor` probes the server and exits non-zero on any failed check, which is what
tells "the URL is wrong" apart from "the key is wrong" before a task is ever
created.

The real-API suite creates sandboxes and deletes them again, through the same
backend the control plane uses.

Egress is the one environmental limit worth knowing before blaming the code, and
it is why this deployment self-hosts: a sandbox has to be able to dial the
control plane. With the sandbox server on the same host that is an ordinary
outbound HTTPS request, and nothing filters it. A hosted provider with a
tier-based firewall (Daytona's Tier 1/2, which restricts a sandbox's outbound
traffic to package registries and the provider's own API and cannot be
overridden at the sandbox level) produces `task.worker_attach_failed` after the
worker starts, with the socket reset — a policy, not a bug in this code.

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
