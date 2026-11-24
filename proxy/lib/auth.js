// Bearer-token validation for the SlopBot security proxy.
//
// Every proxied request presents an OIDC bearer token minted by the bound
// Elements instance. Validation is per call (never a cached "this token was
// good a second ago" verdict): signature against the issuer's JWKS, issuer,
// audience, expiry — plus an optional required-scope check.
//
// The 401/403 split follows docs/SPEC.md and RFC 6750's posture:
//   401 — the token is not acceptable AT ALL: missing, malformed, bad
//         signature, unknown key, expired, or minted by a foreign issuer
//   403 — the token is genuine but not good FOR THIS POD: wrong audience or
//         missing the required scope (valid-but-wrong-scope)
//
// Fail closed: any error that is not a definite verdict about the token
// (discovery/JWKS unreachable, unusable key material) raises
// AuthBackendError, which the handler maps to 503 — never a pass-through.

import { jwtVerify } from "jose";
import { AuthBackendError, UnknownKidError } from "./oidc.js";

/** Token-definite verdicts — always 401 or 403, never a pass-through. */
export class TokenError extends Error {
  /**
   * @param {string} reason one of 'missing' | 'malformed' | 'unsupported-alg' |
   *   'unknown-key' | 'invalid' | 'expired' | 'foreign-issuer' |
   *   'wrong-audience' | 'insufficient-scope'
   */
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = "TokenError";
    this.reason = reason;
  }

  get status() {
    return this.reason === "wrong-audience" || this.reason === "insufficient-scope" ? 403 : 401;
  }

  /** RFC 6750 error code for the WWW-Authenticate challenge. */
  get errorCode() {
    return this.status === 403 ? "insufficient_scope" : "invalid_token";
  }
}

// Signature algorithms this proxy will ever accept. `none` is not on the
// list — an unencrypted, unsigned JWT is by definition not a credential.
const ALLOWED_ALGS = new Set([
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA",
]);

/** Extracts the bearer token from an Authorization header value, or null. */
export function extractBearer(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

function decodeJsonSegment(segment, what) {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch (cause) {
    throw new TokenError("malformed", `${what} segment is not decodable JSON`);
  }
}

/**
 * Maps a jose verification failure to a TokenError verdict. Anything jose
 * rejects about a CLAIM is a definite verdict about the token; anything
 * else falls back to 'invalid' (401).
 */
export function mapJoseError(err) {
  if (err instanceof TokenError) return err;
  switch (err?.code) {
    case "ERR_JWT_EXPIRED":
      return new TokenError("expired", err.message);
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if (err.claim === "iss") return new TokenError("foreign-issuer", err.message);
      if (err.claim === "aud") return new TokenError("wrong-audience", err.message);
      return new TokenError("invalid", err.message);
    default:
      return new TokenError("invalid", err.message);
  }
}

export class AuthValidator {
  /**
   * @param {object} options
   * @param {import('./oidc.js').OidcDiscovery} options.discovery
   * @param {import('./oidc.js').JwksCache} options.jwks
   * @param {string} options.audience this pod's expected OIDC audience
   * @param {string} [options.requiredScope] scope the token must include
   * @param {number} [options.clockToleranceS]
   */
  constructor({ discovery, jwks, audience, requiredScope = "", clockToleranceS = 5 }) {
    this.discovery = discovery;
    this.jwks = jwks;
    this.audience = audience;
    this.requiredScope = requiredScope;
    this.clockToleranceS = clockToleranceS;
  }

  /** True once discovery + a JWKS fetch have both succeeded — /readyz. */
  get ready() {
    return this.discovery.loaded && this.jwks.loaded;
  }

  async warmup() {
    const doc = await this.discovery.get();
    await this.jwks.refresh();
    return doc;
  }

  /**
   * Validates a bearer token. Returns the verified payload on success;
   * throws TokenError (definite verdict) or AuthBackendError (fail closed).
   */
  async validate(token) {
    if (!token) throw new TokenError("missing", "no bearer token presented");

    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => p === "")) {
      throw new TokenError("malformed", "expected a three-segment JWS compact serialization");
    }
    const header = decodeJsonSegment(parts[0], "JOSE header");
    if (typeof header.alg !== "string" || !ALLOWED_ALGS.has(header.alg)) {
      throw new TokenError("unsupported-alg", `alg ${JSON.stringify(header.alg)} is not accepted`);
    }
    if (typeof header.kid !== "string" || header.kid === "") {
      throw new TokenError("malformed", "JOSE header carries no kid");
    }

    // Discovery first: it anchors WHO the issuer is and WHERE the keys live.
    const doc = await this.discovery.get();
    const key = await this.jwks.getKey(header.kid, header.alg);

    let payload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        issuer: doc.issuer,
        audience: this.audience,
        clockTolerance: this.clockToleranceS,
      }));
    } catch (err) {
      if (err instanceof AuthBackendError || err instanceof UnknownKidError) throw err;
      throw mapJoseError(err);
    }

    if (this.requiredScope) {
      const scope = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
      if (!scope.includes(this.requiredScope)) {
        throw new TokenError(
          "insufficient-scope",
          `token scope ${JSON.stringify(payload.scope ?? "")} lacks ${JSON.stringify(this.requiredScope)}`,
        );
      }
    }

    return payload;
  }
}
