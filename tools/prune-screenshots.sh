#!/usr/bin/env bash
# prune-screenshots.sh — delete screenshots older than retention.
#
# Inbox: ${SCREENSHOTS_DIR:-/home/dev/screenshots} (scp target for the Mac
# screenshot tool; mounted read-only into every jarvis agent). Runs daily via
# prune-screenshots.timer (systemd --user). Retention defaults to 7 days;
# override with SCREENSHOTS_RETENTION_DAYS (or EnvironmentFile, see the
# .service unit). Exits quietly when the inbox does not exist yet.
set -euo pipefail

DIR="${SCREENSHOTS_DIR:-/home/dev/screenshots}"
DAYS="${SCREENSHOTS_RETENTION_DAYS:-7}"

[[ -d "$DIR" ]] || exit 0

# Safety: never run against /, $HOME, or an empty path. -mindepth 1 below
# also guarantees $DIR itself is never removed.
case "$DIR" in
  ""|"/"|"$HOME"|"/home/dev") echo "prune-screenshots: refusing to prune '$DIR'" >&2; exit 1 ;;
esac

deleted=$(find "$DIR" -mindepth 1 -type f -mtime +"$DAYS" -print -delete | wc -l)
find "$DIR" -mindepth 1 -type d -empty -delete 2>/dev/null || true
echo "prune-screenshots: deleted $deleted file(s) older than $DAYS day(s) in $DIR"
