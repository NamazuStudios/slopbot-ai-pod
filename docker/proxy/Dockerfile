# syntax=docker/dockerfile:1
# SlopBot security proxy image — Node 22, no framework (plain http + undici).
#
# Exposes the pod-local OpenCode API to the ELM application, gated on the
# ELM's OIDC bearer token. Fails closed on every error path; /healthz and
# /readyz are the only unauthenticated routes.
#
# Build from the repo ROOT: `docker build -f docker/proxy/Dockerfile .`

# Pinned base — node 22 LTS, bookworm-slim. The proxy writes nothing: the
# chart enforces a read-only root filesystem.
FROM node:22-bookworm-slim

WORKDIR /opt/slopbot-proxy

# npm ci with the committed lockfile — the only build step (deterministic).
COPY proxy/package.json proxy/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY proxy/server.js ./
COPY proxy/lib/ ./lib/

# Non-root uid 10003 (worker 10001, opencode 10002); shared GID 10001.
RUN groupadd --gid 10001 slop \
    && useradd --uid 10003 --gid 10001 --no-create-home --shell /usr/sbin/nologin slopproxy \
    && chown -R 10003:10001 /opt/slopbot-proxy

USER 10003:10001

ENV NODE_ENV=production

# The proxy's listen port — the ONLY port the ELM reaches for inference.
EXPOSE 8080

CMD ["node", "server.js"]
