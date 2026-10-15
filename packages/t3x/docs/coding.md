# Coding tasks, end to end

Everything needed to go from a fresh VPS to a thread that edits files in a
sandbox, and to keep it running afterwards. It is written against the deployment
in this repository (`t3x` control plane + OpenSandbox lifecycle server + the T3
Code app on one host), but nothing here is host-specific except the paths.

Read [setup.md](./setup.md) for the long form of the install and
[operations.md](./operations.md) for day-two work; this file is the shortest
path to a working coding task, plus the traps that cost the most time.

---

## 1. What runs where

```
  T3 Code app  ──provider instance──▶  t3x control plane  ──▶  sandbox (Docker)
  (t3app.service)                       (t3x.service)           one per task
   thread, composer,                    tasks, profiles,        agent CLI
   transcript, diffs                    secrets, worktrees      (codex/openclaw)
```

- The **app** is the UI and the orchestration. A thread is bound to a provider
  _instance_; a message on that thread becomes a task on the control plane.
- The **control plane** owns tasks, sandboxes, environment profiles, secret
  materialization, checkpoints and the git worktree a task works in. It has no
  UI. It talks to the app over HTTP and to the sandbox over a WebSocket.
- The **sandbox** is a throwaway container from one image. The agent CLI, the
  repository and the worktree live there and nowhere else; the app's own copy of
  the project is not what the agent edits.
- The **agent** is whatever the profile and the instance name: `codex` (default),
  `openclaw`, `claude`, `opencode`, `pi`, or `echo` (a stub that echoes the
  prompt — useful to prove the plumbing without a model).

## 2. Install

On a fresh Ubuntu host with Docker and Python ≥ 3.10 already present:

```bash
curl -fsSL https://raw.githubusercontent.com/nmime/t3code/feat/opensandbox/packages/t3x/deploy/t3x-bootstrap.sh -o t3x-bootstrap.sh
MODEL_GATEWAY_URL=https://your-gateway.example.com/v1 \
DOMAIN=t3x.example.com \
  ./t3x-bootstrap.sh
```

It installs the sandbox lifecycle server, builds the sandbox image, creates the
`t3x` user and service, writes `/etc/t3x/env`, packs the worker bundle, writes an
environment profile, and — when `MODEL_GATEWAY_URL` is set — writes the setup
step that configures the agents and a `secrets:` entry for the key. It never
overwrites an existing web server on :80/:443.

Then install the model key and start the app (see
[host-t3-app.sh](../deploy/host-t3-app.sh) for the app half):

```bash
# Store the gateway key once. It is encrypted at rest and injected into a task
# as OPENAI_API_KEY — it never appears in a profile, a task request or a file.
t3x secret put MODEL_GATEWAY_API_KEY --value sk-… --profiles default --state-dir /var/lib/t3x

t3x secret list --state-dir /var/lib/t3x
```

## 3. The model gateway

The agents do not talk to a model vendor directly; they talk to one
OpenAI-compatible endpoint, and the profile writes that endpoint into the
workspace before the first turn:

| agent      | how it is configured                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `codex`    | `.codex/config.toml` (`model_provider`, `base_url`, `env_key`, `wire_api = "responses"`)   |
| `openclaw` | `.openclaw/openclaw.json5` (`models.providers.<id>.baseUrl`, `apiKey: {source: "env", …}`) |
| `claude`   | `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` in the sandbox environment                      |
| `echo`     | nothing                                                                                    |

A profile's `project.setup` is a list of shell commands run in the task's
working directory before the agent starts, with the profile's secrets already in
the environment. [`deploy/profiles/default.json`](../deploy/profiles/default.json)
is a working example: it writes both configs and references
`OPENAI_API_KEY ← MODEL_GATEWAY_API_KEY`.

Apply a profile (the file may be JSON or YAML):

```bash
t3x profile add --id default --file deploy/profiles/default.json --state-dir /var/lib/t3x
t3x profile list --state-dir /var/lib/t3x      # shows every stored version + digest
```

A profile is **immutable and versioned**: `profile add` stores a new version and
every task records the digest it ran with, so an old task can always be
explained. Editing the file and re-adding is the whole update procedure; a task
picks up the new version when its sandbox is next created.

### The profile, field by field

```yaml
apiVersion: t3x/v1
kind: EnvironmentProfile
metadata: { name: default, version: 4 }
runtime:
  resources: { cpu: 2, memoryGiB: 4, diskGiB: 10 } # or `snapshot: <id>`
project:
  workingDirectory: /workspace/project # where the agent runs
  setup: ["…"] # runs before the first turn
secrets:
  - { name: OPENAI_API_KEY, secretRef: MODEL_GATEWAY_API_KEY, inject: env }
agents:
  allowed: [echo, codex, openclaw, claude, opencode] # a task may only name these
  defaults: { provider: codex, permissionMode: auto }
  maxRuntimeMode: full-access # the ceiling, not the default
sandbox:
  isolation: per-project # or per-task
  maxConcurrentTasks: 4
  stopAfterIdleMinutes: 30
  deleteAfterCompletedHours: 48
```

## 4. Pick an agent

Two places decide, and the task request wins:

1. **The profile** — `agents.defaults.provider`, and `agents.allowed`, which is
   the allow-list the control plane enforces (a task naming anything else is
   refused, loudly).
2. **The provider instance** in the app — Settings → Providers → _Open Sandbox_ →
   **Agent**. This is what a thread created in the UI gets, because the app sends
   it as the task's `provider`.

So a deployment that wants OpenClaw by default sets the instance's Agent to
`openclaw`; one that wants codex leaves it as `codex`. Both live in the same
image, and per-task choice is available through the API and the CLI
(`"provider": "openclaw"`).

### OpenClaw

`openclaw agent exec` is OpenClaw's one-shot headless turn — no Gateway, no
session, no channels — which is the same shape as `codex exec`. The worker runs:

```
openclaw agent exec --config "$CWD/.openclaw/openclaw.json5" \
                    --model omniroute/auto/best-coding "$PROMPT"
```

- `--config` pins the run to the file the profile wrote; the ambient config is
  ignored. `--auth-env-only` **cannot** be combined with `--config`, which is why
  the config names its credential as an env reference
  (`apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`) rather
  than carrying it.
- `--model` must name a provider and model declared in that config
  (`omniroute/auto/best-coding` above). Change both together.
- Its answer goes to stdout and its diagnostics to stderr, so the thread shows
  the answer and the worker log carries the noise. Measured: a turn takes a few
  seconds and its state (session db) stays inside the task's workspace.

## 5. Start a coding task

### From the app

1. Open the hosted app and pair a device (see setup.md §"Pairing").
2. Settings → Providers → **Open Sandbox (VPS)**: control-plane URL, API token,
   environment profile, optional repository + branch, sandbox scope, agent.
3. New thread in the project, type the request, send. The first message
   provisions a sandbox (a few seconds), runs the agent, and the reply appears in
   the thread. `Full access` in the composer is the runtime mode the task runs
   under; the profile can cap it.

The thread's title is generated by the same agent, in the same sandbox, as a
one-shot prompt — it is not a turn and never appears in the transcript.

### From the API

```bash
API=https://t3x.example.com ; TOK=$(grep T3X_API_TOKEN /etc/t3x/env | cut -d= -f2)
AUTH="Authorization: Bearer $TOK" ; JSON="Content-Type: application/json"

# a task with its own sandbox, running codex, in a repository
TASK=$(curl -s -H "$AUTH" -H "$JSON" -X POST "$API/tasks" \
  -d '{"profileId":"default","provider":"codex","scope":"task",
       "repositoryUrl":"github.com/nmime/t3code","branch":"feat/opensandbox"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["taskId"])')

curl -s -H "$AUTH" -H "$JSON" -X POST "$API/tasks/$TASK/messages" \
  -d '{"text":"Add a --dry-run flag to the bootstrap script and test it."}'

curl -s -H "$AUTH" "$API/tasks/$TASK/events?from=0"    # the transcript
curl -s -H "$AUTH" "$API/tasks/$TASK/snapshot"         # messages + turns
curl -s -H "$AUTH" -H "$JSON" -X POST "$API/tasks/$TASK/exec" \
  -d '{"command":"git status --short; ls"}'
curl -s -H "$AUTH" "$API/tasks/$TASK/git/diff"         # what the agent changed
```

### From the CLI

```bash
t3x task create --profile default --provider codex --repo github.com/nmime/t3code \
  --branch feat/opensandbox --scope task --state-dir /var/lib/t3x
t3x task list --state-dir /var/lib/t3x
t3x task message task_… "Fix the failing test." --state-dir /var/lib/t3x
t3x task git task_… --state-dir /var/lib/t3x
```

**Trap.** The CLI opens the same SQLite state as the running service. Use it for
reads and for one-off writes (`profile add`, `secret put`), and mutate a _live_
deployment through the HTTP API — a CLI command that starts an effect worker
fights the service ("database is locked").

## 6. Working on a real repository

- `repositoryUrl` is cloned into the sandbox; the base checkout is shared by the
  project's tasks and **each task gets its own git worktree and branch**. The
  agent edits the worktree, so two threads never fight over one working tree.
- `scope: "project"` shares one sandbox per repository (cheaper, one container
  for many threads); `scope: "task"` gives every thread its own container. The
  profile's `sandbox.isolation` is the default, the request overrides it.
- Checkpoints are git-based: `POST /tasks/{id}/checkpoints` records one,
  `POST /tasks/{id}/checkpoints/{id}/restore` rolls back, `GET /tasks/{id}/git/diff`
  is what the app shows as the thread's changes.
- A task with **no** repository is a scratch workspace (`/workspace/project`),
  which is why the codex command carries `--skip-git-repo-check`: codex refuses
  to run outside a repository it trusts, and a scratch task has none.
- `project.allowedRepositories` restricts what a profile may clone.

## 7. Operating it

**Deploy the control plane and the worker bundle** (any change under
`packages/t3x/src`, including the agent command templates):

```bash
cd /opt/t3code && git pull
pnpm --filter @t3tools/t3x build
node packages/t3x/dist/src/cli.js worker bundle --out /var/lib/t3x/worker.tgz --state-dir /var/lib/t3x
chown t3x:t3x /var/lib/t3x/worker.tgz
systemctl restart t3x
```

**Deploy the app** (any change under `apps/` or `packages/provider-*`):

```bash
cd /opt/t3code && pnpm --filter t3 build:bundle && systemctl restart t3app
```

**Rebuild the sandbox image** — and delete every sandbox first:

```bash
K=$(cat /etc/opensandbox/api-key)
systemctl stop t3x
for id in $(curl -s -H "OPEN-SANDBOX-API-KEY: $K" http://127.0.0.1:8080/v1/sandboxes \
            | python3 -c 'import sys,json;print(" ".join(i["id"] for i in json.load(sys.stdin)["items"]))'); do
  curl -s -o /dev/null -X DELETE -H "OPEN-SANDBOX-API-KEY: $K" "http://127.0.0.1:8080/v1/sandboxes/$id"
done
docker build -t t3x-sandbox:latest packages/t3x/deploy/sandbox-image
systemctl start t3x
```

The order is not optional: a sandbox keeps a reference to the image it started
from, and once that image is replaced the provider's `list_sandboxes` raises
`ImageNotFound` and answers **HTTP 500 for the whole list**, which kills the
control plane's sweep in a restart loop. A worker-bundle change reaches only
_new_ sandboxes, so a task that must run the new worker needs a new task.

**Housekeeping.** `t3x reconcile` (or the timer, every ~30 s) resumes what should
be running, renews sandbox leases and stops idle ones
(`sandbox.stopAfterIdleMinutes`). A sandbox's lifetime is absolute
(`OPENSANDBOX_SANDBOX_TIMEOUT_SECONDS`, 24 h by default) and is renewed while a
task is alive. A message to a stopped task wakes it: the control plane resumes
the task and, if its sandbox is gone, creates a new one from the same profile.

## 8. Troubleshooting

| Symptom                                                                                 | Cause                                                                                                  | Fix                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `task_state_invalid: … does not accept messages`                                        | the message was dispatched before a suspended task finished resuming                                   | fixed in the driver (it waits for `ready`); on an old build, send the message again                       |
| `task.worker_attach_failed`                                                             | the sandbox could not dial the control plane (network policy, wrong `PUBLIC_URL`)                      | make the control plane reachable from inside the sandbox; check `OPENSANDBOX_*` in `/etc/t3x/env`         |
| A turn hangs after `turn.start`, log ends with `Reading additional input from stdin…`   | an agent CLI reading a piped stdin and waiting for an EOF                                              | the worker spawns agents with stdin closed; update the worker bundle                                      |
| `Not inside a trusted directory and --skip-git-repo-check was not specified`            | codex refuses to run outside a repository                                                              | the command template carries `--skip-git-repo-check`; update the worker bundle                            |
| `apply_patch: command not found` in the worker log, then the agent writes with `printf` | the image has no `apply_patch` (it is the codex binary, dispatched on `argv[0]`)                       | rebuild the image from the current Dockerfile (it links it) — and delete the sandboxes first              |
| The reply never appears in the thread though the turn ended                             | the agent's runtime never closed its assistant stream (`streaming: true` with no final update)         | fixed on both sides (the worker closes it, the mapper closes what a run left open); update both halves    |
| `Thread title generation failed` in the app log                                         | the generation named the app's host checkout, which no task owns                                       | the app now sends the thread id; update the app bundle                                                    |
| `PR lookup failed` every ~30 s                                                          | no source-control provider is registered for the project                                               | harmless (now logged quietly); connect a source-control provider to get PR badges                         |
| The page sits on "Still connecting", `/ws` answers 401                                  | nginx forwarded `$host` and dropped a non-default port, so the app refused the cookie-carrying request | `proxy_set_header Host $http_host;`                                                                       |
| A provider instance reads "Unavailable"                                                 | its driver is not registered in this build, or the control plane URL/token is wrong                    | Settings → Providers: the driver is `opensandbox`; the status line names which of the three checks failed |
| `database is locked`                                                                    | a CLI command started an effect worker against a live deployment                                       | use the HTTP API for a running deployment                                                                 |

## 9. Where everything lives

| Thing             | Path / address                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Control plane     | `t3x.service`, `/var/lib/t3x`, `127.0.0.1:8087`, env `/etc/t3x/env`                         |
| Worker bundle     | `/var/lib/t3x/worker.tgz` (uploaded into every sandbox)                                     |
| Sandbox server    | `opensandbox.service`, `/opt/opensandbox`, `127.0.0.1:8080`, key `/etc/opensandbox/api-key` |
| Sandbox image     | `t3x-sandbox:latest` from `packages/t3x/deploy/sandbox-image`                               |
| App               | `t3app.service`, `/var/lib/t3app/.t3`, `127.0.0.1:8090`                                     |
| Provider instance | `/var/lib/t3app/.t3/userdata/settings.json` → `providerInstances.<id>`                      |
| Profile           | control-plane state (`t3x profile list`); the file lives in `/etc/t3x/profile-*.yaml`       |
| Secrets           | control-plane state, encrypted with `/var/lib/t3x/secret.key` (`t3x secret list`)           |
