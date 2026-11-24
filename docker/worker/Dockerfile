# syntax=docker/dockerfile:1
# SlopBot thin forwarder image — the pod's MAIN container.
#
# SCOPE (designer decisions, 2026-11-24 — "thin forwarder" + "websocket
# transport"): NOT a JVM/element worker. A lightweight Node 22 forwarder that
# keeps the Twitch links alive (vendored live-half from the reference
# implementation), PUSHES every captured event over its websocket to each
# connected client (the ELM — websockets end to end), relays playback
# commands onward, and lingers ~10 minutes after stream end before exiting
# 0. No engine, no element artifacts, no JVM, no REST ingestion.
#
# The relay's verification imports the proxy's own OIDC modules (one
# implementation of the chain in this repo) — so the image carries proxy/lib
# (plus its dependency tree, installed from the proxy's locked manifest)
# alongside the forwarder sources. Build from the repo ROOT:
#   docker build -f docker/worker/Dockerfile .

# Pinned base — node 22 LTS, slim.
FROM node:22-slim

# The forwarder's runtime dependencies (ws — the only one) install from the
# committed lockfile, and the shared OIDC chain's (jose, undici) from the
# proxy's. Both deterministic.
COPY proxy/package.json proxy/package-lock.json /opt/slopbot/proxy/
COPY worker/package.json worker/package-lock.json /opt/slopbot/worker/
RUN cd /opt/slopbot/proxy && npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && cd /opt/slopbot/worker && npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY proxy/lib/ /opt/slopbot/proxy/lib/
COPY worker/ /opt/slopbot/worker/

# Non-root, fixed uid/gid (the chart pins runAsUser 10001 / runAsGroup 10001
# to match; the gid is shared across the pod's containers).
RUN groupadd --gid 10001 slopbot \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin slopbot \
    && chmod -R a+rX /opt/slopbot \
    && mkdir -p /workspace/slops \
    && chown -R 10001:10001 /workspace/slops

USER 10001:10001

# The relay webserver the ELM connects to (cluster-internal only — this pod
# never has a public endpoint; see docs/SPEC.md).
EXPOSE 8090

WORKDIR /opt/slopbot/worker
CMD ["node", "bin/forwarder.js"]
