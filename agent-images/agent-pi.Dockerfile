# Pi agent image: base + Node LTS + the pi agent package.
# Provider config/auth is NOT baked in; it's mounted rw at runtime
# (~/.pi/agent/auth.json) so the auto-refreshing OAuth session persists.
FROM agent-base

USER root
# Node LTS v24.19.0 — official linux-x64 tarball (VPS is amd64).
ARG NODE_VERSION=v24.19.0
RUN curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

# Pi agent package v0.84.2
RUN npm install -g @earendil-works/pi-coding-agent@0.84.2

# Pre-create ~/.pi owned by dev. Docker creates missing bind-mount parents as
# root, so without this the runtime auth.json mount leaves /home/dev/.pi/agent
# root-owned and pi can't write sessions/ as the non-root dev user.
RUN mkdir -p /home/dev/.pi/agent && chown -R dev:dev /home/dev/.pi

USER dev
