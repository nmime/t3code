# Putting T3 Code on a Mac and a phone

One server, many clients. The app on the VPS is the whole system — tasks,
sandboxes, agents — and a client is a window onto it. Nothing runs on the Mac or
the phone except the window.

Server: **https://t3.n0xeid.xyz** (app), control plane https://t3code.n0xeid.xyz,
sandboxes https://sandbox.n0xeid.xyz.

## Step 0 — mint one pairing link per client

On the VPS:

```bash
cd /opt/t3code
sudo -u t3app node apps/server/dist/bin.mjs pair \
  --base-dir /var/lib/t3app/.t3 --ttl 24h --label phone
```

It prints a QR code, a token, and a pairing URL **whose origin is the server's
own** — on this deployment that is `http://127.0.0.1:8090/pair#token=…`, because
the app listens on loopback behind nginx. Replace the origin with the public one
and hand that to the device:

```
https://t3.n0xeid.xyz/pair#token=<the token it printed>
```

The token lives in the URL _fragment_, so nginx never sees it in a request line.
It is **single use**: opening the link consumes it and mints that browser a
session the app lists by label, IP, user agent and device type. `--ttl` defaults
to 5 minutes and `--scope` defaults to the full set (orchestration, settings,
providers, filesystem, terminal, source control, preview), so mint one link per
device and treat it like a credential.

## Phone (a minute, no build)

1. Open the pairing link in Safari (iOS) or Chrome (Android).
2. Share → **Add to Home Screen**. The app is an installable PWA
   (`display: standalone`, own icon), so it opens full screen like a native app.
3. From then on, open it from the home screen icon.

That is the whole install. It talks to the same control plane as everything else:
start a thread, it becomes a task with its own sandbox, and the reply renders in
the thread.

## Mac (a minute, no build)

Open the pairing link in a browser. Done — same app, same server.

## Mac, native app (optional)

The desktop app is Electron and builds an unsigned `.dmg` from source. Do this on
the Mac, not on the VPS (electron-builder's `mac` target needs macOS).

```bash
git clone -b feat/opensandbox https://github.com/nmime/t3code.git
cd t3code
corepack enable && corepack prepare pnpm@11.10.0 --activate   # or use: npx --yes pnpm@11.10.0
pnpm install
pnpm dist:desktop:dmg:arm64      # Apple silicon; x64 for Intel, dist:desktop:dmg for universal
```

Node `^24.13.1` is required. The dmg lands under `dist/`; open it, drag the app
to Applications, and on first launch clear the quarantine flag Gatekeeper put on
an unsigned build:

```bash
xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"
```

Then paste the pairing link into the app's onboarding ("Connect your computers" →
direct pairing) or open it in the app's browser tab.

## iPhone, native app (optional, from source)

Only worth it if the PWA is not enough. On the Mac, with Xcode installed:

```bash
cd apps/mobile
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
pnpm run ios:release
```

A free Apple ID ("Personal Team") works with that opt-in; it drops the widget and
share extensions. `pnpm run ios:dev` builds the Metro-connected development
client instead. See `apps/mobile/README.md` for the fingerprint helper and the
EAS paths. This path is documented from the repository, not from a build we ran —
the PWA is the verified one.

## If a client will not connect

- **"Still connecting" forever, `/ws` 401 in the log**: the app is behind a
  reverse proxy that drops the port. nginx must send
  `proxy_set_header Host $http_host;` (not `$host`) — the app compares the origin
  and refuses cookie-carrying requests otherwise. The deployment's
  `/etc/nginx/sites-available/t3app-t3.conf` has it.
- **The pairing link says expired**: mint a new one; the TTL is per link.
- **The pairing link says already used**: it is single use, and the first device
  to open it consumed it. Mint one link per device.
- **The phone shows the desktop layout**: the PWA is the same app, not a mobile
  build; the native app is the only alternative.
