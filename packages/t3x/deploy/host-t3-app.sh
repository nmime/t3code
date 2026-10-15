#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# host-t3-app.sh - run the T3 Code app (server + web UI) on the same VPS as the
# t3x control plane, and point it at the control plane's OpenSandbox provider.
#
# Idempotent: re-running updates the checkout, rebuilds, rewrites the unit and
# restarts the service. Nothing is deleted.
#
# Usage
#   DOMAIN=t3.example.com ./host-t3-app.sh
#   DOMAIN=t3.example.com T3X_API_TOKEN=... ./host-t3-app.sh
#
# Variables (DOMAIN is required; the rest optional)
#   DOMAIN         public name for the app: the name the certificate is issued
#                  for (required; no default, same rule as t3x-bootstrap.sh)
#   PORT           port the app listens on, loopback (default: 8090)
#   APP_DIR        the checkout (default: /opt/t3code)
#   BASE_DIR       the app's base dir (default: /var/lib/t3app/.t3)
#   WORK_DIR       the workspace the project points at (default: /srv/t3-workspace)
#   T3X_URL        the control plane (default: https://t3code.<domain tail>)
#   PROFILE_ID     environment profile the provider instance uses (default: default)
#   AGENT          agent the provider instance asks for (default: echo)
#
# Two traps this script exists to encode:
#   - the app's settings file is <base-dir>/userdata/settings.json, not
#     <base-dir>/settings.json; a file in the wrong place is read by nothing and
#     the provider never appears.
#   - the node binary is often only reachable through a group (here: the
#     NodeSource install is 0750 root:nrb), so the service user has to be in it
#     or systemd answers `Failed to execute ... Permission denied`.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/t3code}"
BASE_DIR="${BASE_DIR:-/var/lib/t3app/.t3}"
HOME_DIR="$(dirname "$BASE_DIR")"
WORK_DIR="${WORK_DIR:-/srv/t3-workspace}"
PORT="${PORT:-8090}"
USER_NAME="${USER_NAME:-t3app}"
ETC_DIR=/etc/t3app
ENV_FILE="$ETC_DIR/env"
SETTINGS="$BASE_DIR/userdata/settings.json"
PROFILE_ID="${PROFILE_ID:-default}"
AGENT="${AGENT:-echo}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
# The vhost that serves $1 *and* proxies to the app. Matching on the name alone is
# not enough: another server block may answer that name (the control plane on the
# same host, say), and the name-only check then skipped writing the app's vhost and
# still reported success while nothing served the app.
# Prints the path, or nothing; always returns 0, because the caller assigns its
# output and `set -e` would abort on a non-zero substitution.
vhost_for_app() {
  local f
  for f in /etc/nginx/sites-enabled/*; do
    [ -f "$f" ] || continue
    grep -qsE "server_name[^;]*[[:space:]]$1([[:space:];]|$)" "$f" || continue
    grep -qsE "proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost):$PORT" "$f" && { printf '%s\n' "$f"; return 0; }
  done
  return 0
}

PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)}"
# No default: the certificate is issued for this name from its own DNS, so it has
# to be a name that really points here (see the note in t3x-bootstrap.sh).
if [ -z "${DOMAIN:-}" ]; then
  die "DOMAIN is required: the public name the app is served on, e.g. DOMAIN=t3.example.com. Point a DNS record at ${PUBLIC_IP:-this host} first; without DNS of your own, DOMAIN=${PUBLIC_IP//./-}.sslip.io resolves to this IP by itself."
fi
T3X_URL="${T3X_URL:-https://t3code.${DOMAIN#*.}}"
T3X_TOKEN="${T3X_API_TOKEN:-$(sed -n 's/^T3X_API_TOKEN=//p' /etc/t3x/env 2>/dev/null || true)}"
log "app https://$DOMAIN -> 127.0.0.1:$PORT | control plane $T3X_URL"
[ -n "$T3X_TOKEN" ] || { echo "no T3X_API_TOKEN: pass it, or install the control plane first"; exit 1; }

log "service user $USER_NAME"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$HOME_DIR" --shell /usr/sbin/nologin "$USER_NAME"
# The NodeSource install is group-readable only; without this the unit cannot
# even exec node.
NODE_GROUP="$(stat -c '%G' "$(readlink -f "$NODE_BIN")" 2>/dev/null || echo root)"
[ "$NODE_GROUP" != "root" ] && usermod -aG "$NODE_GROUP" "$USER_NAME"
mkdir -p "$BASE_DIR" "$WORK_DIR" "$ETC_DIR"
chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR" "$WORK_DIR"

log "build the app (web UI + server bundle)"
cd "$APP_DIR"
corepack pnpm install --filter "t3..." --filter "@t3tools/web..." --filter "." \
  --ignore-scripts --child-concurrency=1 --prefer-offline
corepack pnpm --filter @t3tools/web build
corepack pnpm --filter t3 build:bundle

log "environment file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# T3 Code server environment. Read by systemd (t3app.service). Keep it 0600.
HOME=$HOME_DIR
NODE_ENV=production
EOF
fi
chmod 600 "$ENV_FILE"
chown "$USER_NAME:$USER_NAME" "$ENV_FILE"

log "systemd unit t3app.service"
cat > /etc/systemd/system/t3app.service <<EOF
[Unit]
Description=T3 Code server (web UI; routes threads into OpenSandbox sandboxes via t3x)
After=network-online.target t3x.service
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$WORK_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/apps/server/dist/bin.mjs serve --host 127.0.0.1 --port $PORT --base-dir $BASE_DIR --no-browser
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$HOME_DIR $WORK_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q t3app

log "nginx vhost $DOMAIN -> 127.0.0.1:$PORT"
APP_VHOST="$(vhost_for_app "$DOMAIN")"
if [ -n "$APP_VHOST" ]; then
  log "a vhost already serves $DOMAIN -> 127.0.0.1:$PORT ($APP_VHOST); leaving it alone"
elif grep -rqs "server_name[^;]*[[:space:]]$DOMAIN" /etc/nginx/sites-enabled/; then
  die "$DOMAIN is answered by a server block that does not proxy to 127.0.0.1:$PORT ($(grep -rlsE "server_name[^;]*[[:space:]]$DOMAIN([[:space:];]|$)" /etc/nginx/sites-enabled/ | tr '\n' ' ')) - writing the app's vhost would leave two server blocks for one name. Point $DOMAIN at the app, or pass another DOMAIN."
else
  cat > /etc/nginx/sites-available/t3app.conf <<EOF
# T3 Code web app ($DOMAIN) -> 127.0.0.1:$PORT.
# Written by host-t3-app.sh; certbot rewrites this file to add the certificate.
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
        proxy_set_header Connection        \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;
        client_max_body_size 512m;
    }
}
EOF
  ln -sfn /etc/nginx/sites-available/t3app.conf /etc/nginx/sites-enabled/t3app.conf
fi
nginx -t
systemctl reload nginx
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring 2>&1 | tail -4
  nginx -t && systemctl reload nginx
fi

log "workspace repo"
if [ ! -d "$WORK_DIR/.git" ]; then
  sudo -u "$USER_NAME" git -C "$WORK_DIR" init -q -b main
  sudo -u "$USER_NAME" git -C "$WORK_DIR" -c user.name=t3app -c user.email=t3app@localhost \
    commit -q --allow-empty -m "scratch workspace for T3 Code threads"
fi

log "provider instance -> $SETTINGS"
systemctl stop t3app
mkdir -p "$(dirname "$SETTINGS")"
python3 - "$SETTINGS" "$T3X_TOKEN" "$T3X_URL" "$PROFILE_ID" "$AGENT" <<'PY'
import json, sys, pathlib
path, token, url, profile, agent = sys.argv[1:6]
p = pathlib.Path(path)
settings = json.loads(p.read_text()) if p.exists() and p.stat().st_size else {}
instances = settings.setdefault("providerInstances", {})
instances["opensandbox"] = {
    "driver": "opensandbox",
    "displayName": "OpenSandbox (VPS)",
    "enabled": True,
    "config": {
        "controlPlaneUrl": url,
        "apiToken": token,
        "profileId": profile,
        "sandboxScope": "project",
        "agent": agent,
    },
}
p.write_text(json.dumps(settings, indent=2) + "\n")
PY
chown "$USER_NAME:$USER_NAME" "$SETTINGS"

log "start"
systemctl restart t3app
sleep 10
systemctl is-active t3app
cd "$APP_DIR/apps/server"
sudo -u "$USER_NAME" -H "$NODE_BIN" dist/bin.mjs project add "$WORK_DIR" \
  --base-dir "$BASE_DIR" --title "Scratch workspace" 2>&1 | tail -2 || true
echo "local:  $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/)"
echo "public: $(curl -s -o /dev/null -w '%{http_code}' https://$DOMAIN/)"
echo
echo "Pair a browser with:"
echo "  cd $APP_DIR/apps/server && $NODE_BIN dist/bin.mjs pair --base-dir $BASE_DIR --ttl 24h"
echo "then open https://$DOMAIN/pair#token=<the token it prints>"
