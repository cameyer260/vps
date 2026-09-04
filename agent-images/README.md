# agent-images

Dockerfiles and tooling for the VPS pi agent containers. Lives inside the
`vps` monorepo — agent context and invariants: [AGENTS.md](../AGENTS.md);
the jarvis contract: [docs/jarvis.md](../docs/jarvis.md).

- `agent-pi.Dockerfile` — the single agent image: Ubuntu 24.04, a non-root
  `dev` user, the CLIs the skills call (`git`, `ripgrep`, `fd`, `jq`,
  `bx`), Playwright's bundled Chromium, Node, and
  `@earendil-works/pi-coding-agent` (needs Node `>=22.19.0`). No gh, no
  GitHub credentials — remote git ops go through the git bridge
  ([docs/jarvis.md](../docs/jarvis.md)).
- `build-images.sh` — builds the images; run as `dev` on the VPS.
- `jarvis.sh` / `jarvis-completion.bash` — the `jarvis` CLI wrapper and its
  bash completion.

## Layout / workflow

Source of truth is this monorepo (`cameyer260/vps`). On the VPS it is cloned to
`/home/dev/vps`, and the two scripts are symlinked onto the PATH:

```bash
git clone https://github.com/cameyer260/vps.git /home/dev/vps
mkdir -p ~/bin
ln -sfn /home/dev/vps/agent-images/jarvis.sh ~/bin/jarvis
ln -sfn /home/dev/vps/agent-images/build-images.sh ~/bin/build-images.sh
printf 'export PATH="$HOME/bin:$PATH"\n' >> ~/.bashrc
printf 'source /home/dev/vps/agent-images/jarvis-completion.bash\n' >> ~/.bashrc
```

Build the image (no sudo needed; `dev` is in the `docker` group):

```bash
jarvis build          # or: /home/dev/vps/agent-images/build-images.sh
```

Both scripts resolve their own directory via `realpath`, so the symlinks work
no matter where they point.

## Credentials (never baked in)

Credentials live on the host and are mounted or passed into containers at
runtime — never baked into image layers. The full table (pi auth, skills,
bx.env, gh) lives in [docs/vps.md](../docs/vps.md), including how to create
the `bx.env` env file once on the VPS.

## `jarvis` quick reference

`jarvis.sh` wraps the pi `docker run` command into one entrypoint. It
pre-creates a workspace if it doesn't exist (mkdir + `git init` when there is no
`.git` yet — dashboard agents rely on the repo existing).

Usage:

```bash
jarvis my-project                       # interactive pi TUI
jarvis my-project "refactor the auth"   # one-shot, prints and exits
jarvis rpc my-project [--session <f>]   # headless pi RPC daemon for the dashboard;
                                        #   prints the container ID
jarvis projects                         # list host projects
jarvis build                            # rebuild the image
```

The full contract — modes, container flags, labels, UID/GID resolution,
workspace/session mounts — is documented once in
[docs/jarvis.md](../docs/jarvis.md). The canonical `docker run` statements
(what jarvis invokes) are in [docker-run.md](docker-run.md). Every agent also
gets a short environment-context prompt (container awareness + workspace-only
policy) appended to pi's system prompt via `--append-system-prompt`.

## Versions (hardcoded in the Dockerfiles)

| Tool | Where it's defined | Version |
|---|---|---|
| Pi agent | `agent-pi.Dockerfile` npm install | `@earendil-works/pi-coding-agent@0.85.0` |
| Node (Pi) | `agent-pi.Dockerfile` `NODE_VERSION` | `v24.19.0` (LTS) |
| bx, git, rg, fd, jq, python3 | `agent-pi.Dockerfile` | from the Ubuntu 24.04 apt repo / their installers |

Upgrade by editing the exact version in the Dockerfile and rebuilding.

## Updating

To bump a tool, change its exact version in `agent-pi.Dockerfile` and re-run
`build-images.sh`.

## Playwright Chromium is baked in from the host

`build-images.sh` passes the host's already-downloaded Playwright Chromium bundle
at `/home/dev/.cache/ms-playwright/` to the build as an extra BuildKit
context (`--build-context ms-cache=...`), and `agent-pi.Dockerfile` does
`COPY --from=ms-cache chromium-* ...` directly from it. Nothing is copied into
or staged inside the repo, and the container never downloads Chromium at runtime.

**This relies on the host having Chromium installed at that location.** The
script checks for `chromium-*` and `chromium_headless_shell-*` under the cache
dir and refuses to build with a clear error if either is missing. If the host's
bundle is stale/missing, re-run the playwright skill setup on the host (it
downloads to `~/.cache/ms-playwright/`) and rebuild.

**Upgrading Playwright will break this** until you rebuild. The image bakes
in a *specific* revision (currently `chromium-1212`). If the pi-playwright
package (mounted from `~/.agents`) is upgraded and expects a newer revision,
the baked-in one won't match and the container will try to re-download (lost
on `--rm`) or error "browser not installed". Fix: re-run the skill setup on
the host so it downloads the new revision, then `build-images.sh` again.
