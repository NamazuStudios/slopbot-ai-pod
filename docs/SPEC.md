# SlopBot AI Pod — Implementation SPEC (first pass)

The design of record is the **AI Slop Bot design notebook** (Namazu Cloud); this file is the distilled implementation contract. Binding decisions from the designer (2026-11-24) are marked **(binding)**.

## What this repo ships

The **per-stream agent pod** — three containers + the Helm chart that deploys them:

1. **Worker** (main container) — the **thin Node forwarder**: keeps the streamer's Twitch chat/EventSub connections alive, captures chat lines/events/redemptions, and pushes every event over its OIDC-gated websocket to the ELM. It is NOT an element copy and has NO engine — all trigger evaluation, cooldowns, queues, and playback are ELM-side (the Kotlin element).
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
    worker/Dockerfile         # the thin Node forwarder image
    opencode/Dockerfile       # OpenCode v2 headless sidecar
    proxy/Dockerfile          # the security proxy (Node 22, no build step beyond npm ci)
  proxy/                      # proxy sources (see below)
  worker/                     # the thin forwarder (Node 22, no runtime deps): the Twitch
                              # live-half is VENDORED from the reference implementation
                              # (`NamazuStudios/slopbot-ai` lib/slop.js + lib/eventsub.js,
                              # cited in-file; behavior byte-compatible)
  helm/slopbot-pod/           # the chart (see below)
  k8s/networkpolicy.yaml      # pod network policy (metadata block, cluster deny)
  .github/workflows/build.yml # build + push images to ghcr
  docs/SPEC.md                # this file
```

## Container specs

### Worker (main container — thin forwarder)

- Base: `node:22-slim`; non-root uid (10001). No JVM, no element artifacts.
- Runs: the **thin forwarder** (`worker/bin/forwarder.js`, Node 22; its one runtime dependency is `ws` for the websocket server). Duties ONLY:
  - keep the Twitch connections alive (chat IRC over `wss://irc-ws.chat.twitch.tv:443` — anonymous `justinfan` login, keepalive ping every 15s, force-reconnect when pongs stop; EventSub WebSocket with the vendored session management) — vendored from the reference's battle-tested live-half, byte-compatible in behavior;
  - capture chat lines / events / redemptions (same normalized shapes as the reference; own-echo filtering included);
  - **push every event over the websocket to each connected client** — worker↔ELM is **WEBSOCKETS END TO END** (transport refinement, 2026-11-24; the batched REST ingestion is withdrawn). The worker's webserver is the **agent address**: `ws://…/slop/relay/ws` on `SLOP_RELAY_PORT`. Today the ELM is the connected client; the design leaves room for other authorized listeners;
  - receive **playback commands over that same websocket** and relay them onward (relayed verbatim to every other authorized listener + acked to the sender); `{type:'stream-end'}` arms the linger. The overlay-facing relay is the ELM's job — the worker only serves its own websocket;
  - **linger ~10 minutes after stream end, then exit 0** (Conductor retries the job until the successful exit).
- **Auth on the websocket:** the UPGRADE request must carry the connecting client's OIDC bearer (the ELM's token) — validated against the bound Elements instance with the SAME chain the security proxy runs (signature via discovery→JWKS, issuer = the instance, audience = this pod, expiry; the proxy's own verification modules, imported not copied). Header first, `?token=` as the fallback. Reject otherwise — the upgrade never completes; there are NO unauthenticated routes on the agent address.
- **NO trigger evaluation, NO cooldowns, NO queues, NO engine, NO model access, NO REST ingestion** — all of that is ELM-side (the Kotlin element) or withdrawn.
- Entrypoint env (the allow-list = exactly what the ELM's Conductor dispatch injects):
  - `SLOP_STREAMER` (the tenant login), `SLOP_CHANNEL`
  - `SLOP_MCP_URL` (the ELM's MCP endpoint — required so a half-injected dispatch fails loudly; the thin forwarder itself is MCP-free)
  - `SLOP_OIDC_TOKEN` (the pod's own OIDC token — the credential the ELM presents back when it connects to the agent address; short-lived, rotated by the ELM while live)
  - `SLOP_PROXY_AUDIENCE` (this pod's OIDC audience — the relay's verification chain)
  - `SLOP_ELEMENTS_URL` (the bound instance — the OIDC issuer the agent address verifies against)
  - `SLOP_RELAY_PORT` (the relay webserver port the ELM connects to)
  - `SLOP_TWITCH_*` (the streamer's Twitch credentials — `SLOP_TWITCH_USERNAME` + `SLOP_TWITCH_OAUTH_TOKEN` required; `SLOP_TWITCH_CLIENT_ID` / `SLOP_TWITCH_BROADCASTER_ID` light up EventSub, dormant without them)
- **No Hyper key for the forwarder** (model access is the sidecar's), **no Kubernetes service-account token** (`automountServiceAccountToken: false`), no cloud keys, no DB URLs.
- Resources: the light shape (requests 100m CPU / 128Mi — mirrors the proxy's; the JVM sizing is gone with the scope change).

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
4. **Worker forwarder (smoke):** boots with the allow-listed env, connects to a stub Twitch IRC (scripted), pushes the captured event over its websocket to a connected stub client, relays a play command back over the same socket, exits 0 on the linger timer.

## Implementation notes (first pass + scope changes, 2026-11-24)

Implemented per this spec by the Namazu agent; pushed to `main`. TWO designer
decisions landed the same day and are reflected throughout:

1. **"Thin forwarder"** — the worker is NOT a JVM/element copy. The
   lightweight Node forwarder reuses the reference implementation's
   battle-tested live-half (vendored from `NamazuStudios/slopbot-ai`
   `lib/slop.js` + `lib/eventsub.js`, cited in-file, behavior
   byte-compatible). No element artifacts, no `ELEMENT_RELEASE_TAG`, no JVM.
2. **"Websocket transport"** — worker↔ELM is WEBSOCKETS END TO END; the
   batched REST ingestion (`POST /slop/api/worker/events`) that was built
   first is WITHDRAWN. The worker's webserver is the agent address: an
   OIDC-gated websocket server (`/slop/relay/ws`) that PUSHES every captured
   event to each connected client and relays playback commands onward.

### What's implemented (current state)

- **Security proxy** (`proxy/` + `docker/proxy/Dockerfile`) — Node 22 ESM, plain `http` + `undici` + `jose` (pure-JS, no native modules, no framework). Per-call validation: signature (RS/PS/ES/EdDSA allow-list; `none` rejected), issuer (the bound instance via `SLOP_ELEMENTS_URL` discovery), audience (`SLOP_PROXY_AUDIENCE`), expiry — `401` for missing/malformed/unknown-key/expired/foreign-issuer, `403` for wrong-audience and missing required scope (RFC 6750 posture). Discovery (`<SLOP_ELEMENTS_URL>/.well-known/openid-configuration`) and the JWKS are cached with short TTLs (5 min default, `SLOP_DISCOVERY_TTL_MS`/`SLOP_JWKS_TTL_MS`); an unknown `kid` triggers at most one refresh — new/rotated tokens are accepted immediately, nothing pinned. Fail closed everywhere: auth-backend failure → `503`, upstream failure → `502`, and no path forwards unauthenticated. `/healthz` + `/readyz` are the only unauthenticated routes (`/readyz` flips 503→200 once discovery+JWKS have landed; the proxy warms them in the background at boot). Forwarded calls carry verified identity headers (`x-slop-sub/iss/aud/scope`); caller-supplied `x-slop-*` are stripped first.
- **Thin forwarder** (`worker/` + `docker/worker/Dockerfile`) — Node 22 (`node:22-slim`), uid 10001, one runtime dependency (`ws`). The vendored live-half: chat IRC (anonymous login, 15s keepalive pings, dead after two unanswered, 5s reconnect, own-echo filter, first-ever-chatter capture metadata) and EventSub (welcome/keepalive/handover session management, 15s connect timeout, capped backoff, 409 sweep-and-retry subscriptions — dormant unless the ELM injects `SLOP_TWITCH_CLIENT_ID`). The agent address: `ws://…/slop/relay/ws` on `SLOP_RELAY_PORT` — the UPGRADE is OIDC-gated (the connecting client's bearer validated with the proxy's own verification modules, imported not copied; fail closed, no unauthenticated routes), every captured event is PUSHED to each live client, playback commands arrive over the same socket and are relayed onward (acked to the sender), and `{type:'stream-end'}` arms the ~10-minute linger → exit 0. No engine, no model access, no REST ingestion. Tests (14, all passing): stub Twitch IRC + stub ELM OIDC issuer + real websocket clients — connect/join handshake, events pushed (chat/sub/cheer shapes), both-clients push, upgrade gate (401 no/invalid token, 404 wrong path), play-command round trip, keepalive force-reconnect, linger exit, fail-loud config.
- **OpenCode sidecar** (`docker/opencode/`) — OpenCode v2 (`2.4.1` pinned via `OPENCODE_V2_VERSION` arg), `opencode serve --port 4096 --hostname 127.0.0.1` (fixed, no discovery), uid 10002, `readOnlyRootFilesystem` enforced by the chart; the only writable path is the slop workdir (its state in a hidden subdir; its entrypoint seeds the AGENTS.md contract copy-if-absent — the forwarder has no part in the workdir). Model config is Hyper via `@ai-sdk/openai-compatible` (`prism` default), key read at entrypoint from the mounted `HYPER_INFERENCE_KEY_FILE` file — never baked, never logged. Base pinned to `debian:bookworm-slim`.
- **Helm chart** (`helm/slopbot-pod/`) — renders a `PodTemplate` (the shape Conductor's kubernetes driver dispatches, mirroring the namazu-agent chart): `namazu.conductor/workload-kind: job`, `display-name`, `description`, `backoff-limit: 5`, `expose-ports: "8090/tcp"` (ClusterIP only — the pod never has a public endpoint, so no link pills), `hidden.opencode/proxy`. `automountServiceAccountToken: false`; pod-wide `runAsNonRoot` + `RuntimeDefault` seccomp + `fsGroup: 10001`; per-container UIDs worker 10001 / opencode 10002 / proxy 10003; `readOnlyRootFilesystem: true` on opencode + proxy; the slop workdir as a 2Gi `emptyDir` mounted into opencode only; the Hyper key mounted read-only from the `hyperApiKeySecretName` secret (referenced by name, never embedded — the render FAILS without it, as it does without `elementsUrl`/`audience`); proxy `readinessProbe` on `/readyz`. The worker container renders `SLOP_ELEMENTS_URL`, `SLOP_PROXY_AUDIENCE`, `SLOP_RELAY_PORT` (pod-deterministic); the dispatch allow-list arrives via Conductor into the primary container.
- **NetworkPolicy** (`helm/slopbot-pod/templates/networkpolicy.yaml`, static copy in `k8s/networkpolicy.yaml`) — default-deny ingress+egress; allows DNS (kube-dns 53 udp/tcp), the internet egress rule for the worker's needs (ELM 8080/443, EventSub 443, Twitch IRC 6667/6697 — the vendored IRC uses wss:443) with `169.254.169.254/32` and the cluster-internal range carved out via `ipBlock except` (NetworkPolicy has no explicit-deny primitive — this is how the "explicit deny" is carried), the ELM re-allowed in-cluster via `networkPolicy.elmCidr`, and ELM→proxy/agent-address ingress (default: same-namespace, pinnable via `networkPolicy.ingressFrom`). Proxy→OpenCode is loopback — deliberately not a policy concern.
- **CI** (`.github/workflows/build.yml`) — triggers: push/PR to `main` + `workflow_dispatch`. Job 1 lints + tests BOTH Node packages (proxy validation matrix; forwarder websocket suite); job 2 (main + dispatch only) builds the three images for amd64+arm64 and pushes to `ghcr.io/namazustudios/slopbot-{worker,opencode,proxy}` with immutable `sha-<full-commit>` tags (+ `latest` on main), and reports pushed digests in the job summary; job 3 runs `helm lint`, renders the chart, and ASSERTS the contract (Conductor annotations, `automountServiceAccountToken: false`, exactly 3 containers, NetworkPolicy present, secret-by-reference with no embedded key) plus the fail-loud guards (render must FAIL without `elementsUrl` or `hyperApiKeySecretName`). The pod images are **private on ghcr** (designer decision — the repos are not open source): the chart carries an `imagePullSecret` scaffold — `imagePullSecret.name` (default `slopbot-ghcr`) wires `imagePullSecrets` into the dispatched pod, `imagePullSecret.create` + `dockerconfigjson` render the Secret from a `--set-file` docker config; empty `name` renders without. The secret itself is loaded out-of-band (never committed): `kubectl create secret docker-registry slopbot-ghcr --docker-server=ghcr.io --docker-username=<github-user> --docker-password=<PAT-with-read:packages>`.

### Resource numbers chosen (chart values — revisit with real stream telemetry)

| container | requests | limits | rationale |
|---|---|---|---|
| worker (forwarder) | 50m / 64Mi | 250m / 192Mi | thin Node process — the JVM sizing left with the scope change |
| opencode | 400m / 512Mi | 600m / 768Mi | agent-bearing sidecar (inference is REMOTE — Hyper; the footprint is the Node runtime + the build's context) |
| proxy | 50m / 64Mi | 100m / 128Mi | the OIDC door |
| **pod total** | **500m / 640Mi** | **950m / ~1.09Gi** | the designer's envelope (2026-11-26): ~1 vCPU + 1 GiB per pod; requests pack several agent pods per physical VM |

### CI prerequisites (provisioned out-of-band, in the repo's Settings)

- **GHCR credentials**: none beyond the default `GITHUB_TOKEN` — the workflow requests `packages: write` on main/dispatch runs; the first run creates the three `ghcr.io/namazustudios/slopbot-*` packages (visibility defaults to private — flip to org-visible if the ELM's cluster pulls anonymously).
- **No `ELEMENT_RELEASE_TAG`** — withdrawn with the thin-forwarder scope change; the worker image carries only its own sources + the shared OIDC chain.

### Deviations / notes against the spec (first pass)

- **`SLOP_PROXY_AUDIENCE` env** — the spec's allow-list didn't name an audience variable, but the binding contract requires "audience (this pod, from env)" for the proxy AND the agent address's upgrade gate. Added as its own env (the proxy + chart render it); it belongs on the ELM's injection list alongside `SLOP_ELEMENTS_URL`.
- **`jose` for signature verification** (proxy + the forwarder's agent address, via the shared proxy/lib modules) — audited JWT verification instead of hand-rolled crypto; pure JS, no native modules.
- **`ws` in the worker image** — Node has no built-in websocket SERVER; `ws` is the standard, minimal choice for the agent address.
- **EventSub dormant without `SLOP_TWITCH_CLIENT_ID`** — the vendored session management runs when the ELM injects the app credentials; the anonymous IRC capture works regardless.
- **AGENTS.md contract seed baked into the OpenCode image** (`docker/opencode/slops-AGENTS.md`, entrypoint seeds copy-if-absent) — the element repo's published contract should replace it (nothing else is seeded, per the binding decision).
- **`helm template` (not `PodTemplate` admission) is the CI gate** — Pod Security admission never validates a PodTemplate object directly (mirrors the namazu-agent chart's documented posture); the chart renders restricted-posture shapes and CI asserts them.
- **Worker rootfs not read-only** — the spec requires read-only for the OpenCode sidecar and the proxy; the forwarder keeps a writable rootfs until measured otherwise.
