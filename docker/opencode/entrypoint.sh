#!/usr/bin/env bash
# SlopBot OpenCode sidecar entrypoint.
#
# Loads the Hyper inference key from the mounted secret file into the env
# (the baked opencode.json references it via {env:HYPER_API_KEY}), prepares
# the writable state paths under the slop workdir, and execs `opencode serve`
# bound to 127.0.0.1 at the FIXED port — no port discovery, no other
# listener: the pod's security proxy is the only door, and it authenticates
# every request.

set -euo pipefail

log() { printf '{"ts":"%s","component":"slopbot-opencode","message":"%s"}\n' "$(date -u +%FT%TZ)" "$1"; }

if [ -z "${HYPER_INFERENCE_KEY_FILE:-}" ] || [ ! -f "$HYPER_INFERENCE_KEY_FILE" ]; then
  log "FATAL: HYPER_INFERENCE_KEY_FILE must point at the mounted Hyper key secret (got '${HYPER_INFERENCE_KEY_FILE:-unset}')"
  exit 1
fi
if [ ! -f "${OPENCODE_CONFIG:-}" ]; then
  log "FATAL: OPENCODE_CONFIG (${OPENCODE_CONFIG:-unset}) is missing — the image's baked model config is required"
  exit 1
fi

export HYPER_API_KEY
HYPER_API_KEY="$(tr -d '\r\n' < "$HYPER_INFERENCE_KEY_FILE")"

OPENCODE_BIN=/opt/opencode/.opencode/bin/opencode
if [ ! -x "$OPENCODE_BIN" ]; then
  log "FATAL: opencode binary not found at $OPENCODE_BIN"
  exit 1
fi

# Everything opencode writes lands under the one writable mount (the slop
# workdir emptyDir): its state home lives in a hidden subdir, the session's
# working directory is /workspace/slops itself.
mkdir -p \
  "${XDG_CACHE_HOME:-/workspace/slops/.opencode-state/cache}" \
  "${XDG_CONFIG_HOME:-/workspace/slops/.opencode-state/config}" \
  "${XDG_DATA_HOME:-/workspace/slops/.opencode-state/data}" \
  "${XDG_STATE_HOME:-/workspace/slops/.opencode-state/state}" \
  /workspace/slops/.slop-builds

log "serving OpenCode v2 on 127.0.0.1:${OPENCODE_PORT:-4096} (loopback only, behind the security proxy)"
cd /workspace/slops
exec "$OPENCODE_BIN" serve --port "${OPENCODE_PORT:-4096}" --hostname 127.0.0.1
