---
name: commit-push
description: Quick stage-commit-push workflow for this project. Use whenever the user asks to commit and push changes (e.g. "commit and push", "save this to git"), after making changes to notes or project files.
---

# Commit & push

Stage, commit, and push the current work. Multiple agents may work in this
directory concurrently — there is no lease or lock; just follow the steps
below exactly and keep the commit small and scoped to your task.

1. Check what changed:

   ```bash
   git status --porcelain
   git diff --stat
   ```

2. Stage everything relevant to your task:

   ```bash
   git add -A
   ```

   If files unrelated to your task are dirty (another agent's work in
   progress), stage only your files instead.

3. Commit with a concise, descriptive message (one line, imperative mood,
   no attribution footers):

   ```bash
   git commit -m "<what changed and why, briefly>"
   ```

4. Push immediately:

   ```bash
   git push
   ```

5. Report the result: commit subject + short hash, and the push outcome. If
   the push fails (e.g. remote rejected because of concurrent pushes), run
   `git pull --rebase` and push again; if that conflicts, stop and report the
   conflict instead of resolving it blindly.

Rules:

- Never rewrite history (`--force`, `reset --hard` to remote) unless the user
  explicitly asks.
- Never commit secrets (keys, tokens, credentials).
- If the working tree was already dirty before you started and you did not
  make those changes, mention it in your report.
