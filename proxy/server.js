// SlopBot security proxy — entrypoint.
//
// Exposes the pod-local OpenCode v2 API (127.0.0.1:<OPENCODE_PORT>) to the
// ELM application, gated on the ELM's OIDC bearer token. Fails closed on
// every error path. /healthz and /readyz are the only unauthenticated routes.

import { createServer } from "node:http";
import { loadConfig } from "./lib/config.js";
import { OidcDiscovery, JwksCache } from "./lib/oidc.js";
import { AuthValidator } from "./lib/auth.js";
import { createHandler } from "./lib/handler.js";

function log(level, message, extra = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, component: "slopbot-proxy", message, ...extra })}\n`);
}

const config = loadConfig(process.env);

const discovery = new OidcDiscovery({
  elementsUrl: config.elementsUrl,
  ttlMs: config.discoveryTtlMs,
  expectedIssuer: config.expectedIssuer,
});
const jwks = new JwksCache({
  getJwksUri: async () => (await discovery.get()).jwksUri,
  ttlMs: config.jwksTtlMs,
});
const validator = new AuthValidator({
  discovery,
  jwks,
  audience: config.audience,
  requiredScope: config.requiredScope,
  clockToleranceS: config.clockToleranceS,
});

const server = createServer(
  createHandler({
    validator,
    upstreamUrl: config.upstreamUrl,
    upstreamHeadersTimeoutMs: config.upstreamHeadersTimeoutMs,
  }),
);

server.listen(config.proxyPort, "0.0.0.0", () => {
  log("info", "listening", {
    port: config.proxyPort,
    upstream: config.upstreamUrl,
    elements_url: config.elementsUrl,
    audience: config.audience,
  });
  // Warm the discovery/JWKS caches in the background — /readyz flips once
  // both have landed. A failed warmup is NOT fatal: readiness stays false
  // and every request still fails closed until the backend answers.
  validator
    .warmup()
    .then(() => log("info", "auth backend warmed up (discovery + JWKS)"))
    .catch((err) => log("error", "auth backend warmup failed — /readyz stays false until it recovers", { error: err.message }));
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log("info", `received ${signal} — closing`);
    server.close(() => process.exit(0));
  });
}
