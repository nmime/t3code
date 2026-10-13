# Setup: from zero to a thread running in a sandbox

This is the ordered walkthrough — every command, in the order it has to run,
with the check that tells you it worked. It covers the managed Daytona cloud and
a self-hosted Daytona; the only difference is two environment variables.

The pieces:

| Piece              | Where it runs                    | What it is                                                      |
| ------------------ | -------------------------------- | --------------------------------------------------------------- |
| control plane      | a host sandboxes can reach (VPS) | `@t3tools/daytona` — tasks, sandboxes, worktrees, the event log |
| worker             | inside each task sandbox         | runs the agent next to the checkout and dials the control plane |
| provider driver    | inside T3 (`apps/server`)        | `@t3tools/provider-daytona` — turns a T3 thread into a task     |
| Daytona deployment | managed cloud or your own host   | provisions the sandboxes                                        |

---

## 0. Prerequisites

- **Node ≥ 22** on the control-plane host and on the machine running T3.
- **git** inside the sandboxes (checkpoints are git-based).
- A **Daytona deployment and an API key**:
  - managed cloud: create a key in your Daytona organization;
  - self-hosted: run the Daytona Docker Compose or Helm install, then create an
    API key in that deployment's dashboard. The API root is usually
    `https://<your-host>/api`.
- A **host the sandboxes can reach** for the control plane. Sandboxes dial
  _out_, so this needs an address reachable from inside a sandbox — a VPS with a
  public name, or anything on the same network as a self-hosted Daytona.

> Restricted-egress tiers (some managed organizations) let a sandbox reach
> package registries and Daytona's own API and nothing else. On such a tier a
> worker cannot dial a control plane hosted anywhere else and the run ends with
> `task.worker_attach_failed`. Use a host the sandbox can reach, or lift the
> restriction. This is the one leg that is environmental rather than code.

---

## 1. Get the code and build the control plane

```bash
git clone https://github.com/nmime/t3code
cd t3code
git checkout feat/daytona-sandboxes

npx --yes pnpm@11.10.0 install --ignore-scripts --child-concurrency=1 --prefer-offline
pnpm --filter @t3tools/daytona build
```

The Daytona SDK is loaded dynamically, so install it where the control plane
runs:

```bash
npm install @daytonaio/sdk        # the real package name; @daytona-io/sdk does not exist
```

## 2. Point it at a Daytona deployment

Managed cloud — nothing to set beyond the key:

```bash
export DAYTONA_API_KEY=...
```

Self-hosted — same SDK, another API root:

```bash
export DAYTONA_API_URL=https://daytona.example.com/api
export DAYTONA_API_KEY=<a key created in that deployment>
export DAYTONA_TARGET=<region>            # optional
export T3X_DAYTONA_DEFAULT_IMAGE=daytonaio/sandbox:0.9.0   # optional; see below
```

`--daytona-api-url`, `--daytona-target` and `--daytona-default-image` override
the last three for one `serve` run.

**Check it now, before anything else:**

```bash
node packages/daytona/dist/src/cli.js doctor
```

`doctor` prints one line per check and exits non-zero when one fails:

- `daytona sdk` — the package resolves;
- `daytona api url` — the endpoint `serve` would use (yours, or the cloud
  default);
- `daytona api key` — a key is present;
- `daytona reachable` — the deployment actually answered (only when a key is
  set), because "wrong URL" and "wrong key" are otherwise indistinguishable.

## 3. Define an environment profile

A profile is what every sandbox in a project is built from. Write
`profile.yaml`:

```yaml
apiVersion: t3-daytona/v1
kind: EnvironmentProfile
metadata: { name: typescript-backend, version: 1 }
runtime:
  snapshot: daytona-medium # a snapshot your deployment has; omit to use an image
  # resources only apply when no snapshot is named:
  # resources: { cpu: 2, memoryGiB: 4, diskGiB: 8 }
project:
  workingDirectory: /home/daytona/project # must be writable by the sandbox user
  setup:
    - "npm ci --ignore-scripts"
  allowedRepositories: ["github.com/your-org/*"]
environment:
  CI: "true"
agents:
  allowed: [codex, claude, opencode, pi, echo]
  defaults: { provider: codex }
  maxRuntimeMode: auto-accept-edits # the strongest mode a turn may ask for
```

```bash
node packages/daytona/dist/src/cli.js profile add --id typescript-backend --file profile.yaml
node packages/daytona/dist/src/cli.js profile resolve --id typescript-backend
```

Two rules that fail quietly when missed: `project.workingDirectory` must be
writable by the sandbox user (`/workspace` is read-only on some images), and a
snapshot fixes cpu/memory/disk, so `runtime.resources` only apply when the
profile names no snapshot.

## 4. Pack the worker and serve

A sandbox cannot see the control plane's filesystem, so the worker travels as
one archive:

```bash
node packages/daytona/dist/src/cli.js worker bundle --out /var/lib/t3x/worker.tgz

node packages/daytona/dist/src/cli.js serve \
  --state-dir /var/lib/t3x --port 8087 \
  --api-token "$(openssl rand -hex 24)" \
  --worker-url https://t3x.example.com \
  --worker-bundle /var/lib/t3x/worker.tgz
```

- `--worker-url` is the address a **sandbox** dials. `127.0.0.1` is only right
  when the worker runs on the control-plane host. Put TLS in front of it (a
  reverse proxy is enough); the control plane needs no inbound port of its own.
- `--api-token` is required if the control plane is reachable from anywhere but
  localhost; pass the same token to T3 in step 5.
- `--backend auto` (the default) picks Daytona when a key is set, the local
  directory backend otherwise. `--backend local|daytona` forces one. The banner
  prints which, and the endpoint and target it resolved.

```bash
curl -s localhost:8087/health
curl -s -H "authorization: Bearer $TOKEN" localhost:8087/profiles
```

## 5. Point T3 at the control plane

In the T3 app: **Settings → Providers → Add provider → Daytona**, or one entry
in the server settings' `providerInstances` map:

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
        "profileId": "typescript-backend",
        "repositoryUrl": "github.com/your-org/backend", // omit for a scratch workspace
        "branch": "main",
        "sandboxScope": "project", // or "task": one sandbox per thread
        "agent": "codex",
        "model": "default",
      },
    },
  },
}
```

The instance's status line is the control plane's health as the driver probed
it, and it says **which** failure it was: unreachable, token refused, or no such
environment profile. `hasDefaultInstance` is `false`, so nothing is created
until you add one — a Daytona provider with no URL means nothing.

## 6. Run a thread

Pick the instance in the composer (or set it as the project's default provider)
and send a message. What happens, in order:

1. T3 opens a provider session and sends the turn;
2. the adapter asks the control plane for the task — creating it, or reusing the
   project's sandbox, on its own worktree and branch;
3. the control plane provisions the sandbox, uploads and unpacks the worker,
   starts it, and the worker dials `--worker-url` and attaches;
4. the agent runs in the task's worktree; events stream back through T3's
   ingestor into the thread's projection;
5. approvals, interrupts, steering, checkpoints and rollback all go through the
   same route.

Watch it from the control plane:

```bash
node packages/daytona/dist/src/cli.js task list
node packages/daytona/dist/src/cli.js task status <taskId>   # scope, project, worktree, sandbox
node packages/daytona/dist/src/cli.js task git <taskId>      # per-worktree git state
```

### Sandbox scope

Default is **one shared sandbox per project/repository with one git worktree per
task** — dependencies, caches and dev services are shared, working directories
are not. The per-task toggle (`--scope task`, or `sandboxScope: "task"` in the
instance) gives a thread a dedicated sandbox. Resolution order: task request →
project default → global default. The lifecycle is reference-counted, and
reuse is gated on a compatibility key (repository, profile, snapshot, credential
domain), so an incompatible task never lands in someone else's sandbox.

## 7. Verify, in this order

```bash
# 1. configuration and reachability
node packages/daytona/dist/src/cli.js doctor

# 2. the configured endpoint is the one the SDK calls (self-hosted check, no key)
node --test packages/daytona/dist/tests/integration/selfHosted.test.js

# 3. real API, real sandboxes (creates and deletes them)
DAYTONA_API_KEY=... node --test packages/daytona/dist/tests/integration/daytonaReal.test.js

# 4. control plane + worker end to end inside one real sandbox (43 checks)
DAYTONA_API_KEY=... node packages/daytona/scripts/sandbox-smoke/run.mjs
#    T3X_SMOKE_KEEP=1 leaves the sandbox behind

# 5. T3's own orchestration, ingestor and projection over the adapter
pnpm --filter @t3tools/daytona build
node_modules/.bin/vp test run apps/server/src/orchestration-v2/Adapters/DaytonaAdapterV2.e2e.test.ts --no-file-parallelism
```

Test 5 is the one that proves what the UI shows: a real `thread.create` and
`message.dispatch` through T3's orchestrator, session manager, turn-start
service, run execution and event ingestor, over the real driver and adapter,
against a real control plane and a real worker — asserting the reply in T3's own
projection.

## 8. When it does not work

| Symptom                                               | Cause                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `task.worker_attach_failed`                           | the sandbox cannot reach `--worker-url` (restricted egress, wrong address, no TLS) |
| task stuck `provisioning`                             | the snapshot does not exist, or the deployment refused the create (quota)          |
| agent runs in the wrong place / `mkdir` fails         | `project.workingDirectory` is not writable by the sandbox user                     |
| no such environment profile                           | the profile was never added, or the instance names another id                      |
| token refused                                         | `--api-token` on the control plane and `apiToken` in the instance differ           |
| reply never appears although the sandbox ran the turn | T3 dropped the events — check `apps/server`'s logs for a decode error              |
| "Total memory limit exceeded"                         | the organization's sandbox quota; destroy old sandboxes                            |

`t3x sandbox list` shows what is alive; `t3x sandbox destroy <id>` removes one.
Every error the HTTP API returns now carries the status that matches its cause
(404 missing, 409 conflict/refusal, 401 unauthorized, 403 policy, 422
unsupported, 503 no worker), so a client can tell them apart.
