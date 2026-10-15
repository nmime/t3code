# Setup: from zero to a thread running in a sandbox

This is the ordered walkthrough — every command, in the order it has to run,
with the check that tells you it worked.

The pieces:

| Piece                 | Where it runs                      | What it is                                                      |
| --------------------- | ---------------------------------- | --------------------------------------------------------------- |
| control plane         | a host sandboxes can reach (VPS)   | `@t3tools/t3x` — tasks, sandboxes, worktrees, the event log     |
| worker                | inside each task sandbox           | runs the agent next to the checkout and dials the control plane |
| provider driver       | inside T3 (`apps/server`)          | `@t3tools/provider-opensandbox` — turns a T3 thread into a task |
| OpenSandbox lifecycle | the same host as the control plane | provisions the sandboxes (`opensandbox-server`)                 |

The sandbox provider is **OpenSandbox** (Apache-2.0,
<https://github.com/opensandbox-group/OpenSandbox>): a lifecycle REST API plus
an agent (`execd`) injected into each sandbox container. This deployment runs
the Docker runtime on one host — no Kubernetes, no microVMs — which is what the
architecture needs: create a container from an image, run commands in it, move
files, and reach a port through the server's own proxy.

---

## 0. Prerequisites

- **Node ≥ 22** on the control-plane host and on the machine running T3. The
  monorepo's own `engines` wants `^24.13.1` and the control plane needs
  `>=22.5.0`, so install Node 24 if you are choosing.
- **Docker** on the host that runs sandboxes, and **Python ≥ 3.10** for the
  lifecycle server.
- **git** inside the sandboxes (checkpoints are git-based).
- A **host the sandboxes can reach** for the control plane. Sandboxes dial
  _out_, so this needs an address reachable from inside a sandbox — a VPS with a
  public name, or anything on the same network.

> **Why self-hosted.** The sandbox provider is a lifecycle server the deployment
> runs itself (OpenSandbox, on a single Docker host), not a managed product.
> A managed provider can apply network limits by billing tier and refuse to let
> a sandbox override them, and this architecture needs a sandbox that can dial
> the control plane: with the policy in the way, DNS resolves the control-plane
> host, TCP 443 connects, and the TLS handshake is then reset by peer — it looks
> like a broken server rather than a policy, and the run ends with
> `task.worker_attach_failed`. Self-hosted has no such policy, which is also why
> the sandbox server usually lives on the same machine as the control plane.

---

## 1. Get the code and build the control plane

`packages/t3x/deploy/t3x-bootstrap.sh` does all of steps 1–4 on a fresh
Ubuntu host — packages, Node, checkout, build, the `t3x` user, the sandbox
server, the sandbox image, `/etc/t3x/env`, the worker bundle, a profile, the
systemd unit, TLS (Caddy, or one nginx server block when the host already runs
nginx) and a final `doctor` — and it is idempotent, so re-running it updates the
checkout and restarts the service. Copy it over and run it:

```bash
scp packages/t3x/deploy/t3x-bootstrap.sh root@your-vps:/root/
ssh root@your-vps
DOMAIN=t3x.example.com SANDBOX_DOMAIN=sandbox.example.com bash /root/t3x-bootstrap.sh
```

The rest of this section is what it does, by hand.

```bash
git clone https://github.com/nmime/t3code
cd t3code
git checkout feat/opensandbox

npx --yes pnpm@11.10.0 install --ignore-scripts --child-concurrency=1 --prefer-offline
pnpm --filter @t3tools/t3x build
```

Nothing else is needed on the control-plane host: the backend talks HTTP to the
sandbox server, so there is no provider SDK to install.

## 2. Install the sandbox server

On the host that will run sandboxes (here: the same VPS):

```bash
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
uv venv --python 3.12 /opt/opensandbox/venv
uv pip install --python /opt/opensandbox/venv/bin/python "opensandbox-server==1.1.1"

docker pull opensandbox/execd:release-1.1.1
```

Write `/etc/opensandbox/sandbox.toml`:

```toml
[server]
host = "127.0.0.1"          # nginx terminates TLS in front of it
port = 8080
api_key = "<openssl rand -hex 32>"
eip = "sandbox.example.com"  # the public name; used in endpoint URLs
max_sandbox_timeout_seconds = 86400

[proxy]
resolve_internal = true

[runtime]
type = "docker"
execd_image = "opensandbox/execd:release-1.1.1"

[store]
type = "sqlite"
path = "/var/lib/opensandbox/opensandbox.db"

[docker]
network_mode = "bridge"
port_range_min = 40000
port_range_max = 40200
publish_host = "127.0.0.1"   # sandbox ports stay off the public interface
no_new_privileges = true
pids_limit = 2048
```

Three of those are load-bearing:

- `publish_host = 127.0.0.1` — the sandbox's host ports are bound on loopback
  only. Nothing in a sandbox is reachable from the internet except through the
  lifecycle server's proxy, which is the one path that needs no API key.
- `api_key` — every lifecycle route needs it (`OPEN-SANDBOX-API-KEY`); `/health`,
  `/version` and the sandbox proxy paths are the exceptions.
- `resourceLimits` on a create request become the container's cgroup limits, so
  a profile's `runtime.resources` really do cap a task.

Run it under systemd as a user in the `docker` group (`deploy/opensandbox.service`
is the unit this deployment uses):

```bash
systemctl enable --now opensandbox.service
curl -s http://127.0.0.1:8080/health     # {"status":"healthy"}
```

### Build the sandbox image

Every sandbox is a container from one image, and the worker runs inside it, so
the image needs Node, git and a toolchain:

```bash
docker build -t t3x-sandbox:latest packages/t3x/deploy/sandbox-image
```

`deploy/sandbox-image/Dockerfile` is `node:24-slim` plus git, curl,
ca-certificates, python3, make, g++, ripgrep, procps and pnpm. Point the control
plane at it with `OPENSANDBOX_IMAGE`.

### Put TLS in front of the sandbox API

```nginx
upstream opensandbox_api { server 127.0.0.1:8080; keepalive 16; }

server {
    listen 80;
    server_name sandbox.example.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name sandbox.example.com;
    ssl_certificate     /etc/letsencrypt/live/sandbox.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sandbox.example.com/privkey.pem;

    client_max_body_size 512m;   # worker bundles and repository tarballs
    client_body_timeout 300s;

    location / {
        proxy_pass http://opensandbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;   # SSE, WebSockets
        proxy_set_header Connection        $connection_upgrade;
        proxy_request_buffering off;
        proxy_buffering         off;
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
    }
}
```

```bash
certbot certonly --nginx -d sandbox.example.com --non-interactive --agree-tos
nginx -t && systemctl reload nginx
```

`$connection_upgrade` needs one `map` in the `http` block (Ubuntu's nginx
includes `/etc/nginx/conf.d/*.conf`, so a drop-in there works):

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

## 3. Point the control plane at it

```bash
export OPENSANDBOX_API_URL=https://sandbox.example.com
export OPENSANDBOX_API_KEY=<the api_key from sandbox.toml>
export OPENSANDBOX_IMAGE=t3x-sandbox:latest
export OPENSANDBOX_PUBLIC_URL=https://sandbox.example.com   # optional; preview links
```

`--opensandbox-url`, `--opensandbox-api-key` and `--opensandbox-image` override
the first three for one `serve` run.

**Check it now, before anything else:**

```bash
node packages/t3x/dist/src/cli.js doctor
```

`doctor` prints one line per check and exits non-zero when one fails:

- `sandbox api url` — the endpoint `serve` would use (yours, or the local
  default `http://127.0.0.1:8080`);
- `sandbox api key` — a key is present;
- `sandbox image` — the image every image-backed profile is built from;
- `sandbox server reachable` — the server answered `/health` and `/version`,
  and the sandbox list was read with that key. This is the check that separates
  "wrong URL" from "wrong key" from "the server is down".

## 4. Define an environment profile

A profile is what every sandbox in a project is built from. Write `profile.yaml`:

```yaml
apiVersion: t3x/v1
kind: EnvironmentProfile
metadata: { name: typescript-backend, version: 1 }
runtime:
  # Omit `snapshot` on a Docker deployment: snapshots are a fast-sandbox
  # (Kubernetes) feature there, and every sandbox is built from
  # OPENSANDBOX_IMAGE instead, with `resources` applied as container limits.
  resources: { cpu: 2, memoryGiB: 4, diskGiB: 8 }
project:
  workingDirectory: /workspace/project # must be writable inside the sandbox
  setup:
    - "corepack enable"
    - "pnpm install --frozen-lockfile"
  allowedRepositories: ["github.com/your-org/*"]
environment:
  CI: "true"
agents:
  allowed: [codex, claude, opencode, pi, echo]
  defaults: { provider: codex }
  maxRuntimeMode: auto-accept-edits # the strongest mode a turn may ask for
```

```bash
node packages/t3x/dist/src/cli.js profile add --id typescript-backend --file profile.yaml
node packages/t3x/dist/src/cli.js profile resolve --id typescript-backend
```

Two rules that fail quietly when missed: `project.workingDirectory` must be
writable inside the sandbox (`/workspace` exists in the shipped image, and the
control plane creates it either way), and a profile that names a
`runtime.snapshot` is asking the server to restore one — on the Docker runtime
that request is refused by the server, which is why image-backed profiles are
the supported form here.

## 5. Pack the worker and serve

A sandbox cannot see the control plane's filesystem, so the worker travels as
one archive:

```bash
node packages/t3x/dist/src/cli.js worker bundle --out /var/lib/t3x/worker.tgz

node packages/t3x/dist/src/cli.js serve \
  --state-dir /var/lib/t3x --port 8087 \
  --api-token "$(openssl rand -hex 24)" \
  --worker-url https://t3x.example.com \
  --worker-bundle /var/lib/t3x/worker.tgz
```

- `--worker-url` is the address a **sandbox** dials. `127.0.0.1` is only right
  when the worker runs on the control-plane host. Put TLS in front of it (a
  reverse proxy is enough); the control plane needs no inbound port of its own —
  it binds `127.0.0.1` only.
- `--api-token` is required if the control plane is reachable from anywhere but
  localhost; pass the same token to T3 in step 6.
- `--backend auto` (the default) picks OpenSandbox when `OPENSANDBOX_API_URL` or
  `OPENSANDBOX_API_KEY` is set, the local directory backend otherwise.
  `--backend local|opensandbox` forces one. The banner prints which, plus the
  sandbox API and image it resolved.

```bash
curl -s -H "authorization: Bearer $TOKEN" localhost:8087/health
curl -s -H "authorization: Bearer $TOKEN" localhost:8087/profiles
```

When `--api-token` is set, **every** route wants it, `/health` included — a
probe without the header answers `401`, which is not a broken deployment. A
liveness check therefore needs the header too.

### Behind an existing nginx

If the host already terminates TLS with nginx (a machine with other sites on
it), do not install a second web server — add one server block and let certbot
fill in the certificate, exactly as it does for the other vhosts:

```nginx
# /etc/nginx/sites-available/t3x.conf -> /etc/nginx/sites-enabled/t3x.conf
server {
    listen 80;
    listen [::]:80;
    server_name t3x.example.com;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:8087;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 3600s;   # turns and streams are long-lived
        proxy_send_timeout 3600s;
        proxy_buffering    off;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/t3x.conf /etc/nginx/sites-enabled/t3x.conf
nginx -t && systemctl reload nginx
certbot --nginx -d t3x.example.com --redirect --keep-until-expiring
```

No domain of your own pointing here yet? `<ip-with-dashes>.sslip.io` resolves
to the address and certbot can issue for it.

## 6. Point T3 at the control plane

In the T3 app: **Settings → Providers → Add provider → OpenSandbox**, or one entry
in the server settings' `providerInstances` map:

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

The driver id is `opensandbox` — the provider's identity in T3's registry and in
stored settings. Nothing else writes or reads it: a settings file whose
`providerInstances` entry names a different driver reads as an unavailable
provider, and the fix is to set the driver on that entry to `opensandbox` (the
instance id is the user's own routing key and does not change). The instance's
status line is the control plane's
health as the driver probed it, and it says **which** failure it was:
unreachable, token refused, or no such environment profile.
`hasDefaultInstance` is `false`, so nothing is created until you add one.

## 7. Run a thread

Pick the instance in the composer (or set it as the project's default provider)
and send a message. What happens, in order:

1. T3 opens a provider session and sends the turn;
2. the adapter asks the control plane for the task — creating it, or reusing the
   project's sandbox, on its own worktree and branch;
3. the control plane creates the sandbox (image-backed, resource-capped), waits
   for `execd` inside it to answer, uploads and unpacks the worker, starts it
   detached, and the worker dials `--worker-url` and attaches;
4. the agent runs in the task's worktree; events stream back through T3's
   ingestor into the thread's projection;
5. approvals, interrupts, steering, checkpoints and rollback all go through the
   same route.

Watch it from the control plane:

```bash
node packages/t3x/dist/src/cli.js task list
node packages/t3x/dist/src/cli.js task status <taskId>   # scope, project, worktree, sandbox
node packages/t3x/dist/src/cli.js task git <taskId>      # per-worktree git state
```

`t3x sandbox list` shows the sandboxes the server holds; `t3x sandbox destroy
<id>` removes one (the container goes with it).

### Sandbox scope

Default is **one shared sandbox per project/repository with one git worktree per
task** — dependencies, caches and dev services are shared, working directories
are not. The per-task toggle (`--scope task`, or `sandboxScope: "task"` in the
instance) gives a thread a dedicated sandbox. Resolution order: task request →
project default → global default. The lifecycle is reference-counted, and
reuse is gated on a compatibility key (repository, profile, snapshot, credential
domain), so an incompatible task never lands in someone else's sandbox.

## 8. Verify, in this order

```bash
# 1. configuration and reachability
node packages/t3x/dist/src/cli.js doctor

# 2. the backend against a real lifecycle server (creates and deletes sandboxes)
OPENSANDBOX_API_URL=https://sandbox.example.com \
OPENSANDBOX_API_KEY=… OPENSANDBOX_IMAGE=t3x-sandbox:latest \
node --test packages/t3x/dist/tests/integration/openSandboxReal.test.js

# 3. the whole package: unit + integration, one file at a time
for f in packages/t3x/dist/tests/unit/*.test.js packages/t3x/dist/tests/integration/*.test.js; do
  node --test --test-concurrency=1 "$f"
done

# 4. T3's own orchestration, ingestor and projection over the adapter
node_modules/.bin/vp test run apps/server/src/orchestration-v2/Adapters/OpenSandboxAdapterV2.e2e.test.ts --no-file-parallelism
```

Test 4 is the one that proves what the UI shows: a real `thread.create` and
`message.dispatch` through T3's orchestrator, session manager, turn-start
service, run execution and event ingestor, over the real driver and adapter,
against a real control plane and a real worker — asserting the reply in T3's own
projection.

## 9. When it does not work

| Symptom                                               | Cause                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `task.worker_attach_failed`                           | the sandbox cannot reach `--worker-url` (wrong address, no TLS, firewall)                                                   |
| `sandbox server reachable` fails in `doctor`          | the lifecycle server is down, the URL is wrong, or the key is rejected (401)                                                |
| task stuck `provisioning`                             | the image is not on the Docker host, or the create was refused                                                              |
| a task fails immediately with a 502 from the proxy    | execd inside the sandbox was not up yet — the backend waits for `/ping`, so this means it never answered within the timeout |
| agent runs in the wrong place / `mkdir` fails         | `project.workingDirectory` is not writable inside the sandbox image                                                         |
| no such environment profile                           | the profile was never added, or the instance names another id                                                               |
| token refused                                         | `--api-token` on the control plane and `apiToken` in the instance differ                                                    |
| reply never appears although the sandbox ran the turn | T3 dropped the events — check `apps/server`'s logs for a decode error                                                       |
| sandbox creation fails with a Docker error            | the Docker daemon is unhappy (disk, port range exhausted) — `journalctl -u opensandbox` has the server's own message        |

Every error the HTTP API returns carries the status that matches its cause
(404 missing, 409 conflict/refusal, 401 unauthorized, 403 policy, 422
unsupported, 503 no worker), so a client can tell them apart.
