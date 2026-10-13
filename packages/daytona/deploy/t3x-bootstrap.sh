#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# t3x-bootstrap.sh - install the T3 Code + Daytona control plane on a VPS.
#
# Idempotent: re-running updates the checkout, repacks the worker and restarts
# the service. Nothing is deleted, and an existing web server on :80/:443 is
# never overwritten - the script says so and leaves it alone.
#
# Usage
#   DAYTONA_API_KEY=dtn_xxx ./t3x-bootstrap.sh                 # Daytona cloud
#   DAYTONA_API_KEY=xxx DAYTONA_API_URL=https://daytona.example.com/api \
#     DAYTONA_TARGET=eu ./t3x-bootstrap.sh                     # self-hosted Daytona
#   DOMAIN=t3x.example.com ./t3x-bootstrap.sh                  # own name + real cert
#
# Variables (all optional except a Daytona key, and only for the Daytona backend)
#   DAYTONA_API_KEY      organization API key
#   DAYTONA_API_URL      API root of the deployment (default: Daytona cloud)
#   DAYTONA_TARGET       default region
#   DOMAIN               public name for the control plane (default: <ip>.sslip.io)
#   T3X_API_TOKEN        bearer token T3 must present (default: generated)
#   REPO_URL, REPO_BRANCH, APP_DIR, STATE_DIR, PORT, PROFILE_ID, AGENT,
#   SNAPSHOT, IMAGE, TLS=auto|caddy|nginx|none, SKIP_FIREWALL=1
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/nmime/t3code}"
REPO_BRANCH="${REPO_BRANCH:-feat/daytona-sandboxes}"
APP_DIR="${APP_DIR:-/opt/t3code}"
STATE_DIR="${STATE_DIR:-/var/lib/t3x}"
SDK_DIR="${SDK_DIR:-/opt/t3x-sdk}"
ETC_DIR="/etc/t3x"
ENV_FILE="$ETC_DIR/env"
PORT="${PORT:-8087}"
PROFILE_ID="${PROFILE_ID:-default}"
AGENT="${AGENT:-echo}"
IMAGE="${IMAGE:-daytonaio/sandbox:0.9.0}"
SERVICE_USER="t3x"
# The monorepo's engines field wants ^24.13.1; the control plane itself needs
# >=22.5.0. 24 satisfies both.
NODE_MAJOR=24

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
CLI()  { ( cd "$APP_DIR" && node "$APP_DIR/packages/daytona/dist/src/cli.js" "$@" ); }

[ "$(id -u)" = 0 ] || die "run as root: sudo -i, then ./t3x-bootstrap.sh"

# ---------------------------------------------------------------- 0. facts ---
. /etc/os-release 2>/dev/null || true
log "host: ${PRETTY_NAME:-unknown} $(uname -m) | $(nproc) vcpu | $(awk '/MemTotal/{printf "%.1f GiB RAM", $2/1048576}' /proc/meminfo) | $(df -h / | awk 'NR==2{print $4}') free on /"

PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)}"
[ -n "$PUBLIC_IP" ] || die "could not determine the public IP; pass PUBLIC_IP=..."
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
WORKER_URL="${WORKER_URL:-https://$DOMAIN}"
log "public ip $PUBLIC_IP | control plane url $WORKER_URL"

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

log "installing @t3tools/daytona and its dependencies (monorepo, filtered)"
cd "$APP_DIR"
# `--filter "."` matters: typescript lives in the root devDependencies and
# `pnpm --filter @t3tools/daytona build` finds it through the root .bin.
$PNPM install --filter "@t3tools/daytona..." --filter "." --ignore-scripts --child-concurrency=1 --prefer-offline
log "building the control plane"
$PNPM --filter @t3tools/daytona build

# ------------------------------------------- 3. the Daytona SDK (runtime) ---
# Loaded dynamically, so it only has to be resolvable from the built package.
# Kept out of the checkout so the working tree stays clean.
log "Daytona SDK"
if [ ! -d "$SDK_DIR/node_modules/@daytonaio/sdk" ]; then
  mkdir -p "$SDK_DIR"
  ( cd "$SDK_DIR" && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund @daytonaio/sdk >/dev/null )
fi
mkdir -p "$APP_DIR/packages/daytona/node_modules/@daytonaio"
ln -sfn "$SDK_DIR/node_modules/@daytonaio/sdk" "$APP_DIR/packages/daytona/node_modules/@daytonaio/sdk"
log "@daytonaio/sdk $(node -p "require('$SDK_DIR/node_modules/@daytonaio/sdk/package.json').version")"

# ------------------------------------------------- 4. service user + env ---
log "service user and environment"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$ETC_DIR" "$STATE_DIR"

prev() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true; }
DAYTONA_API_KEY="${DAYTONA_API_KEY:-$(prev DAYTONA_API_KEY)}"
DAYTONA_API_URL="${DAYTONA_API_URL:-$(prev DAYTONA_API_URL)}"
DAYTONA_TARGET="${DAYTONA_TARGET:-$(prev DAYTONA_TARGET)}"
T3X_DAYTONA_DEFAULT_IMAGE="${T3X_DAYTONA_DEFAULT_IMAGE:-$(prev T3X_DAYTONA_DEFAULT_IMAGE)}"
T3X_DAYTONA_DEFAULT_IMAGE="${T3X_DAYTONA_DEFAULT_IMAGE:-$IMAGE}"
T3X_API_TOKEN="${T3X_API_TOKEN:-$(prev T3X_API_TOKEN)}"
T3X_API_TOKEN="${T3X_API_TOKEN:-$(openssl rand -hex 32)}"

cat > "$ENV_FILE" <<EOF
# t3x control plane environment - read by systemd (t3x.service). Keep it 0600.
DAYTONA_API_KEY=$DAYTONA_API_KEY
DAYTONA_API_URL=$DAYTONA_API_URL
DAYTONA_TARGET=$DAYTONA_TARGET
T3X_DAYTONA_DEFAULT_IMAGE=$T3X_DAYTONA_DEFAULT_IMAGE
T3X_API_TOKEN=$T3X_API_TOKEN
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
# doctor reads them from the environment; systemd reads them from the file.
export DAYTONA_API_KEY DAYTONA_API_URL DAYTONA_TARGET T3X_DAYTONA_DEFAULT_IMAGE T3X_API_TOKEN
[ -n "$DAYTONA_API_KEY" ] || warn "DAYTONA_API_KEY is empty - the control plane will fall back to the local backend. Put the key in $ENV_FILE and: systemctl restart t3x"

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
    RUNTIME_BLOCK="  # No snapshot: sandboxes come from \$T3X_DAYTONA_DEFAULT_IMAGE
  # ($IMAGE) and these resources are applied directly.
  resources:
    cpu: 2
    memoryGiB: 4
    diskGiB: 10"
  fi
  cat > "$PROFILE_FILE" <<EOF
apiVersion: t3-daytona/v1
kind: EnvironmentProfile
metadata:
  name: $PROFILE_ID
  version: 1
  description: Minimal profile generated by t3x-bootstrap.sh.
runtime:
$RUNTIME_BLOCK
project:
  workingDirectory: /home/daytona/project
  setup: []
environment:
  CI: "true"
agents:
  allowed: [echo, codex, claude, opencode]
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
    "$APP_DIR/packages/daytona/deploy/t3x-control-plane.service" > /etc/systemd/system/t3x.service

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
  if [ ! -f /etc/nginx/sites-available/t3x.conf ]; then
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
  nginx -t || die "nginx config is broken - nothing was reloaded"
  systemctl reload nginx
  if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring 2>&1 | tail -6
    nginx -t && systemctl reload nginx
  else
    log "certificate for $DOMAIN already present"
  fi
  curl -fsS "https://$DOMAIN/health" >/dev/null && log "https://$DOMAIN answers" || warn "https://$DOMAIN/health did not answer"
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
State: $STATE_DIR   Env: $ENV_FILE   Profile: $PROFILE_ID   Worker: $STATE_DIR/worker.tgz

Reachability check from anywhere that can see this host:
  curl -s $WORKER_URL/health
  curl -s -H "authorization: Bearer $T3X_API_TOKEN" $WORKER_URL/profiles

T3 -> Settings -> Providers -> Add provider -> Daytona, or paste this into
the server settings' providerInstances map:

{
  "providerInstances": {
    "daytona_backend": {
      "driver": "daytona",
      "displayName": "Daytona (VPS)",
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
