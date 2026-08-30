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

# Stage the host's already-downloaded Playwright Chromium bundle into the build
# context so base.Dockerfile can COPY it into the image. Keeps the container
# from re-downloading Chromium on every run.
STAGE=.ms-playwright-stage
MS_CACHE=/home/dev/.cache/ms-playwright
rm -rf "$STAGE"
mkdir -p "$STAGE"
staged=0
for d in "$MS_CACHE"/chromium-* "$MS_CACHE"/chromium_headless_shell-* "$MS_CACHE"/ffmpeg-*; do
  [ -e "$d" ] || continue
  cp -r "$d" "$STAGE/$(basename "$d")"
  staged+=1
done
if [[ "$staged" -eq 0 ]]; then
  echo "build-images: no Playwright browsers found under $MS_CACHE (install Chromium first)" >&2
  exit 1
fi
# Bail if a required browser dir is missing (version drift vs installed pw-core).
for name in chromium chromium_headless_shell; do
  matched=0
  for d in "$STAGE"/${name}-*; do
    if [[ -e "$d" ]]; then matched=1; break; fi
  done
  if [[ "$matched" -eq 0 ]]; then
    echo "build-images: staged browsers missing '$name' — re-run Playwright install on host" >&2
    exit 1
  fi
done

echo "==> Staged Playwright Chromium bundle ($staged dirs) from $MS_CACHE"

echo "==> Building agent-base (dev uid=$DEV_UID gid=$DEV_GID)"
docker build --build-arg DEV_UID="$DEV_UID" --build-arg DEV_GID="$DEV_GID" \
  -f base.Dockerfile -t agent-base .

echo "==> Building agent-pi"
docker build -f agent-pi.Dockerfile -t agent-pi .

# Drop the staged bundle now that the images are built.
rm -rf .ms-playwright-stage


echo
echo "==> Images:"
docker images | grep -E '^(REPOSITORY|agent-)'
