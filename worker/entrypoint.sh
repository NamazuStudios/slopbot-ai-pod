#!/usr/bin/env bash
# SlopBot worker entrypoint — boots the element worker (WorkerMain) with the
# ELM-injected env, and exits 0 after the ~10-minute post-stream linger (the
# linger itself is the worker's own behavior; Conductor retries the job until
# a successful exit).
#
# Fail loudly and immediately on a missing piece of the injection contract:
# a half-configured bot that connects to Twitch anyway is worse than a dead
# pod Conductor visibly retries. Everything checked here is inside the
# allow-list (docs/SPEC.md "Env injection") — nothing else is read.

set -euo pipefail

log() { printf '{"ts":"%s","component":"slopbot-worker","message":"%s"}\n' "$(date -u +%FT%TZ)" "$1"; }

missing=()
for var in \
  SLOP_STREAMER \
  SLOP_CHANNEL \
  SLOP_MCP_URL \
  SLOP_OIDC_TOKEN \
  SLOP_PROXY_URL \
  SLOP_ELEMENTS_URL \
  SLOP_RELAY_PORT \
  HYPER_INFERENCE_KEY_FILE \
  SLOP_TWITCH_USERNAME \
  SLOP_TWITCH_OAUTH_TOKEN; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  log "FATAL: env injection contract incomplete — missing: ${missing[*]} (see docs/SPEC.md's allow-list)"
  exit 1
fi

if [ ! -f "$HYPER_INFERENCE_KEY_FILE" ]; then
  log "FATAL: HYPER_INFERENCE_KEY_FILE points at $HYPER_INFERENCE_KEY_FILE, which does not exist (the namespace secret must be mounted there)"
  exit 1
fi

# Seed the slop working directory the OpenCode sidecar lives in: the shared
# emptyDir mounts at /workspace/slops in BOTH containers. The worker lays
# down the agent contract (AGENTS.md) on first boot; nothing else is ever
# seeded — the agent downloads its own references via MCP. The baked copy is
# the element's contract; a copy already present from a previous dispatch or
# an ELM-fresher one wins.
mkdir -p /workspace/slops/.slop-builds
if [ ! -f /workspace/slops/AGENTS.md ] && [ -f /opt/slopbot/slops-AGENTS.md ]; then
  cp /opt/slopbot/slops-AGENTS.md /workspace/slops/AGENTS.md
  log "seeded /workspace/slops/AGENTS.md (agent contract)"
fi

log "booting WorkerMain for streamer ${SLOP_STREAMER} (relay on :${SLOP_RELAY_PORT}, proxy at ${SLOP_PROXY_URL})"

# The element worker owns the whole lifecycle from here — Twitch IRC + EventSub,
# the trigger loop, MCP persistence, the relay webserver, the post-stream linger,
# and the exit-0. No supervisor logic beyond exec: PID 1 signals flow straight
# to the JVM.
exec java -XX:MaxRAMPercentage=75.0 -jar /opt/slopbot/worker.jar
