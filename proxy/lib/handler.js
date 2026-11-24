// The proxy's request handler: health routes, the OIDC gate, and forwarding
// to the pod-local OpenCode upstream with identity headers attached.
//
// Fail closed, everywhere: auth-backend trouble is 503, token trouble is
// 401/403, upstream trouble is 502 — and NO path ever forwards a request
// that did not first present a token this pod accepts. /healthz and /readyz
// are the ONLY unauthenticated routes.

import { pipeline } from "node:stream/promises";
import { request } from "undici";
import { TokenError, extractBearer } from "./auth.js";
import { AuthBackendError } from "./oidc.js";

// Hop-by-hop headers never cross the proxy (RFC 9110 §7.6.1), plus the two
// end-to-end headers undici must be allowed to set itself.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
]);

// Identity headers are set by THIS proxy from the verified token and nothing
// else. Anything a caller self-supplies is stripped first — a client never
// gets to claim an identity the proxy did not verify.
const IDENTITY_HEADERS = ["x-slop-sub", "x-slop-iss", "x-slop-aud", "x-slop-scope"];

function filterHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("x-slop-")) continue;
    out[name] = value;
  }
  return out;
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function authFailure(res, err) {
  if (err instanceof AuthBackendError) {
    // The auth backend (discovery/JWKS) is unreachable or lying — fail
    // CLOSED: deny the request, surface the reason, never pass through.
    sendJson(res, 503, { error: "temporarily_unavailable", error_description: err.message });
    return;
  }
  const tokenError = err instanceof TokenError ? err : new TokenError("invalid", err?.message ?? "unknown");
  const challenge = `Bearer realm="slopbot-opencode", error="${tokenError.errorCode}", error_description="${tokenError.message.replaceAll('"', "'")}"`;
  sendJson(
    res,
    tokenError.status,
    { error: tokenError.errorCode, error_description: tokenError.message },
    { "www-authenticate": challenge },
  );
}

/**
 * Builds the request handler.
 *
 * @param {object} options
 * @param {import('./lib/auth.js').AuthValidator} options.validator
 * @param {string} options.upstreamUrl e.g. http://127.0.0.1:4096
 * @param {number} options.upstreamHeadersTimeoutMs
 */
export function createHandler({ validator, upstreamUrl, upstreamHeadersTimeoutMs = 30_000 }) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://proxy.internal");

    // -- Health: the ONLY unauthenticated routes. --------------------------
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/readyz") {
      if (validator.ready) {
        sendJson(res, 200, { ok: true, ready: true });
      } else {
        sendJson(res, 503, { ok: false, ready: false });
      }
      return;
    }

    // -- The gate. ----------------------------------------------------------
    const token = extractBearer(req.headers.authorization);
    let payload;
    try {
      payload = await validator.validate(token);
    } catch (err) {
      authFailure(res, err);
      return;
    }

    // -- Forward to the loopbound upstream, identity attached. --------------
    const headers = filterHeaders(req.headers);
    headers["x-slop-sub"] = String(payload.sub ?? "");
    headers["x-slop-iss"] = String(payload.iss ?? "");
    headers["x-slop-aud"] = String(payload.aud ?? "");
    headers["x-slop-scope"] = typeof payload.scope === "string" ? payload.scope : "";

    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    req.on("error", onClientGone);
    res.on("close", onClientGone);

    let upstream;
    try {
      upstream = await request(`${upstreamUrl}${req.url}`, {
        method: req.method,
        headers,
        // GET/HEAD carry no body; everything else streams through (duplex
        // half) so large prompts and SSE-style calls are not buffered whole.
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
        duplex: "half",
        maxRedirections: 0,
        headersTimeout: upstreamHeadersTimeoutMs,
        // No body timeout: inference responses can be long-lived streams.
        bodyTimeout: 0,
        signal: abort.signal,
      });
    } catch (err) {
      // Fail closed on upstream failure: the ELM sees the error, and nothing
      // about the failure path relaxes the gate above.
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: "bad_gateway",
          error_description: `upstream unreachable: ${err?.message ?? "unknown error"}`,
        });
      } else {
        res.destroy();
      }
      return;
    }

    const responseHeaders = filterHeaders(upstream.headers);
    res.writeHead(upstream.statusCode, responseHeaders);
    if (upstream.body) {
      try {
        // undici v8's request() body is already a Node Readable (BodyReadable).
        await pipeline(upstream.body, res);
      } catch {
        res.destroy();
      }
    } else {
      res.end();
    }
  };
}
