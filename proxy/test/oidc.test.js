// Unit tests for the discovery/JWKS layer: TTL behavior, rotation on miss,
// and fail-closed error mapping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OidcDiscovery, JwksCache, AuthBackendError, UnknownKidError } from "../lib/oidc.js";
import { startStubIssuer, close } from "./helpers.js";

test("OidcDiscovery caches within the TTL and refetches after it", async () => {
  const issuer = await startStubIssuer();
  try {
    let clock = 1_000_000;
    const discovery = new OidcDiscovery({
      elementsUrl: issuer.issuer,
      ttlMs: 50,
      now: () => clock,
    });

    const first = await discovery.get();
    assert.equal(first.issuer, issuer.issuer);
    assert.equal(issuer.discoveryHits, 1);

    // Within TTL: served from cache.
    clock += 10;
    await discovery.get();
    assert.equal(issuer.discoveryHits, 1);

    // Past TTL: refetched.
    clock += 60;
    const second = await discovery.get();
    assert.equal(issuer.discoveryHits, 2);
    assert.equal(second.issuer, issuer.issuer);
  } finally {
    await close(issuer.server);
  }
});

test("OidcDiscovery fails closed when the instance is unreachable", async () => {
  const issuer = await startStubIssuer();
  await close(issuer.server); // gone before any call
  const discovery = new OidcDiscovery({ elementsUrl: issuer.issuer, ttlMs: 60_000 });
  await assert.rejects(discovery.get(), AuthBackendError);
});

test("OidcDiscovery rejects a document with a missing jwks_uri", async () => {
  const issuer = await startStubIssuer();
  issuer.failMode = false;
  // Serve a broken document by pointing discovery at a 404 path: simplest
  // broken-document simulation is an unreachable well-known endpoint, so
  // just assert the shape check with a hand-rolled fetch stub instead.
  await close(issuer.server);
  const discovery = new OidcDiscovery({
    elementsUrl: "https://elements.invalid",
    ttlMs: 60_000,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ issuer: "https://elements.invalid" }) }),
  });
  await assert.rejects(discovery.get(), /jwks_uri/);
});

test("OidcDiscovery pins the expected issuer and fails closed on mismatch", async () => {
  const issuer = await startStubIssuer();
  try {
    const discovery = new OidcDiscovery({
      elementsUrl: issuer.issuer,
      ttlMs: 60_000,
      expectedIssuer: "https://some-other-instance.example",
    });
    await assert.rejects(discovery.get(), /issuer mismatch/);
  } finally {
    await close(issuer.server);
  }
});

test("JwksCache refreshes on an unknown kid (rotation) and then rejects still-unknown kids", async () => {
  const issuer = await startStubIssuer();
  try {
    const jwks = new JwksCache({
      getJwksUri: async () => `${issuer.issuer}/jwks.json`,
      ttlMs: 60_000,
    });
    // Publish a NEW key (a rotation) and immediately present its kid —
    // unknown to the cache, so the lookup must refresh to find it.
    await issuer.addKey("brand-new-kid");
    const key = await jwks.getKey("brand-new-kid", "RS256");
    assert.ok(key);
    assert.equal(jwks.fetchCount, 1);

    // A kid that even a fresh fetch does not know is a hard unknown.
    await assert.rejects(jwks.getKey("still-unknown", "RS256"), UnknownKidError);
    assert.equal(jwks.fetchCount, 2);
  } finally {
    await close(issuer.server);
  }
});

test("JwksCache fails closed when the JWKS endpoint errors", async () => {
  const issuer = await startStubIssuer();
  issuer.failMode = true;
  try {
    const jwks = new JwksCache({
      getJwksUri: async () => `${issuer.issuer}/jwks.json`,
      ttlMs: 60_000,
    });
    await assert.rejects(jwks.getKey("test-key-1", "RS256"), AuthBackendError);
  } finally {
    await close(issuer.server);
  }
});
