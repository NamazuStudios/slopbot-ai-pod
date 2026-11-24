# syntax=docker/dockerfile:1
# SlopBot worker image — the pod's MAIN container (the actual bot).
#
# Carries the element worker artifacts (the worker jar + the built .elm),
# downloaded at build time from the slopbot-ai-element repo's GitHub release
# and pinned via the ELEMENT_RELEASE_TAG build-arg (a repo Variable in CI).
# A missing release or asset fails the BUILD loudly — never a silently
# stale image. Build from the repo ROOT: `docker build -f docker/worker/Dockerfile .`

# --- Artifact fetch stage ------------------------------------------------
FROM eclipse-temurin:21-jre-jammy AS artifacts

ARG ELEMENT_RELEASE_TAG
ARG ELEMENT_REPO=NamazuStudios/slopbot-ai-element
ARG ELEMENT_WORKER_ASSET=worker.jar
ARG ELEMENT_ELM_ASSET=element.elm

# Fail loud on an unset pin (the CI step checks the repo Variable first, but
# a local build without the arg must fail here just as clearly).
RUN if [ -z "$ELEMENT_RELEASE_TAG" ]; then \
      echo "FATAL: ELEMENT_RELEASE_TAG build-arg is empty — the worker image must pin an element release (set the ELEMENT_RELEASE_TAG repo Variable; see docs/SPEC.md)" >&2; \
      exit 1; \
    fi

RUN set -eu; \
    base="https://github.com/${ELEMENT_REPO}/releases/download/${ELEMENT_RELEASE_TAG}"; \
    curl -fsSL -o /tmp/worker.jar "${base}/${ELEMENT_WORKER_ASSET}" \
      || { echo "FATAL: ${base}/${ELEMENT_WORKER_ASSET} not found — release ${ELEMENT_RELEASE_TAG} is missing or does not carry the worker artifact" >&2; exit 1; }; \
    curl -fsSL -o /tmp/element.elm "${base}/${ELEMENT_ELM_ASSET}" \
      || { echo "FATAL: ${base}/${ELEMENT_ELM_ASSET} not found — release ${ELEMENT_RELEASE_TAG} is missing or does not carry the built element" >&2; exit 1; }

# --- Runtime stage ---------------------------------------------------------
FROM eclipse-temurin:21-jre-jammy

# Non-root, fixed uid/gid (the chart pins runAsUser 10001 / runAsGroup 10001
# to match; the gid is shared across the pod's containers so the shared slop
# workdir emptyDir stays group-writable).
RUN groupadd --gid 10001 slopbot \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin slopbot

COPY --from=artifacts /tmp/worker.jar /opt/slopbot/worker.jar
COPY --from=artifacts /tmp/element.elm /opt/slopbot/element.elm
COPY worker/slops-AGENTS.md /opt/slopbot/slops-AGENTS.md
COPY worker/entrypoint.sh /opt/slopbot/entrypoint.sh
RUN chmod 0755 /opt/slopbot/entrypoint.sh \
    && chmod -R a+rX /opt/slopbot \
    && mkdir -p /workspace/slops \
    && chown -R 10001:10001 /workspace/slops

USER 10001:10001

# The relay webserver the ELM connects to (cluster-internal only — this pod
# never has a public endpoint; see docs/SPEC.md).
EXPOSE 8090

ENTRYPOINT ["/opt/slopbot/entrypoint.sh"]
