# The image every t3x task sandbox runs in.
#
# OpenSandbox starts a container from this image and injects its agent (execd)
# into it; the control plane then uploads the worker bundle and runs it here.
# So the image needs what a task needs and nothing else: a Node runtime for the
# worker, git for checkpoints and worktrees, and a toolchain that can build a
# real repository.
#
# Build it where the lifecycle server runs:
#
#   docker build -t t3x-sandbox:latest packages/t3x/deploy/sandbox-image
#
# and point the deployment at it with OPENSANDBOX_IMAGE=t3x-sandbox:latest.

FROM node:24-slim

# git: checkpoints, worktrees, `git status` in the task.
# ca-certificates + curl: the sandbox clones repositories over TLS.
# procps: the worker and the control plane probe processes (`pgrep`).
# python3/make/g++: node-gyp, so `pnpm install` works in a task that needs it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        make \
        g++ \
        procps \
        python3 \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# The T3 fork builds with pnpm; corepack ships one with the Node image, but the
# version is pinned here so a task sees the same package manager the repo does.
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

# The coding agent the worker drives inside the sandbox: the `codex` runtime
# runs `codex exec "$PROMPT"` (see worker/ProviderRuntimeHost.ts), so the
# binary has to be on PATH here. Pinned on purpose — the CLI's flags and its
# wire protocol change between releases, and the runtime above was written
# against this one. `bubblewrap` is deliberately not installed: codex falls
# back to the copy it ships, and the container itself is the isolation boundary.
RUN npm install -g @openai/codex@0.162.1

# The second agent runtime the worker drives: `openclaw agent exec` is its
# one-shot headless turn (see worker/ProviderRuntimeHost.ts). Pinned for the
# same reason codex is — the flags and the wire format move between releases.
# `--allow-scripts=openclaw` is required: the package's own lifecycle script is
# what fetches its native pieces.
RUN npm install -g openclaw@2026.10.3 --allow-scripts=openclaw

# codex's model calls `apply_patch` through its shell tool, and the helper is the
# codex binary itself, dispatched on argv[0]. Without it on PATH every patch
# failed with "apply_patch: command not found" and the agent fell back to
# writing files with the shell — a whole extra round trip per edit, and a
# multi-hunk patch has no such fallback. Resolved by search because the vendor
# path carries the target triple (…/vendor/x86_64-unknown-linux-musl/bin/codex).
RUN CODEX_BIN="$(find "$(npm root -g)/@openai/codex/node_modules" -type f -path '*/bin/codex' | head -1)" \
    && test -n "$CODEX_BIN" \
    && ln -sf "$CODEX_BIN" /usr/local/bin/apply_patch \
    && printf '*** Begin Patch\n*** Add File: /tmp/.apply-patch-probe\n+ok\n*** End Patch\n' | apply_patch \
    && rm -f /tmp/.apply-patch-probe

# T3 Code's own defaults; a task's profile may override either.
ENV CI=1
ENV NODE_ENV=development

WORKDIR /workspace

# The container's entry process is replaced by OpenSandbox with
# `tail -f /dev/null` so the sandbox stays alive while the control plane drives
# it; this CMD is what runs if somebody starts the image directly.
CMD ["tail", "-f", "/dev/null"]
