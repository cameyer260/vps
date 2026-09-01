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
# socket directly), git (host-side git ops + jarvis workspace autocreate), and
# bash + coreutils (jarvis.sh).
FROM node:24-bookworm-slim
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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
