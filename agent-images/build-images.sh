#!/usr/bin/env bash
# Build the shared base + thin agent images.
#
# Run as `dev` on the VPS (dev is in the docker group, so no sudo needed).
set -euo pipefail
# Resolve to the real script location even when invoked via a symlink (jarvis
# installs ~/bin/build-images.sh as a link into agent-images).
cd "$(dirname "$(realpath "$0")")"

# Host dev's uid/gid get baked into the base image's `dev` user.
DEV_UID=$(id -u)
DEV_GID=$(id -g)

# The host's Playwright Chromium bundle is passed to the base build as an extra
# BuildKit context (`ms-cache`, consumed by COPY --from in base.Dockerfile), so
# nothing is copied or staged inside the repo. Bail if a required browser dir
# is missing (version drift vs installed pw-core).
MS_CACHE=/home/dev/.cache/ms-playwright
for name in chromium chromium_headless_shell; do
  ls -d "$MS_CACHE"/${name}-* >/dev/null 2>&1 || {
    echo "build-images: no ${name}-* under $MS_CACHE (install Chromium first)" >&2
    exit 1
  }
done

echo "==> Baking Playwright browsers from $MS_CACHE (ms-cache build context)"

echo "==> Building agent-base (dev uid=$DEV_UID gid=$DEV_GID)"
docker build --build-arg DEV_UID="$DEV_UID" --build-arg DEV_GID="$DEV_GID" \
  --build-context ms-cache="$MS_CACHE" \
  -f base.Dockerfile -t agent-base .

echo "==> Building agent-pi"
docker build -f agent-pi.Dockerfile -t agent-pi .


echo
echo "==> Images:"
docker images | grep -E '^(REPOSITORY|agent-)'
