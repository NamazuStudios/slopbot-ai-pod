// Test fixtures: a stub OIDC issuer (discovery + JWKS + token minting) and a
// stub OpenCode upstream. Real HTTP over ephemeral loopback ports, real keys
// generated per test run — the proxy code under test uses its ordinary
// code paths end to end.

import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

export async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

export function close(server) {
  return new Promise((resolve) => {
    // Keep-alive connections (the proxy's undici pool, fetch's own pool)
    // would hold server.close() open forever — drop them all.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * A stub Elements-instance-shaped OIDC issuer.
 *
 *   GET /.well-known/openid-configuration -> { issuer, jwks_uri }
 *   GET /jwks.json                        -> { keys: [...] }
 *
 * `failMode` makes the issuer's endpoints fail (500) to exercise the
 * proxy's fail-closed paths. `signToken` mints RS256 tokens with a `kid`.
 */
export async function startStubIssuer({ now = Date.now } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { kid: "test-key-1", alg: "RS256", use: "sig", ...(await exportJWK(publicKey)) };
  const state = {
    issuer: null, // filled once the stub's own base URL is known
    failMode: false, // 500 the discovery + JWKS endpoints
    jwksKeys: [jwk],
    discoveryHits: 0,
    jwksHits: 0,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    if (url.pathname === "/.well-known/openid-configuration") {
      state.discoveryHits += 1;
      if (state.failMode) {
        res.writeHead(500).end("stub issuer is down");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer: state.issuer, jwks_uri: `${state.issuer}/jwks.json` }));
      return;
    }
    if (url.pathname === "/jwks.json") {
      state.jwksHits += 1;
      if (state.failMode) {
        res.writeHead(500).end("stub issuer is down");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: state.jwksKeys }));
      return;
    }
    res.writeHead(404).end();
  });

  const baseUrl = await listen(server);
  state.server = server;
  state.issuer = baseUrl;

  state.signToken = async (claims = {}, { kid = "test-key-1", key = privateKey, header } = {}) => {
    const t = now();
    const base = {
      iss: state.issuer,
      aud: "slopbot-pod",
      sub: "user-elm",
      iat: Math.floor(t / 1000),
      exp: Math.floor(t / 1000) + 300,
    };
    return new SignJWT({ ...base, ...claims })
      .setProtectedHeader({ alg: "RS256", kid, ...header })
      .sign(key);
  };

  state.addKey = async (kid) => {
    const { publicKey: pk, privateKey: sk } = await generateKeyPair("RS256");
    state.jwksKeys.push({ kid, alg: "RS256", use: "sig", ...(await exportJWK(pk)) });
    return sk; // the PRIVATE half — what signToken needs to mint with
  };

  return state;
}

/** A stub OpenCode upstream that records every proxied call. */
export async function startStubUpstream() {
  const state = { requests: [], healthy: true };
  const server = createServer(async (req, res) => {
    if (!state.healthy) {
      // Simulate the sidecar being down: hang up without answering.
      res.destroy();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    state.requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, served: "stub-opencode" }));
  });
  state.baseUrl = await listen(server);
  state.server = server;
  return state;
}
