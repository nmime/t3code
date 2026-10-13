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

# T3 Code's own defaults; a task's profile may override either.
ENV CI=1
ENV NODE_ENV=development

WORKDIR /workspace

# The container's entry process is replaced by OpenSandbox with
# `tail -f /dev/null` so the sandbox stays alive while the control plane drives
# it; this CMD is what runs if somebody starts the image directly.
CMD ["tail", "-f", "/dev/null"]
