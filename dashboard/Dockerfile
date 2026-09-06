# syntax=docker/dockerfile:1

# ---- build stage: compile SPA + server bundle -------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----------------------------------------------------------------
# Runs as the host dev user (see deploy.sh: --user/--group-add). Needs the
# docker CLI (jarvis.sh builds `docker run` commands; dockerode itself uses the
# socket directly), git (host-side git ops + jarvis workspace autocreate), gh
# (git remote auth — the mounted ~/.gitconfig points the credential helper at
# it, the token itself comes from the ro-mounted ~/.config/gh), and bash +
# coreutils (jarvis.sh).
FROM node:24-bookworm-slim
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — official Debian/Ubuntu apt repo
# https://github.com/cli/cli/blob/trunk/docs/install_linux.md#debian
# Keyring SHA256 from that page (binary githubcli-archive-keyring.gpg).
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b  /etc/apt/keyrings/githubcli-archive-keyring.gpg" \
      | sha256sum -c - \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh \
 && rm -rf /var/lib/apt/lists/*

# pi CLI — the /api/models route runs `pi --list-models` for the model
# picker's "all models" source. Pinned to the agent-pi image's version.
RUN npm install -g @earendil-works/pi-coding-agent@0.85.0 \
 && npm cache clean --force

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/dev \
    PORT=3000 \
    WWW_DIR=/app/dist

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

# Real identity comes from deploy.sh (--user, AGENT_UID/GID); this is only a
# sane placeholder so bare `docker run` doesn't run as root.
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist-server/index.js"]
