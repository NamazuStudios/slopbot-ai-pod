// End-to-end tests: the full validation matrix against a real proxy handler
// wired to a stub OIDC issuer (real keys, real discovery/JWKS over HTTP) and
// a stub OpenCode upstream. Covers: valid/none/expired/foreign/wrong-audience
// /wrong-scope, JWKS rotation and TTL, fail-closed paths, identity-header
// forwarding, spoof stripping, and the unauthenticated health routes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OidcDiscovery, JwksCache } from "../lib/oidc.js";
import { AuthValidator } from "../lib/auth.js";
import { createHandler } from "../lib/handler.js";
import { startStubIssuer, startStubUpstream, listen, close } from "./helpers.js";

const AUDIENCE = "slopbot-pod";
const REQUIRED_SCOPE = "opencode.inference";

async function buildProxy({ requiredScope = REQUIRED_SCOPE } = {}) {
  const issuer = await startStubIssuer();
  const upstream = await startStubUpstream();
  const discovery = new OidcDiscovery({ elementsUrl: issuer.issuer, ttlMs: 60_000 });
  const jwks = new JwksCache({
    getJwksUri: async () => (await discovery.get()).jwksUri,
    ttlMs: 60_000,
  });
  const validator = new AuthValidator({ discovery, jwks, audience: AUDIENCE, requiredScope });
  const server = createServer(createHandler({ validator, upstreamUrl: upstream.baseUrl }));
  const baseUrl = await listen(server);
  return { issuer, upstream, server, baseUrl, jwks, discovery, validator };
}

function proxyFetch(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, { method, headers, body, redirect: "manual" });
}

test("validation matrix: valid / none / expired / foreign / wrong-audience / wrong-scope", async (t) => {
  const ctx = await buildProxy();
  try {
    await ctx.validator.warmup();
    const bearer = (token) => ({ authorization: `Bearer ${token}` });
    // Denied requests must never reach the upstream: snapshot the count and
    // assert no delta (the matrix shares one upstream).
    const upstreamCount = () => ctx.upstream.requests.length;
    const deny = async (label, path, headers, expectStatus) => {
      const before = upstreamCount();
      const res = await proxyFetch(ctx.baseUrl, path, { headers });
      assert.equal(res.status, expectStatus, label);
      assert.equal(upstreamCount(), before, `${label}: upstream must not see the request`);
      return res;
    };

    await t.test("valid token is forwarded and served", async () => {
      const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE });
      const res = await proxyFetch(ctx.baseUrl, "/session", { headers: bearer(token) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.served, "stub-opencode");
    });

    await t.test("missing token -> 401 with a WWW-Authenticate challenge", async () => {
      const res = await deny("missing token", "/session", {}, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer /);
    });

    await t.test("malformed token -> 401", async () => {
      await deny("malformed token", "/session", bearer("not-a-token"), 401);
    });

    await t.test("expired token -> 401", async () => {
      const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE, exp: Math.floor(Date.now() / 1000) - 3600 });
      const res = await deny("expired token", "/session", bearer(token), 401);
      assert.match(JSON.stringify(await res.json()), /expired/);
    });

    await t.test("foreign-issuer token -> 401", async () => {
      const token = await ctx.issuer.signToken({ iss: "https://evil.example", scope: REQUIRED_SCOPE });
      await deny("foreign issuer", "/session", bearer(token), 401);
    });

    await t.test("wrong-audience token -> 403", async () => {
      const token = await ctx.issuer.signToken({ aud: "some-other-pod", scope: REQUIRED_SCOPE });
      await deny("wrong audience", "/session", bearer(token), 403);
    });

    await t.test("valid-but-wrong-scope token -> 403", async () => {
      const token = await ctx.issuer.signToken({ scope: "something.else" });
      await deny("wrong scope", "/session", bearer(token), 403);
    });

    await t.test("no scope claim at all with a required scope -> 403", async () => {
      const token = await ctx.issuer.signToken({});
      await deny("no scope claim", "/session", bearer(token), 403);
    });
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("health routes are the only unauthenticated routes", async () => {
  const ctx = await buildProxy();
  try {
    await ctx.validator.warmup(); // /readyz is 200 only once warmed — see the dedicated test for the pre-warm 503
    for (const path of ["/healthz", "/readyz"]) {
      const res = await proxyFetch(ctx.baseUrl, path);
      assert.equal(res.status, 200, path);
    }
    // Anything else is gated — even an unknown path.
    const res = await proxyFetch(ctx.baseUrl, "/definitely-not-open");
    assert.equal(res.status, 401);
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("readyz stays 503 until discovery + JWKS have landed, then flips to 200", async () => {
  const ctx = await buildProxy();
  try {
    const before = await proxyFetch(ctx.baseUrl, "/readyz");
    assert.equal(before.status, 503);
    await ctx.validator.warmup();
    const after = await proxyFetch(ctx.baseUrl, "/readyz");
    assert.equal(after.status, 200);
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("forwarding attaches verified identity headers and strips caller-supplied spoofs", async () => {
  const ctx = await buildProxy();
  try {
    await ctx.validator.warmup();
    const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE, sub: "the-elm" });
    const res = await proxyFetch(ctx.baseUrl, "/session?hello=world", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-slop-sub": "SPOOFED",
        "x-slop-iss": "SPOOFED",
      },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(res.status, 200);
    const seen = ctx.upstream.requests[0];
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/session?hello=world");
    assert.equal(seen.headers["x-slop-sub"], "the-elm");
    assert.equal(seen.headers["x-slop-iss"], ctx.issuer.issuer);
    assert.equal(seen.headers["x-slop-aud"], AUDIENCE);
    assert.equal(seen.headers["x-slop-scope"], REQUIRED_SCOPE);
    assert.equal(seen.body, JSON.stringify({ prompt: "hi" }));
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("rotation: a token signed by a NEW key is accepted immediately, without restart", async () => {
  const ctx = await buildProxy();
  try {
    await ctx.validator.warmup();
    // Mint with a kid the JWKS has never published yet.
    const newKey = await ctx.issuer.addKey("rotated-key-2");
    const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE }, { kid: "rotated-key-2", key: newKey });
    const res = await proxyFetch(ctx.baseUrl, "/session", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(ctx.upstream.requests.length, 1);
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("unknown kid that even a fresh JWKS fetch does not know -> 401", async () => {
  const ctx = await buildProxy();
  try {
    await ctx.validator.warmup();
    const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE }, { kid: "no-such-key" });
    const res = await proxyFetch(ctx.baseUrl, "/session", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
    assert.equal(ctx.upstream.requests.length, 0);
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("fail closed: unreachable discovery backend denies the request (503), upstream untouched", async () => {
  const ctx = await buildProxy();
  try {
    ctx.issuer.failMode = true; // discovery + JWKS now 500
    const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE });
    const res = await proxyFetch(ctx.baseUrl, "/session", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 503);
    assert.equal(ctx.upstream.requests.length, 0);
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("fail closed: upstream down -> 502 after successful auth", async () => {
  const ctx = await buildProxy();
  try {
    await ctx.validator.warmup();
    ctx.upstream.healthy = false;
    const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE });
    const res = await proxyFetch(ctx.baseUrl, "/session", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 502);
  } finally {
    ctx.upstream.healthy = true;
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});

test("JWKS TTL is honored across calls (no refetch inside the window)", async () => {
  const ctx = await buildProxy();
  try {
    await ctx.validator.warmup();
    const fetchesAfterWarmup = ctx.issuer.jwksHits;
    const token = await ctx.issuer.signToken({ scope: REQUIRED_SCOPE });
    for (let i = 0; i < 5; i += 1) {
      const res = await proxyFetch(ctx.baseUrl, "/session", { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
    }
    // Known kid + fresh cache: the known-key path never refetches.
    assert.equal(ctx.issuer.jwksHits, fetchesAfterWarmup);
  } finally {
    await close(ctx.server);
    await close(ctx.issuer.server);
    await close(ctx.upstream.server);
  }
});
