#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# t3x-bootstrap.sh - install the T3 Code control plane and its sandbox provider
# (OpenSandbox) on a VPS.
#
# Idempotent: re-running updates the checkout, repacks the worker and restarts
# the service. Nothing is deleted, and an existing web server on :80/:443 is
# never overwritten - the script says so and leaves it alone.
#
# Usage
#   DOMAIN=t3x.example.com ./t3x-bootstrap.sh
#   DOMAIN=t3x.example.com SANDBOX_DOMAIN=sandbox.example.com ./t3x-bootstrap.sh
#
# Variables (DOMAIN is required; the rest optional)
#   DOMAIN               public name for the control plane: the name T3 dials and
#                        the one the certificate is issued for (required)
#   SANDBOX_DOMAIN       public name for the sandbox API (default: sandbox.$DOMAIN)
#   OPENSANDBOX_API_KEY  key the sandbox server requires (default: generated)
#   OPENSANDBOX_API_URL  skip the local install and use this server instead
#   IMAGE                sandbox image to build and use (default: t3x-sandbox:latest)
#   T3X_API_TOKEN        bearer token T3 must present (default: generated)
#   REPO_URL, REPO_BRANCH, APP_DIR, STATE_DIR, PORT, PROFILE_ID, AGENT,
#   SNAPSHOT, TLS=auto|caddy|nginx|none, SKIP_FIREWALL=1
#
# Docker and Python >= 3.10 are the only prerequisites the script does not
# install itself: it will not put a container runtime on a host that already
# runs somebody's production containers.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/nmime/t3code}"
REPO_BRANCH="${REPO_BRANCH:-feat/opensandbox}"
APP_DIR="${APP_DIR:-/opt/t3code}"
STATE_DIR="${STATE_DIR:-/var/lib/t3x}"
SANDBOX_DIR="${SANDBOX_DIR:-/opt/opensandbox}"
SANDBOX_STATE_DIR="${SANDBOX_STATE_DIR:-/var/lib/opensandbox}"
SANDBOX_ETC_DIR="${SANDBOX_ETC_DIR:-/etc/opensandbox}"
SANDBOX_SERVICE_USER="${SANDBOX_SERVICE_USER:-osb}"
ETC_DIR="/etc/t3x"
ENV_FILE="$ETC_DIR/env"
PORT="${PORT:-8087}"
PROFILE_ID="${PROFILE_ID:-default}"
AGENT="${AGENT:-echo}"
IMAGE="${IMAGE:-t3x-sandbox:latest}"
OPENSANDBOX_SERVER_VERSION="${OPENSANDBOX_SERVER_VERSION:-1.1.1}"
OPENSANDBOX_EXECD_TAG="${OPENSANDBOX_EXECD_TAG:-release-1.1.1}"
SERVICE_USER="t3x"
# The monorepo's engines field wants ^24.13.1; the control plane itself needs
# >=22.5.0. 24 satisfies both.
NODE_MAJOR=24

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# The nginx vhost that already answers a name, if any. Rewriting a name that is
# already served would leave two server blocks for it and the first would win.
# The directory's entries are read one by one on purpose: a vhost in
# sites-enabled is normally a symlink, and `grep -r` does not follow a symlink it
# meets while recursing, so a served name looked unserved.
# Prints the path, or nothing; always returns 0, because callers assign its
# output and `set -e` would abort on a non-zero substitution.
vhost_for() {
  local f
  for f in /etc/nginx/sites-enabled/*; do
    [ -f "$f" ] || continue
    grep -qsE "server_name[^;]*[[:space:]]$1([[:space:];]|$)" "$f" && { printf '%s\n' "$f"; return 0; }
  done
  return 0
}
# `--state-dir` has to come after the subcommand: the CLI reads its first
# argument as the command name, and a command without it writes to /root/.t3x
# where the service (which uses $STATE_DIR) never looks.
CLI()  { ( cd "$APP_DIR" && node "$APP_DIR/packages/t3x/dist/src/cli.js" "$@" --state-dir "$STATE_DIR" ); }

[ "$(id -u)" = 0 ] || die "run as root: sudo -i, then ./t3x-bootstrap.sh"

# ---------------------------------------------------------------- 0. facts ---
. /etc/os-release 2>/dev/null || true
log "host: ${PRETTY_NAME:-unknown} $(uname -m) | $(nproc) vcpu | $(awk '/MemTotal/{printf "%.1f GiB RAM", $2/1048576}' /proc/meminfo) | $(df -h / | awk 'NR==2{print $4}') free on /"

PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)}"
[ -n "$PUBLIC_IP" ] || die "could not determine the public IP; pass PUBLIC_IP=..."
# No default on purpose. The certificate is issued for this name from its own
# DNS, so a silent fallback would produce a host nobody can reach and a renewal
# that fails months later. A name that resolves to the IP by itself is an
# explicit choice, not a default: DOMAIN=${PUBLIC_IP//./-}.sslip.io
if [ -z "${DOMAIN:-}" ]; then
  die "DOMAIN is required: the public name the control plane is served on, e.g. DOMAIN=t3x.example.com. Point a DNS record at $PUBLIC_IP first; without DNS of your own, DOMAIN=${PUBLIC_IP//./-}.sslip.io resolves to this IP by itself."
fi
SANDBOX_DOMAIN="${SANDBOX_DOMAIN:-sandbox.$DOMAIN}"
WORKER_URL="${WORKER_URL:-https://$DOMAIN}"
log "public ip $PUBLIC_IP | control plane url $WORKER_URL | sandbox api https://$SANDBOX_DOMAIN"

# --------------------------------------------------------- 1. base packages ---
log "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git jq tar gzip xz-utils openssl iproute2 >/dev/null

if have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then
  log "node $(node -v) already present"
else
  log "installing Node $NODE_MAJOR (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  log "node $(node -v)"
fi

# pnpm: the repo pins pnpm@11.10.0 in its packageManager field. Use what the
# machine already has (corepack honours the pin inside the repo) and never
# overwrite a pnpm the machine manages.
PNPM="pnpm"
if ! have pnpm; then
  have corepack && corepack enable pnpm >/dev/null 2>&1 || true
  have pnpm || PNPM="npx --yes pnpm@11.10.0"
fi
log "pnpm: $PNPM ($($PNPM -v 2>/dev/null || echo unknown))"

# ----------------------------------------------------------------- 2. repo ---
log "checkout $REPO_URL @ $REPO_BRANCH"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q --depth 1 origin "$REPO_BRANCH"
  git -C "$APP_DIR" checkout -q -B "$REPO_BRANCH" FETCH_HEAD
  git -C "$APP_DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi
log "at $(git -C "$APP_DIR" rev-parse --short HEAD) $(git -C "$APP_DIR" log -1 --pretty=%s)"

log "installing @t3tools/t3x and its dependencies (monorepo, filtered)"
cd "$APP_DIR"
# `--filter "."` matters: typescript lives in the root devDependencies and
# `pnpm --filter @t3tools/t3x build` finds it through the root .bin.
$PNPM install --filter "@t3tools/t3x..." --filter "." --ignore-scripts --child-concurrency=1 --prefer-offline
log "building the control plane"
$PNPM --filter @t3tools/t3x build

# --------------------------------------------- 3. the sandbox provider ---
# OpenSandbox (Apache-2.0): a lifecycle REST API plus an agent (execd) injected
# into each sandbox container. The Docker runtime runs the sandboxes on this
# host, which is why a worker inside one can dial the control plane.
log "sandbox provider: OpenSandbox"
have docker || die "docker is required for the sandbox runtime; install it first (curl -fsSL https://get.docker.com | sh)"

if [ -z "${OPENSANDBOX_API_URL:-}" ]; then
  if ! have uv; then
    log "installing uv"
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
  fi
  if [ ! -x "$SANDBOX_DIR/venv/bin/opensandbox-server" ]; then
    log "installing opensandbox-server $OPENSANDBOX_SERVER_VERSION"
    uv venv --python 3.12 "$SANDBOX_DIR/venv"
    uv pip install --python "$SANDBOX_DIR/venv/bin/python" "opensandbox-server==$OPENSANDBOX_SERVER_VERSION"
  fi
  chmod -R a+rX "$SANDBOX_DIR"

  log "pulling the execd image"
  docker pull "opensandbox/execd:$OPENSANDBOX_EXECD_TAG"

  log "building the sandbox image $IMAGE"
  docker build -t "$IMAGE" "$APP_DIR/packages/t3x/deploy/sandbox-image"

  log "sandbox server user, config and unit"
  id -u "$SANDBOX_SERVICE_USER" >/dev/null 2>&1 || \
    useradd --system --home "$SANDBOX_STATE_DIR" --shell /usr/sbin/nologin "$SANDBOX_SERVICE_USER"
  usermod -aG docker "$SANDBOX_SERVICE_USER"
  mkdir -p "$SANDBOX_ETC_DIR" "$SANDBOX_STATE_DIR"

  prev_key() { [ -f "$SANDBOX_ETC_DIR/api-key" ] && cat "$SANDBOX_ETC_DIR/api-key" || true; }
  OPENSANDBOX_API_KEY="${OPENSANDBOX_API_KEY:-$(prev_key)}"
  OPENSANDBOX_API_KEY="${OPENSANDBOX_API_KEY:-$(openssl rand -hex 32)}"
  printf '%s' "$OPENSANDBOX_API_KEY" > "$SANDBOX_ETC_DIR/api-key"
  chmod 600 "$SANDBOX_ETC_DIR/api-key"

  cat > "$SANDBOX_ETC_DIR/sandbox.toml" <<EOF
# OpenSandbox lifecycle server - written by t3x-bootstrap.sh.
# docs: https://github.com/opensandbox-group/OpenSandbox
[server]
host = "127.0.0.1"
port = 8080
api_key = "$OPENSANDBOX_API_KEY"
eip = "$SANDBOX_DOMAIN"
max_sandbox_timeout_seconds = 86400

[proxy]
resolve_internal = true

[log]
level = "INFO"

[runtime]
type = "docker"
execd_image = "opensandbox/execd:$OPENSANDBOX_EXECD_TAG"

[store]
type = "sqlite"
path = "$SANDBOX_STATE_DIR/opensandbox.db"

[docker]
network_mode = "bridge"
port_range_min = 40000
port_range_max = 40200
# Sandbox ports stay on loopback: the only way in is the server's own proxy.
publish_host = "127.0.0.1"
no_new_privileges = true
pids_limit = 2048

[ingress]
mode = "direct"
EOF
  chmod 640 "$SANDBOX_ETC_DIR/sandbox.toml"
  chown root:docker "$SANDBOX_ETC_DIR/sandbox.toml"

  cat > /etc/systemd/system/opensandbox.service <<EOF
[Unit]
Description=OpenSandbox lifecycle server (sandbox provider for t3x)
Documentation=https://github.com/opensandbox-group/OpenSandbox
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=$SANDBOX_SERVICE_USER
Group=docker
Environment=HOME=$SANDBOX_STATE_DIR
Environment=SANDBOX_CONFIG_PATH=$SANDBOX_ETC_DIR/sandbox.toml
ExecStart=$SANDBOX_DIR/venv/bin/opensandbox-server --config $SANDBOX_ETC_DIR/sandbox.toml
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=$SANDBOX_STATE_DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable -q opensandbox
  systemctl restart opensandbox
  sleep 4
  systemctl is-active -q opensandbox || { journalctl -u opensandbox -n 40 --no-pager || true; die "opensandbox did not start"; }
  chown -R "$SANDBOX_SERVICE_USER:$SANDBOX_SERVICE_USER" "$SANDBOX_STATE_DIR"
  log "sandbox server up on 127.0.0.1:8080"
  curl -fsS http://127.0.0.1:8080/health && echo || warn "the sandbox server /health did not answer"
else
  log "using the sandbox server at $OPENSANDBOX_API_URL (no local install)"
  OPENSANDBOX_API_KEY="${OPENSANDBOX_API_KEY:-}"
fi

# ------------------------------------------------- 4. service user + env ---
log "service user and environment"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$ETC_DIR" "$STATE_DIR"

prev() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true; }
OPENSANDBOX_API_URL="${OPENSANDBOX_API_URL:-$(prev OPENSANDBOX_API_URL)}"
OPENSANDBOX_API_URL="${OPENSANDBOX_API_URL:-https://$SANDBOX_DOMAIN}"
OPENSANDBOX_API_KEY="${OPENSANDBOX_API_KEY:-$(prev OPENSANDBOX_API_KEY)}"
OPENSANDBOX_IMAGE="${OPENSANDBOX_IMAGE:-$(prev OPENSANDBOX_IMAGE)}"
OPENSANDBOX_IMAGE="${OPENSANDBOX_IMAGE:-$IMAGE}"
OPENSANDBOX_PUBLIC_URL="${OPENSANDBOX_PUBLIC_URL:-$(prev OPENSANDBOX_PUBLIC_URL)}"
OPENSANDBOX_PUBLIC_URL="${OPENSANDBOX_PUBLIC_URL:-$OPENSANDBOX_API_URL}"
T3X_API_TOKEN="${T3X_API_TOKEN:-$(prev T3X_API_TOKEN)}"
T3X_API_TOKEN="${T3X_API_TOKEN:-$(openssl rand -hex 32)}"

cat > "$ENV_FILE" <<EOF
# t3x control plane environment - read by systemd (t3x.service). Keep it 0600.
OPENSANDBOX_API_URL=$OPENSANDBOX_API_URL
OPENSANDBOX_API_KEY=$OPENSANDBOX_API_KEY
OPENSANDBOX_IMAGE=$OPENSANDBOX_IMAGE
OPENSANDBOX_PUBLIC_URL=$OPENSANDBOX_PUBLIC_URL
T3X_API_TOKEN=$T3X_API_TOKEN
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
# doctor reads them from the environment; systemd reads them from the file.
export OPENSANDBOX_API_URL OPENSANDBOX_API_KEY OPENSANDBOX_IMAGE OPENSANDBOX_PUBLIC_URL T3X_API_TOKEN
[ -n "$OPENSANDBOX_API_KEY" ] || warn "OPENSANDBOX_API_KEY is empty - the server must be unauthenticated, or the control plane falls back to the local backend"

# -------------------------------------------------- 5. worker + profile ---
log "packing the worker bundle"
CLI worker bundle --out "$STATE_DIR/worker.tgz"

PROFILE_FILE="$ETC_DIR/profile-$PROFILE_ID.yaml"
if [ ! -f "$PROFILE_FILE" ]; then
  log "writing environment profile $PROFILE_FILE"
  if [ -n "${SNAPSHOT:-}" ]; then
    RUNTIME_BLOCK="  # Snapshot every sandbox of this profile is built from.
  snapshot: $SNAPSHOT"
  else
    RUNTIME_BLOCK="  # No snapshot: sandboxes are built from \$OPENSANDBOX_IMAGE
  # ($IMAGE) and these resources become the container's limits.
  resources:
    cpu: 2
    memoryGiB: 4
    diskGiB: 10"
  fi
  # A coding task needs a model. Without a gateway URL the profile installs the
  # agents but leaves them unconfigured (they fail loudly, which is the honest
  # default); with one, the setup step writes the config both codex and OpenClaw
  # read, and the key is injected from the control plane's secret store.
  SETUP_BLOCK="  setup: []"
  SECRETS_BLOCK=""
  if [ -n "${MODEL_GATEWAY_URL:-}" ]; then
    MODEL_ID="${MODEL_ID:-auto/best-coding}"
    SETUP_BLOCK="  # Written into every task's workspace before the first turn. The
  # key is an environment reference: the secret never lands in the file.
  setup:
    - >-
      mkdir -p .codex && printf '%s\\n' 'model = \"$MODEL_ID\"'
      'model_provider = \"gateway\"' 'sandbox_mode = \"danger-full-access\"'
      'approval_policy = \"never\"' '' '[model_providers.gateway]'
      'name = \"Gateway\"' 'base_url = \"$MODEL_GATEWAY_URL\"'
      'env_key = \"OPENAI_API_KEY\"' 'wire_api = \"responses\"' > .codex/config.toml
      && cat .codex/config.toml
    - >-
      mkdir -p .openclaw && printf '%s\\n' '{' '  models: {' '    providers: {'
      '      gateway: {' '        baseUrl: \"$MODEL_GATEWAY_URL\",'
      '        apiKey: { source: \"env\", provider: \"default\", id: \"OPENAI_API_KEY\" },'
      '        auth: \"api-key\",' '        api: \"openai-responses\",'
      '        models: [' '          { id: \"$MODEL_ID\", name: \"$MODEL_ID\", api: \"openai-responses\" },'
      '        ],' '      },' '    },' '  },' '  update: { checkOnStart: false },' '}'
      > .openclaw/openclaw.json5 && cat .openclaw/openclaw.json5"
    SECRETS_BLOCK="secrets:
  # Store the key once: t3x secret put MODEL_GATEWAY_API_KEY
  # (see docs/coding.md), then it is injected as OPENAI_API_KEY in every task.
  - name: OPENAI_API_KEY
    secretRef: MODEL_GATEWAY_API_KEY
    inject: env"
  else
    warn "MODEL_GATEWAY_URL is empty: the profile installs the agents without a model config"
  fi
  cat > "$PROFILE_FILE" <<EOF
apiVersion: t3x/v1
kind: EnvironmentProfile
metadata:
  name: $PROFILE_ID
  version: 1
  description: Profile generated by t3x-bootstrap.sh.
runtime:
$RUNTIME_BLOCK
project:
  workingDirectory: /workspace/project
$SETUP_BLOCK
environment:
  CI: "true"
$SECRETS_BLOCK
agents:
  allowed: [echo, codex, openclaw, claude, opencode]
  defaults:
    provider: $AGENT
sandbox:
  isolation: per-project
  stopAfterIdleMinutes: 30
EOF
fi
CLI profile add --id "$PROFILE_ID" --file "$PROFILE_FILE"
CLI profile resolve --id "$PROFILE_ID"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR" "$ETC_DIR"

# ------------------------------------------------------------- 6. systemd ---
log "systemd unit t3x.service"
sed -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^Group=.*|Group=$SERVICE_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=$ENV_FILE|" \
    -e "/^ExecStart=/ s|/opt/t3code|$APP_DIR|g" \
    -e "/^ExecStart=/ s|--state-dir [^ ]*|--state-dir $STATE_DIR|" \
    -e "/^ExecStart=/ s|--port [0-9]*|--port $PORT|" \
    -e "/^ExecStart=/ s|--worker-url [^ ]*|--worker-url $WORKER_URL|" \
    -e "/^ExecStart=/ s|--worker-bundle [^ ]*|--worker-bundle $STATE_DIR/worker.tgz|" \
    "$APP_DIR/packages/t3x/deploy/t3x-control-plane.service" > /etc/systemd/system/t3x.service

systemctl daemon-reload
systemctl enable -q t3x
systemctl restart t3x
sleep 3
if ! systemctl is-active -q t3x; then
  journalctl -u t3x -n 40 --no-pager || true
  die "t3x did not start"
fi
log "control plane up"
curl -fsS "http://127.0.0.1:$PORT/health" && echo || warn "/health did not answer"
curl -fsS -H "authorization: Bearer $T3X_API_TOKEN" "http://127.0.0.1:$PORT/profiles" && echo || warn "/profiles did not answer"

# -------------------------------------------------------------- 7. TLS ---
# The control plane listens on 127.0.0.1 only; something has to terminate TLS
# for $DOMAIN in front of it. Caddy if the machine has none, otherwise the web
# server that is already there (nginx), otherwise nothing is touched.
TLS="${TLS:-auto}"   # auto | caddy | nginx | none
if [ "$TLS" = auto ]; then
  if have caddy; then TLS=caddy
  elif have nginx && ss -ltnp 2>/dev/null | grep -qE ':(80|443)[[:space:]]'; then TLS=nginx
  elif ss -ltnp 2>/dev/null | grep -qE ':(80|443)[[:space:]]'; then TLS=none
  else TLS=caddy; fi
fi
log "TLS: $TLS (domain $DOMAIN)"

tls_caddy() {
  if ! have caddy; then
    apt-get install -y -qq caddy >/dev/null 2>&1 || {
      add-apt-repository -y universe >/dev/null 2>&1 || true
      apt-get update -qq
      apt-get install -y -qq caddy
    }
  fi
  [ -f /etc/caddy/Caddyfile.orig ] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig 2>/dev/null || true
  cat > /etc/caddy/Caddyfile <<EOF
# t3x control plane. Caddy obtains a certificate for $DOMAIN automatically.
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  systemctl enable -q caddy 2>/dev/null || true
  systemctl restart caddy
  sleep 4
  systemctl is-active -q caddy && log "caddy up" || warn "caddy is not active: journalctl -u caddy -n 40"
}

tls_nginx() {
  have certbot || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  T3X_VHOST="$(vhost_for "$DOMAIN")"
  if [ -n "$T3X_VHOST" ]; then
    log "reusing the vhost that already serves $DOMAIN ($T3X_VHOST)"
  elif [ ! -f /etc/nginx/sites-available/t3x.conf ]; then
    cat > /etc/nginx/sites-available/t3x.conf <<EOF
# t3x control plane ($DOMAIN) -> 127.0.0.1:$PORT.
# Written by t3x-bootstrap.sh; certbot rewrites this file to add the
# certificate, exactly as it does for the other vhosts on this machine.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;
    }
}
EOF
    ln -sfn /etc/nginx/sites-available/t3x.conf /etc/nginx/sites-enabled/t3x.conf
  fi
  # The sandbox API needs its own public name: it is what T3 talks to for
  # preview links and what the worker bundle is uploaded through.
  SANDBOX_VHOST="$(vhost_for "$SANDBOX_DOMAIN")"
  if [ -n "$SANDBOX_VHOST" ]; then
    log "reusing the vhost that already serves $SANDBOX_DOMAIN ($SANDBOX_VHOST)"
  elif [ ! -f /etc/nginx/sites-available/sandbox.conf ]; then
    cat > /etc/nginx/sites-available/sandbox.conf <<EOF
# OpenSandbox lifecycle server ($SANDBOX_DOMAIN) -> 127.0.0.1:8080.
# Written by t3x-bootstrap.sh; certbot rewrites this file to add the
# certificate, exactly as it does for the other vhosts on this machine.
upstream opensandbox_api {
    server 127.0.0.1:8080;
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name $SANDBOX_DOMAIN;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://opensandbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;
        client_max_body_size 512m;
        client_body_timeout  300s;
        proxy_request_buffering off;
        proxy_buffering         off;
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
    }
}
EOF
    ln -sfn /etc/nginx/sites-available/sandbox.conf /etc/nginx/sites-enabled/sandbox.conf
  fi
  # \$connection_upgrade has to exist somewhere inside the http block.
  if ! grep -rqs "connection_upgrade" /etc/nginx/conf.d/ /etc/nginx/nginx.conf; then
    cat > /etc/nginx/conf.d/00-upgrade-map.conf <<'MAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
  fi

  nginx -t || die "nginx config is broken - nothing was reloaded"
  systemctl reload nginx
  for name in "$DOMAIN" "$SANDBOX_DOMAIN"; do
    if [ ! -d "/etc/letsencrypt/live/$name" ]; then
      certbot --nginx -d "$name" --non-interactive --agree-tos --redirect --keep-until-expiring 2>&1 | tail -4
      nginx -t && systemctl reload nginx
    else
      log "certificate for $name already present"
    fi
  done
  curl -fsS "https://$DOMAIN/health" >/dev/null && log "https://$DOMAIN answers" || warn "https://$DOMAIN/health did not answer"
  curl -fsS "https://$SANDBOX_DOMAIN/health" >/dev/null && log "https://$SANDBOX_DOMAIN answers" || warn "https://$SANDBOX_DOMAIN/health did not answer"
}

case "$TLS" in
  caddy) tls_caddy ;;
  nginx) tls_nginx ;;
  none)
    warn "something else owns 80/443 and no Caddy is installed:"
    ss -ltnp 2>/dev/null | grep -E ':(80|443)[[:space:]]' || true
    warn "left alone. Front 127.0.0.1:$PORT with your own proxy and a certificate for $DOMAIN."
    ;;
esac

if [ "${SKIP_FIREWALL:-0}" != 1 ] && have ufw && ufw status 2>/dev/null | grep -q "^Status: active"; then
  log "firewall: allowing 80, 443 and ssh"
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow OpenSSH >/dev/null
fi

# ------------------------------------------------------------- 8. doctor ---
log "doctor"
CLI doctor || warn "doctor reported a problem (see above)"

cat <<EOF

--------------------------------------------------------------------------
Done. Control plane: $WORKER_URL  (local http://127.0.0.1:$PORT)
Sandbox API: $OPENSANDBOX_API_URL  (image $OPENSANDBOX_IMAGE)
State: $STATE_DIR   Env: $ENV_FILE   Profile: $PROFILE_ID   Worker: $STATE_DIR/worker.tgz

Sandbox server:
  systemctl status opensandbox | journalctl -u opensandbox -f
  curl -s $OPENSANDBOX_API_URL/health
  curl -s -H "OPEN-SANDBOX-API-KEY: $OPENSANDBOX_API_KEY" $OPENSANDBOX_API_URL/v1/sandboxes

Reachability check from anywhere that can see this host:
  curl -s $WORKER_URL/health
  curl -s -H "authorization: Bearer $T3X_API_TOKEN" $WORKER_URL/profiles

T3 -> Settings -> Providers -> Add provider -> OpenSandbox, or paste this into
the server settings' providerInstances map:

{
  "providerInstances": {
    "opensandbox_backend": {
      "driver": "opensandbox",
      "displayName": "OpenSandbox (VPS)",
      "config": {
        "enabled": true,
        "controlPlaneUrl": "$WORKER_URL",
        "apiToken": "$T3X_API_TOKEN",
        "profileId": "$PROFILE_ID",
        "sandboxScope": "project",
        "agent": "$AGENT"
      }
    }
  }
}

Useful:
  systemctl status t3x | journalctl -u t3x -f
  t3x sandbox list ; t3x task list ; t3x task status <id> ; t3x task git <id>
  t3x doctor
Re-run this script any time: it updates the checkout and restarts the service.
--------------------------------------------------------------------------
EOF
