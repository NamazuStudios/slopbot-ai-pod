# SlopBot AI Pod — Implementation SPEC (first pass)

The design of record is the **AI Slop Bot design notebook** (Namazu Cloud); this file is the distilled implementation contract. Binding decisions from the designer (2026-11-24) are marked **(binding)**.

## What this repo ships

The **per-stream agent pod** — three containers + the Helm chart that deploys them:

1. **Worker** (main container) — the actual bot: monitors the streamer's Twitch chat/EventSub, evaluates triggers, triggers slops directly, persists via the ELM's MCP surface. Runs the Kotlin element in worker mode (the worker module of `NamazuStudios/slopbot-ai-element` — JVM image carrying the built element artifacts).
2. **OpenCode sidecar** — OpenCode v2 headless (`opencode serve`), listening on **localhost only** at a fixed port. Hostile-by-construction workload (it eats Twitch chat and writes code).
3. **Security proxy** — exposes OpenCode's API **to the ELM application**: the ELM connects headlessly to the agent THROUGH the proxy to perform inference. Validates the ELM's OIDC token (signature/issuer/audience/expiry) against the bound Elements instance whose URL comes from an injected env var.

Plus: **Helm chart** deploying the pod templates compliant with **Namazu Conductor's annotations** (binding), the GitHub Actions workflow building/pushing images to **ghcr** (binding), and the network policy + env-injection contract.

## Binding decisions

- **Image: built in GitHub Actions, stored in ghcr for now.**
- **Sizing: follow `NamazuStudios/namazu-agent` guidelines** (the agent pod's shapes work — mirror its resources).
- **No mock agent.** Removed by decision — nothing in this repo fakes builds.
- **Model access: the namespace-provided secret containing the Hyper inference key** (metered properly). Per-streamer token accounts/monetization come later.
- **Pod = a Conductor job with several retries until successful exit** — the bot tolerates pod preemption.
- **The pod never has a public IP or endpoint; the ELM is the go-between.** All viewer/streamer traffic terminates at the ELM.
- **Env injection:** the ELM issues Conductor instructions that inject the pod's environment at dispatch — the instance-OIDC token, the MCP endpoint, OpenCode workdir/model config, the Hyper key secret reference, the Elements instance URL — **and nothing else** (the allow-list is the injection list).
- **`automountServiceAccountToken: false`**; no cloud/cluster credentials ever enter the pod.
- **Data authority is the ELM's APIs** — the pod's working directories are scratch only.
- **Reading chat via a proxied local tool is allowed later** (do not preclude; same OIDC validation) — extensibility note from the proxy plan, not v1 scope.

## Repository layout

```
slopbot-ai-pod/
  docker/
    worker/Dockerfile         # JVM worker image (carries the element worker artifacts)
    opencode/Dockerfile       # OpenCode v2 headless sidecar
    proxy/Dockerfile          # the security proxy (Node 22, no build step beyond npm ci)
  proxy/                      # proxy sources (see below)
  worker/                     # worker bootstrap (entrypoint + config; the Kotlin artifacts come from the element repo's releases)
  helm/slopbot-pod/           # the chart (see below)
  k8s/networkpolicy.yaml      # pod network policy (metadata block, cluster deny)
  .github/workflows/build.yml # build + push images to ghcr
  docs/SPEC.md                # this file
```

## Container specs

### Worker (main container)

- Base: `eclipse-temurin:21-jre` (slim); non-root uid (10001).
- Runs: the element **worker** — a JVM process (`WorkerMain` from `NamazuStudios/slopbot-ai-element`'s worker module; the jar + the built `.elm` are copied in at image build from the element repo's release artifacts, with the version pinned at build time).
- Entrypoint env (all injected by the ELM via Conductor at dispatch — the allow-list):
  - `SLOP_STREAMER` (the tenant login), `SLOP_CHANNEL`
  - `SLOP_MCP_URL` (the ELM's MCP endpoint), `SLOP_OIDC_TOKEN` (instance-OIDC token — short-lived; rotated by the ELM while live)
  - `SLOP_PROXY_URL` (the in-pod proxy address for inference), `SLOP_ELEMENTS_URL` (the bound instance, for OIDC verification)
  - `SLOP_TWITCH_*` (the streamer's Twitch credentials — from the Hyper/namespace secret or the ELM-injected secret)
  - `HYPER_INFERENCE_KEY_FILE` (path to the mounted Hyper key secret — metered model access)
  - `SLOP_RELAY_PORT` (the lightweight webserver port the ELM connects to)
- **No Kubernetes service-account token** (`automountServiceAccountToken: false`), no cloud keys, no DB URLs.
- Behavior: connect Twitch IRC (keepalive ping every 15s; force-reconnect when pongs stop) + EventSub; evaluate triggers against the ELM-owned state via MCP; trigger slops directly (dispatch to the playback queue through the ELM APIs); drive inference **through the pod-local proxy**; serve the lightweight relay webserver (events out, OIDC-verified); **linger ~10 minutes after stream end, then exit 0**.
- Resources: mirror `namazu-agent`'s worker shapes (requests ≈ 500m CPU / 512Mi unless measurement says otherwise; document the numbers in the chart's values).

### OpenCode sidecar

- Base image: OpenCode v2 headless — `opencode serve` bound to `127.0.0.1:<fixed port>` (default 4096; fixed — NO discovery).
- Non-root uid; read-only root filesystem except the slop working directory (`/workspace/slops` mount: `AGENTS.md` contract + `.slop-builds/<id>/` scratch — **nothing else is seeded**; the agent downloads references via MCP at its discretion into this locked working copy).
- Model access: the OpenCode model config points at **Hyper** using the mounted `HYPER_INFERENCE_KEY_FILE` (the namespace secret — metered).
- Env: only the allow-list (OpenCode's own workdir/model config). No SA token, no cluster access, no metadata route.

### Security proxy

- Node 22 (no framework heavier than needed — plain `http` + `undici`), non-root.
- **Upstream:** `http://127.0.0.1:<opencode-port>` — OpenCode's localhost API. The proxy *just* proxies calls to it.
- **Auth:** every request must carry an OIDC bearer token minted by the bound Elements instance. Validate per call: signature (JWKS cached from `<SLOP_ELEMENTS_URL>/.well-known/openid-configuration` → `jwks_uri`, short TTL), issuer (the instance), audience (this pod), expiry. `401` missing/invalid/foreign-instance/expired; `403` valid-but-wrong-scope.
- **Fail closed:** proxy error paths deny; never pass through unauthenticated requests; never modify inference results.
- **Rotation-aware:** new tokens accepted immediately (issuer-key cache TTL, no restart).
- **Extensibility (not v1):** the route table stays open for local pod-control tooling for the agent (e.g. reading chat) — same OIDC validation.
- Health endpoints (`/healthz`, `/readyz`) are the ONLY unauthenticated routes.

## Helm chart (`helm/slopbot-pod/`)

Chart: `slopbot-pod`, templating **the pod template dispatched by the ELM through Conductor's common APIs (kubernetes driver)**. Conductor compliance requirements (mirror `namazu-agent`'s chart shapes):

- Pod template labels/annotations for Conductor visibility (`namazu.conductor/*` — copy the annotation set from the namazu-agent chart: display-name, description, job-set if present).
- Three containers (worker, opencode, proxy) per the specs above.
- `automountServiceAccountToken: false`; `securityContext` non-root, read-only rootfs where the spec says; the slop working dir as an `emptyDir` mount.
- NetworkPolicy (same template directory): default-deny ingress/egress for the pod except: worker→ELM (MCP/REST), ELM→proxy (ingress on the proxy port), worker→Twitch IRC/EventSub endpoints, proxy→OpenCode (localhost, not a network policy matter), explicit **deny to `169.254.169.254`** and cluster-internal ranges, DNS egress.
- Secrets: the Hyper inference key referenced by name (the namespace secret — `externalSecret`-style reference, not embedded); the injected env (token/MCP URL/etc.) arrives via Conductor's dispatch, not the chart — the chart defines the pod shape only.
- Values: image repositories/tags (ghcr paths), resource requests/limits per the namazu-agent guidelines, ports, the Conductor annotation values.

## CI (`.github/workflows/build.yml`)

- Triggers: push to `main`, PRs to `main`, workflow_dispatch.
- Jobs: (1) lint/test the proxy (`npm ci && npm test` — validation matrix unit tests), (2) build the three images and push to `ghcr.io/namazustudios/<image>:<tag>` on main pushes (immutable `sha-<commit>` tags + `latest` only on main), (3) helm lint + `helm template` sanity (the rendered pod template must carry the Conductor annotations — assert it in CI), (4) digest report step (print pushed digests — the platform pins by digest or sha tag; never by floating tag).
- The worker image build: fetch the pinned element worker artifacts from the element repo's GitHub release (`slopbot-ai-element` release assets) — pin by release tag in a repo Variable; fail loudly if the release is missing.

## Tests that must pass before review

1. **Proxy validation matrix (unit):** valid token → forward; none/expired/foreign-issuer → 401; wrong audience → 403; JWKS cache TTL honored; fail-closed on upstream error.
2. **Proxy forwarding (integration, local):** a stub OpenCode upstream receives the proxied call with identity headers attached.
3. **Chart sanity:** `helm template` renders a pod with 3 containers, `automountServiceAccountToken: false`, the Conductor annotations, the network policy attached; values overrides honored.
4. **Worker entrypoint (smoke):** boots with the allow-listed env, connects to a stub Twitch IRC (scripted), evaluates one trigger, calls the stub MCP endpoint, exits 0 on the linger timer.
