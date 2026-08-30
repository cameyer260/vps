# agent-images

Dockerfiles for the VPS pi agent container described in `vps-plan.md` Phase 7.

- `base.Dockerfile` — shared base: Ubuntu 24.04, a non-root `dev` user, and the
  CLIs the skills call (`git`, `ripgrep`, `fd`, `jq`, `gh`, `bx`).
- `agent-pi.Dockerfile` — base + Node + `@earendil-works/pi-coding-agent`.
  Pi is an npm package and needs Node at install and runtime (`>=22.19.0`).
- `build-images.sh` — builds the images; run as `dev` on the VPS.

## Layout / workflow

Source of truth is this Git repo. Clone it on the VPS under
`/home/dev/agent-images` (dev-owned, no sudo needed), then run the build script:

```bash
git clone <repo-url> /home/dev/agent-images
cd /home/dev/agent-images
chmod +x build-images.sh
./build-images.sh
```

## Credentials (never baked in)

OAuth tokens are mounted rw at runtime so the auto-refreshing sessions persist
on the host:

- Pi:      `-v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json`
- Skills:  `-v /home/dev/.agents:/home/dev/.agents:ro`  (whole dir; skill symlinks point into `packages/`)

Brave Search (`bx`) uses a host env file, not an image layer. Create it once
on the VPS as `dev`:

```bash
mkdir -p /home/dev/.config/bx
printf 'BRAVE_SEARCH_API_KEY=thekey\n' > /home/dev/.config/bx/bx.env
chmod 600 /home/dev/.config/bx/bx.env
```

Pass it on every `docker run` (on `agent-pi`):

```bash
--env-file /home/dev/.config/bx/bx.env
```

You log into Pi once with the auth mounts; the Brave key is the env file.

## Shortcuts: `jarvis`

`jarvis.sh` wraps the pi `docker run` command into one entrypoint. It
pre-creates a workspace if it doesn't exist. jarvis runs as `dev`, so the mkdir
already makes dev-owned dirs; Docker's plain `-v` on a missing dir would create
it as root, which the container's `dev` user can't write to.

Install on the VPS (put it on your PATH and add completion):

```bash
mkdir -p ~/bin
ln -s /home/dev/agent-images/jarvis.sh ~/bin/jarvis
ln -s /home/dev/agent-images/build-images.sh ~/bin/build-images.sh
printf 'export PATH="$HOME/bin:$PATH"\n' >> ~/.bashrc
printf 'source /home/dev/agent-images/jarvis-completion.bash\n' >> ~/.bashrc
```

Usage:

```bash
jarvis my-project                       # interactive pi TUI in /workspace
jarvis my-project "refactor the auth"   # one-shot, prints and exits
jarvis projects                         # list host projects
jarvis build                            # rebuild all images
```

`PROJECT` may be a bare name (resolved under `/home/dev/projects`) or an
absolute path. A `TASK` argument switches the container to one-shot mode.
Auth mounts (pi) are added only when the host files exist, and the
script warns otherwise. Override the project root with `AGENT_PROJECTS_DIR`.

## Versions (hardcoded in the Dockerfiles)

| Tool | Where it's defined | Version |
|---|---|---|
| Pi agent | `agent-pi.Dockerfile` npm install | `@earendil-works/pi-coding-agent@0.84.2` |
| Node (Pi) | `agent-pi.Dockerfile` `NODE_VERSION` | `v24.19.0` (LTS) |
| gh, bx, git, rg, fd, jq | `base.Dockerfile` | from the Ubuntu 24.04 apt repo / their installers |

Upgrade by editing the exact version in the Dockerfile and rebuilding.

## Updating

To bump a tool, change its exact version in the relevant Dockerfile and re-run
`build-images.sh`. Rebuild the base layer when you add CLIs
or skills dependencies.

## Playwright Chromium is baked in from the host

`build-images.sh` copies the host's already-downloaded Playwright Chromium
bundle from `/home/dev/.cache/ms-playwright/` into the image at build time
(`chromium-<rev>`, `chromium_headless_shell-<rev>`, `ffmpeg-<rev>`). The
Dockerfile then `COPY`s it to `/home/dev/.cache/ms-playwright/` inside the
image — the exact path Playwright checks at runtime — so the container never
downloads Chromium on each run.

**This relies on the host having Chromium installed at that location.** If the
host doesn't have it, `build-images.sh` refuses to build with a clear error.
If the host's bundle is stale/missing, re-run the playwright skill setup on
the host (it downloads to `~/.cache/ms-playwright/`) and rebuild.

**Upgrading Playwright will break this** until you rebuild. The image bakes
in a *specific* revision (currently `chromium-1212`). If the pi-playwright
package (mounted from `~/.agents`) is upgraded and expects a newer revision,
the baked-in one won't match and the container will try to re-download (lost
on `--rm`) or error "browser not installed". Fix: re-run the skill setup on
the host so it downloads the new revision, then `build-images.sh` again —
the script globs `chromium-*`, so no Dockerfile edit is needed.
