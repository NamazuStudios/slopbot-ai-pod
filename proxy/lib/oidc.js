// OIDC discovery + JWKS caching for the SlopBot security proxy.
//
// Trust anchor: the bound Elements instance's URL comes from the pod's
// injected env (SLOP_ELEMENTS_URL) — nothing else about the issuer is
// assumed. Discovery (GET <elementsUrl>/.well-known/openid-configuration)
// yields the issuer to enforce and the jwks_uri to fetch signing keys from;
// both are cached with a short TTL and refetched on miss.
//
// Rotation-awareness: a NEW token with an unknown `kid` triggers at most one
// JWKS refresh per lookup — no restart, no pinned key set, and no pinned
// token. A key that is still unknown after a fresh fetch is a hard 401.
//
// Every network failure in this module raises AuthBackendError: the auth
// backend being unreachable must FAIL CLOSED (the proxy answers 503), never
// fall through to "treat the request as authenticated".

export class AuthBackendError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "AuthBackendError";
  }
}

export class UnknownKidError extends Error {
  constructor(kid) {
    super(`no signing key matching kid ${JSON.stringify(kid)} (even after a fresh JWKS fetch)`);
    this.name = "UnknownKidError";
  }
}

function assertHttpUrl(url, what) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuthBackendError(`${what} is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AuthBackendError(`${what} must be http(s): ${JSON.stringify(url)}`);
  }
  return parsed;
}

async function fetchJson(fetchImpl, url, timeoutMs, what) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new AuthBackendError(`${what}: fetch failed`, { cause });
  }
  if (!response.ok) {
    throw new AuthBackendError(`${what}: HTTP ${response.status} from ${url}`);
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new AuthBackendError(`${what}: response was not JSON`, { cause });
  }
}

/**
 * Caches the bound Elements instance's OIDC discovery document.
 *
 * The `issuer` claim of the cached document is the issuer every incoming
 * token is required to carry. `expectedIssuer`, when set, pins it: a
 * discovery document claiming anything else fails closed instead of letting
 * the instance redefine its own trust mid-flight.
 */
export class OidcDiscovery {
  constructor({ elementsUrl, fetchImpl = fetch, ttlMs, timeoutMs = 5000, expectedIssuer = "", now = Date.now }) {
    this.discoveryUrl = `${elementsUrl.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.expectedIssuer = expectedIssuer;
    this._now = now;
    this._cache = null; // { issuer, jwksUri, fetchedAt }
    this._inflight = null;
  }

  get loaded() {
    return this._cache !== null;
  }

  get cached() {
    return this._cache;
  }

  async get({ force = false } = {}) {
    const now = this._now();
    if (!force && this._cache && now - this._cache.fetchedAt < this.ttlMs) {
      return this._cache;
    }
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const doc = await fetchJson(this.fetchImpl, this.discoveryUrl, this.timeoutMs, "OIDC discovery");
        if (typeof doc?.issuer !== "string" || doc.issuer === "") {
          throw new AuthBackendError("OIDC discovery document has no usable issuer claim");
        }
        if (typeof doc?.jwks_uri !== "string" || doc.jwks_uri === "") {
          throw new AuthBackendError("OIDC discovery document has no usable jwks_uri");
        }
        assertHttpUrl(doc.jwks_uri, "jwks_uri");
        if (this.expectedIssuer && doc.issuer !== this.expectedIssuer) {
          throw new AuthBackendError(
            `OIDC discovery issuer mismatch: expected ${JSON.stringify(this.expectedIssuer)}, got ${JSON.stringify(doc.issuer)} — refusing to re-anchor trust`,
          );
        }
        this._cache = { issuer: doc.issuer, jwksUri: doc.jwks_uri, fetchedAt: this._now() };
        return this._cache;
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }
}

/**
 * Caches the issuer's JWKS with a short TTL, and refreshes ON DEMAND when a
 * token presents a kid the cache has never seen — that is what makes a
 * rotated token acceptable immediately, with no restart and no pinned key.
 */
export class JwksCache {
  constructor({ getJwksUri, fetchImpl = fetch, ttlMs, timeoutMs = 5000, now = Date.now }) {
    this.getJwksUri = getJwksUri;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this._now = now;
    /** kid -> { jwk, keys: Map<alg, CryptoKey>, imported } */
    this._byKid = new Map();
    this._fetchedAt = 0;
    this._refreshPromise = null;
  }

  get loaded() {
    return this._byKid.size > 0;
  }

  get lastFetchedAt() {
    return this._fetchedAt;
  }

  get fetchCount() {
    return this._fetchCount ?? 0;
  }

  async refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      const jwksUri = await this.getJwksUri();
      const jwks = await fetchJson(this.fetchImpl, jwksUri, this.timeoutMs, "JWKS fetch");
      if (!Array.isArray(jwks?.keys)) {
        throw new AuthBackendError("JWKS response has no keys array");
      }
      const byKid = new Map();
      for (const jwk of jwks.keys) {
        if (typeof jwk?.kid !== "string" || jwk.kid === "") continue;
        // First key wins per kid — a well-formed issuer never publishes two
        // keys under one kid; if it ever does, refusing the ambiguity (by
        // keeping the first) is safer than guessing.
        if (!byKid.has(jwk.kid)) byKid.set(jwk.kid, { jwk, keys: new Map() });
      }
      this._byKid = byKid;
      this._fetchedAt = this._now();
      this._fetchCount = (this._fetchCount ?? 0) + 1;
    })();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  /**
   * Returns the CryptoKey for a kid under the token's own algorithm.
   * Missing kid => exactly one refresh (rotation window), then either the
   * key or UnknownKidError. Fetch failures propagate as AuthBackendError
   * (fail closed).
   */
  async getKey(kid, alg) {
    const direct = this._byKid.get(kid);
    if (direct) return this._import(direct, alg);
    await this.refresh();
    const refreshed = this._byKid.get(kid);
    if (refreshed) return this._import(refreshed, alg);
    throw new UnknownKidError(kid);
  }

  async _import(entry, alg) {
    let key = entry.keys.get(alg);
    if (!key) {
      let imported;
      try {
        const { importJWK } = await import("jose");
        imported = await importJWK(entry.jwk, alg);
      } catch (cause) {
        throw new AuthBackendError(`JWKS key ${JSON.stringify(entry.jwk.kid)} is unusable for ${alg}`, { cause });
      }
      key = imported;
      entry.keys.set(alg, key);
    }
    return key;
  }
}
