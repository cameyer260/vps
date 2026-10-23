---
name: ship
description: Ship this repo to the live admin site — commit any uncommitted work, push main, pull into the deploy checkout at ~/vps, rebuild, restart admin.service, and check it. Use when the owner says "ship", "ship it", "ship these changes", or "deploy" while working in this repo.
---

# Ship

Put what is in the dev checkout (`~/projects/vps`) live at
`admin.christophermeyer.dev`. Four steps in order: commit, push, pull,
redeploy. On the first failure, stop and report — never force a step through.

## 1. Commit

- `git status --short` and `git diff` — understand what changed.
- Run the gates from `dashboard/`:
  `cargo fmt --check && cargo clippy -- -D warnings && cargo test`
  (one heavy build at a time — 2 vCPU, no swap).
- If `assets/css/input.css` changed but `assets/css/app.css` was not rebuilt,
  rebuild it first:
  `tailwindcss -i assets/css/input.css -o assets/css/app.css`.
- `git add -A` and commit with a conventional message
  (`type(scope): summary`, imperative mood). Nothing to commit → say so and
  continue.

## 2. Push

`git push origin main`. Ship only from `main` in the dev checkout — the deploy
checkout tracks `main`. On a branch or in a worktree, report that and stop.

## 3. Pull into the deploy checkout

```bash
git -C /home/dev/vps status --short   # must be clean; if not, stop
git -C /home/dev/vps pull --ff-only
git -C /home/dev/vps rev-parse --short HEAD   # must equal the pushed commit
```

## 4. Redeploy and check

```bash
cd /home/dev/vps/dashboard && cargo build --release
systemctl --user restart admin.service
systemctl --user is-active admin.service   # active
# the unit can report active before the listener binds, so retry the check
curl -fsS --retry 20 --retry-delay 1 --retry-all-errors localhost:3000/health   # ok
```

`is-active` goes green the moment the unit starts, which can be before the port
is listening — so the health check retries for up to ~20s rather than failing on
the first refused connection. If it still fails, read
`journalctl --user -u admin.service -n 50 --no-pager`, report it, and stop.

## Rules

- Never change anything in Cloudflare.
- Port 3000 belongs to the service; don't start a dev server there.
- `assets/css/app.css` is committed; a deploy never runs Tailwind.
- Finish with one short report: the commit, and that it is live.