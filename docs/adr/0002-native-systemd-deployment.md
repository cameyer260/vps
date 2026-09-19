# Deploy the Rust dashboard as a native systemd user service, not a container

The current dashboard runs as a Docker container, which exists mostly to
solve "how do I ship a Node app" (and is why the AGENT_UID/AGENT_GID env
indirection exists — no dev user inside the container). A compiled Rust
binary needs none of that: deploy is a release binary run as `dev` under a
systemd user unit (lingering already enabled; pi-host-supervisor and the
git bridge prove the pattern), talking to `docker.sock` directly, spawning
`jarvis` from the real PATH, mounting nothing.

Trade-off accepted: the dashboard process loses its (nominal) container
isolation — it already had `docker.sock` (root-equivalent) and credentials
mounted, so the boundary bought little. Deploy becomes build, copy binary,
restart unit; the Cloudflare tunnel keeps pointing at localhost.

Superseded deployment details (container image, AGENT_UID/GID story) live in
docs/vps.md and dashboard/deploy.sh and get rewritten at cutover.
