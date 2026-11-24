# syntax=docker/dockerfile:1
# SlopBot OpenCode sidecar image — OpenCode v2 headless, loopback-only.
#
# `opencode serve` binds 127.0.0.1 at a FIXED port (default 4096 — no port
# discovery): the only thing that can reach it is the pod's own security
# proxy, which shares the network namespace. Hostile-by-construction workload
# (it eats Twitch chat and writes code) — so: non-root, read-only root
# filesystem, one writable directory (the slop workdir, mounted by the chart
# at /workspace/slops), model access only through the mounted Hyper key file.
#
# Build from the repo ROOT: `docker build -f docker/opencode/Dockerfile .`

# Pinned base — debian bookworm-slim, current as of the first pass; CI's
# digest-report step is where a digest pin gets recorded per build.
FROM debian:bookworm-slim

ARG OPENCODE_V2_VERSION=2.4.1
ARG OPENCODE_PORT=4096

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
    && rm -rf /var/lib/apt/lists/*

# OpenCode v2 from its own install channel, version-pinned (deterministic
# builds). Installs to $HOME/.opencode/bin/opencode; shared out read-only to
# all users.
RUN mkdir -p /opt/opencode \
    && export HOME=/opt/opencode \
    && curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "${OPENCODE_V2_VERSION}" \
    && chmod -R a+rX /opt/opencode

# Model config: Hyper (metered, the namespace secret mounted by the chart),
# via the OpenAI-compatible provider. The key is read from the file at the
# env-provided path by the entrypoint (never baked, never logged); the
# config only references it through the {env:VAR} substitution.
COPY docker/opencode/opencode.json /etc/slopbot/opencode.json
COPY docker/opencode/slops-AGENTS.md /etc/slopbot/slops-AGENTS.md
COPY docker/opencode/entrypoint.sh /usr/local/bin/slop-opencode-entrypoint
RUN chmod 0755 /usr/local/bin/slop-opencode-entrypoint \
    && chmod -R a+rX /etc/slopbot

# Non-root uid 10002 (the worker is 10001, the proxy 10003); shared GID
# 10001 so the group-writable slop workdir emptyDir works across containers.
# The read-only root filesystem is enforced by the chart's securityContext;
# everything this container writes (session state, caches) is redirected
# under the one writable mount.
RUN groupadd --gid 10001 slop \
    && useradd --uid 10002 --gid 10001 --no-create-home --shell /usr/sbin/nologin slopopencode \
    && mkdir -p /workspace/slops \
    && chown -R 10002:10001 /workspace/slops

USER 10002:10001

ENV HOME=/workspace/slops/.opencode-state/home \
    XDG_CACHE_HOME=/workspace/slops/.opencode-state/cache \
    XDG_CONFIG_HOME=/workspace/slops/.opencode-state/config \
    XDG_DATA_HOME=/workspace/slops/.opencode-state/data \
    XDG_STATE_HOME=/workspace/slops/.opencode-state/state \
    OPENCODE_CONFIG=/etc/slopbot/opencode.json \
    OPENCODE_PORT=${OPENCODE_PORT} \
    HYPER_INFERENCE_KEY_FILE=/run/secrets/hyper-inference-key

# Loopback-only: unreachable from outside the pod's network namespace — the
# security proxy is the sole door (and it authenticates every knock).
EXPOSE 4096

ENTRYPOINT ["/usr/local/bin/slop-opencode-entrypoint"]
