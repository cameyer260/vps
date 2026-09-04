# syntax=docker/dockerfile:1
# The pi agent image (single-stage; no separate base image anymore).
#
# Provides a non-root `dev` user (matching the host's dev uid/gid via build
# args), the common CLIs the skills call (git, ripgrep, fd, jq, bx),
# Playwright's bundled Chromium, Node LTS, and @earendil-works/pi-coding-agent.
# The playwright package lives inside the skills dir and is NOT installed here.
#
# No GitHub credentials or gh CLI: remote git ops (push/fetch/pull) go through
# the host-side git bridge socket — see docs/jarvis.md. Git *identity* is
# baked below (it is not a secret).
#
# Provider config/auth is NOT baked in; it's mounted rw at runtime
# (~/.pi/agent/auth.json) so the auto-refreshing OAuth session persists.
ARG UBUNTU=24.04
FROM ubuntu:${UBUNTU}

# UID/GID of the host `dev` account. The runtime `--user "$(id -u dev):$(id -g dev)"`
# flag is what really enforces file ownership on the host, but baking matching
# ids keeps the image sane when that flag is absent.
ARG DEV_UID=1000
ARG DEV_GID=1000

ENV DEBIAN_FRONTEND=noninteractive

# Bundled Chromium's system library deps (Playwright docs, Ubuntu 24.04/noble set).
# Ubuntu renames 64-bit packages with a `t64` suffix; `libasound2` is a virtual
# package that must be spelled `libasound2t64`. Without these, Chromium exits
# immediately with a missing .so error (exitCode 127).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      git ripgrep fd-find jq unzip xz-utils \
      libasound2t64 \
      libatk-bridge2.0-0t64 \
      libcups2t64 \
      libdbus-1-3 \
      libdrm2 \
      libegl-mesa0 \
      libfontconfig1 \
      libglib2.0-0t64 \
      libgtk-3-0t64 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpulse0 \
      libspeechd2 \
      libx11-6 \
      libxcb1 \
 && rm -rf /var/lib/apt/lists/*

# Ubuntu's fd-find ships the binary as `fdfind`; skills expect `fd`.
RUN ln -s "$(command -v fdfind)" /usr/local/bin/fd

# Non-root user. Runtime also overrides to host dev via --user.
# ubuntu:24.04 ships a stock `ubuntu` user/group at uid/gid 1000, which collides
# with the host dev ids we bake in. The stock account is disposable (empty home,
# no credentials), so remove it first, then create dev at the host's ids.
RUN userdel -r ubuntu 2>/dev/null || true \
 && groupdel ubuntu 2>/dev/null || true \
 && groupadd -g ${DEV_GID} dev \
 && useradd -m -u ${DEV_UID} -g dev -s /bin/bash dev

# Git identity for agent commits. Not a credential — the gh token stays on
# the host; only this identity lands in commits. Matches the host .gitconfig
# (docs/vps.md); per-repo local config can still override.
RUN git config --system user.name "Christopher Meyer" \
 && git config --system user.email "cameyer06@gmail.com"

# bx (Brave Search CLI) — a downloaded CLI tool the skills call from bash.
# Runs as dev so it lands in ~/.local/bin (picked up by PATH below).
# API key is NOT in the image. On the VPS, once:
#   mkdir -p /home/dev/.config/bx
#   printf 'BRAVE_SEARCH_API_KEY=thekey\n' > /home/dev/.config/bx/bx.env
#   chmod 600 /home/dev/.config/bx/bx.env
# Then every docker run:
#   --env-file /home/dev/.config/bx/bx.env
USER dev
RUN curl -fsSL https://raw.githubusercontent.com/brave/brave-search-cli/main/scripts/install.sh | sh
USER root

# Bake Playwright's bundled Chromium into the image straight from the host's
# ~/.cache/ms-playwright (mounted as the `ms-cache` build context by
# build-images.sh), so the container never re-downloads Chromium on every run.
# No staging/copying into the repo happens at all.
RUN mkdir -p /home/dev/.cache/ms-playwright
COPY --from=ms-cache chromium-* chromium_headless_shell-* ffmpeg-* /home/dev/.cache/ms-playwright/
RUN chown -R dev:dev /home/dev/.cache

ENV HOME=/home/dev
ENV PATH="/home/dev/.local/bin:$PATH"
# Always use Playwright's bundled Chromium, never hunt for system Chrome.
ENV PLAYWRIGHT_MCP_BROWSER=chromium
WORKDIR /workspace

# Node LTS v24.19.0 — official linux-x64 tarball (VPS is amd64).
# Pi is an npm package and needs Node at install and runtime (>=22.19.0).
ARG NODE_VERSION=v24.19.0
RUN curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

# Pi agent package v0.85.0
RUN npm install -g @earendil-works/pi-coding-agent@0.85.0

# Pre-create ~/.pi owned by dev. Docker creates missing bind-mount parents as
# root, so without this the runtime auth.json mount leaves /home/dev/.pi/agent
# root-owned and pi can't write sessions/ as the non-root dev user.
RUN mkdir -p /home/dev/.pi/agent && chown -R dev:dev /home/dev/.pi

USER dev
