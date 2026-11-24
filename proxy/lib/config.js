// Environment configuration for the SlopBot security proxy.
//
// Fail-loud convention (mirrors namazu-agent's #92 posture): a required
// variable that is missing or empty aborts startup. The proxy must never
// half-configure its auth and then serve requests against a guessed trust
// anchor — a dead proxy is a closed proxy; a mis-configured one that still
// listens is not.
//
// The full env surface (all of it is inside the pod's allow-list — see
// docs/SPEC.md "Env injection"):
//
//   SLOP_ELEMENTS_URL        required  the bound Elements instance's base URL;
//                                    the OIDC issuer this pod trusts and the
//                                    host the discovery document + JWKS are
//                                    fetched from
//   SLOP_PROXY_AUDIENCE      required  the OIDC audience identifying THIS pod;
//                                    tokens minted for anything else are
//                                    validly signed but not ours to accept
//   SLOP_PROXY_PORT          optional  listen port (default 8080)
//   OPENCODE_PORT            optional  the pod-local OpenCode port the proxy
//                                    forwards to on 127.0.0.1 (default 4096)
//   SLOP_EXPECTED_ISSUER     optional  pin the discovery document's issuer
//                                    claim; a mismatch fails closed (503)
//                                    rather than silently re-anchoring trust
//   SLOP_REQUIRED_SCOPE     optional  when set, a token's `scope` claim must
//                                    include it (space-delimited) — 403
//                                    otherwise (valid-but-wrong-scope)
//   SLOP_DISCOVERY_TTL_MS   optional  OIDC discovery cache TTL (default 5 min)
//   SLOP_JWKS_TTL_MS        optional  JWKS cache TTL (default 5 min; rotation
//                                    is handled on-miss regardless of TTL)
//   SLOP_CLOCK_TOLERANCE_S  optional  signature/claim clock tolerance in
//                                    seconds (default 5)
//   SLOP_UPSTREAM_TIMEOUT_MS optional  headers timeout for the proxied call
//                                    (default 30000; body streams are never
//                                    timed out — inference responses can be
//                                    long-lived)

const REQUIRED = ["SLOP_ELEMENTS_URL", "SLOP_PROXY_AUDIENCE"];

function requireString(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `FATAL: ${name} must be set — the security proxy refuses to start half-configured (fail-loud convention; see docs/SPEC.md)`,
    );
  }
  return value.trim();
}

function optionalInt(env, name, fallback, { min = 0 } = {}) {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(
      `FATAL: ${name} must be an integer >= ${min} (got ${JSON.stringify(env[name])})`,
    );
  }
  return value;
}

function optionalString(env, name) {
  const raw = (env[name] ?? "").trim();
  return raw === "" ? "" : raw;
}

export function loadConfig(env = process.env) {
  const elementsUrl = requireString(env, "SLOP_ELEMENTS_URL").replace(/\/+$/, "");
  const audience = requireString(env, "SLOP_PROXY_AUDIENCE");

  const proxyPort = optionalInt(env, "SLOP_PROXY_PORT", 8080, { min: 1 });
  const opencodePort = optionalInt(env, "OPENCODE_PORT", 4096, { min: 1 });

  // The pod's own loopback is the ONLY path to OpenCode (same network
  // namespace, deliberately loopback-bound sidecar): there is no other
  // upstream, by construction.
  const upstreamUrl = `http://127.0.0.1:${opencodePort}`;

  return {
    proxyPort,
    opencodePort,
    upstreamUrl,
    elementsUrl,
    audience,
    expectedIssuer: optionalString(env, "SLOP_EXPECTED_ISSUER"),
    requiredScope: optionalString(env, "SLOP_REQUIRED_SCOPE"),
    discoveryTtlMs: optionalInt(env, "SLOP_DISCOVERY_TTL_MS", 5 * 60_000, { min: 1 }),
    jwksTtlMs: optionalInt(env, "SLOP_JWKS_TTL_MS", 5 * 60_000, { min: 1 }),
    clockToleranceS: optionalInt(env, "SLOP_CLOCK_TOLERANCE_S", 5, { min: 0 }),
    upstreamHeadersTimeoutMs: optionalInt(env, "SLOP_UPSTREAM_TIMEOUT_MS", 30_000, { min: 1 }),
  };
}
