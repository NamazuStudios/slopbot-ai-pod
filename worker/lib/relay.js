// The agent address — the worker's WEBSOCKET server (SLOP_RELAY_PORT).
//
// TRANSPORT (designer decision, 2026-11-24): worker↔ELM is WEBSOCKETS END TO
// END — the batched REST ingestion this file once served is WITHDRAWN.
//
//   ws://…/slop/relay/ws   the one socket: the ELM connects here as the
//                          authenticated client and RECEIVES every captured
//                          event pushed to each live connection (chat,
//                          cheers, subs, raids, redemptions, follows, plus
//                          relays of playback commands from other clients),
//                          and SENDS playback commands back over the same
//                          socket ({type:'play', …}, {type:'stream-end', …})
//
// Auth on the websocket: the UPGRADE request must carry the connecting
// client's OIDC bearer — the ELM's token — validated against the bound
// Elements instance with the SAME chain the security proxy runs (signature
// via discovery→JWKS, issuer, audience, expiry — the proxy's own modules,
// imported not copied). Reject otherwise: the upgrade never completes, fail
// closed. Header (Authorization: Bearer …) first, ?token= as the fallback
// (same vocabulary as the platform's own gate).

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { OidcDiscovery, JwksCache } from '../../proxy/lib/oidc.js';
import { AuthValidator, extractBearer } from '../../proxy/lib/auth.js';

const log = (...parts) => console.log('[relay]', ...parts);
const warn = (...parts) => console.warn('[relay]', ...parts);

export class RelayServer {
  /**
   * @param {object} options
   * @param {number} options.port SLOP_RELAY_PORT
   * @param {string} options.elementsUrl the bound instance (OIDC issuer)
   * @param {string} options.audience SLOP_PROXY_AUDIENCE — this pod
   * @param {(command: object) => void} options.onPlayback the ELM's playback
   *   commands (and the stream-end signal) handed to the forwarder
   * @param {() => object} options.status liveness snapshot for the hello frame
   * @param {Console} [options.log]
   */
  constructor({ port, elementsUrl, audience, onPlayback, status, log: l = console }) {
    this.port = port;
    this.onPlayback = onPlayback;
    this.status = status;
    this.log = { log: l.log.bind(l), warn: l.warn.bind(l) };

    // The same OIDC chain the security proxy runs — same modules, same
    // trust anchor, same audience (the pod's own).
    this.discovery = new OidcDiscovery({ elementsUrl, ttlMs: 5 * 60_000 });
    this.jwks = new JwksCache({
      getJwksUri: async () => (await this.discovery.get()).jwksUri,
      ttlMs: 5 * 60_000,
    });
    this.validator = new AuthValidator({ discovery: this.discovery, jwks: this.jwks, audience });

    this.clients = new Set(); // accepted websocket connections
    this.server = createServer((req, res) => {
      // There are NO http routes on the agent address — websockets only.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', error_description: 'websocket-only: connect at /slop/relay/ws' }));
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (sock, req) => this._connected(sock, req));
    this.server.on('upgrade', (req, socket, head) => {
      this._gate(req)
        .then((payload) => {
          this.wss.handleUpgrade(req, socket, head, (sock) => {
            sock._subject = String(payload?.sub ?? '');
            this.wss.emit('connection', sock, req);
          });
        })
        .catch((err) => {
          // Fail closed: the upgrade never completes. Answer HTTP first (a
          // client can read the verdict), then destroy.
          const status = err?.name === 'AuthBackendError' ? 503 : err?.status ?? 401;
          try {
            socket.write(`HTTP/1.1 ${status} ${status === 503 ? 'Service Unavailable' : status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ error: err?.errorCode ?? 'invalid_token' })}`);
          } catch {
            // socket already gone
          }
          socket.destroy();
          warn(`upgrade rejected: ${err?.reason ?? err?.message ?? 'rejected'}`);
        });
    });
  }

  get ready() {
    return this.validator.ready;
  }

  warmup() {
    return this.validator.warmup();
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.log.log(`agent address listening on :${this.port} (ELM connects at /slop/relay/ws — OIDC-gated upgrade)`);
        resolve();
      });
      // Warm the auth backend in the background; until it lands, upgrades
      // still validate on demand (per connection) — readiness is advisory.
      this.warmup().catch((err) => this.log.warn('auth backend warmup failed:', err?.message ?? err));
    });
  }

  close() {
    for (const sock of this.clients) {
      try {
        sock.close(1001, 'agent shutting down'); // going away
      } catch {
        // already gone
      }
    }
    this.clients.clear();
    this.wss.close();
    // Idle keep-alive connections (the ELM's HTTP agent pools them) would
    // hold server.close() for the full keep-alive timeout — drop them. A
    // socket stuck mid-teardown is force-closed after a short grace: the
    // forwarder must EXIT deterministically after the linger.
    this.server.closeIdleConnections?.();
    return new Promise((resolve) => {
      const force = setTimeout(() => this.server.closeAllConnections?.(), 250);
      this.server.close(() => {
        clearTimeout(force);
        resolve();
      });
    });
  }

  /** Push one event to EACH live websocket connection (the forwarding duty). */
  push(event) {
    const frame = JSON.stringify({ ...event, now: Date.now() });
    for (const sock of this.clients) {
      if (sock.readyState !== 1 /* OPEN */) continue;
      try {
        sock.send(frame);
      } catch (err) {
        this.log.warn(`push to client failed: ${err?.message ?? err}`);
      }
    }
  }

  /** Relay a playback command onward: to every OTHER client, verbatim. */
  relayPlayback(command, fromSock) {
    const frame = JSON.stringify({ type: 'playback', command, now: Date.now() });
    for (const sock of this.clients) {
      if (sock === fromSock || sock.readyState !== 1) continue;
      try {
        sock.send(frame);
      } catch (err) {
        this.log.warn(`relay to client failed: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * The upgrade gate: OIDC-validate the connecting client's bearer (the
   * ELM's token) against the bound instance BEFORE accepting. Resolves the
   * verified payload or rejects with TokenError/AuthBackendError.
   */
  async _gate(req) {
    const url = new URL(req.url ?? '/', 'http://relay.internal');
    if (url.pathname !== '/slop/relay/ws') {
      const err = new Error('unknown websocket path');
      err.status = 404;
      throw err;
    }
    const token = extractBearer(req.headers.authorization) ?? url.searchParams.get('token');
    const payload = await this.validator.validate(token); // throws TokenError / AuthBackendError
    return payload;
  }

  _connected(sock, req) {
    this.clients.add(sock);
    log(`client connected (${sock._subject || 'anonymous-sub'}) — total ${this.clients.size}`);
    try {
      sock.send(JSON.stringify({ type: 'state', ...this.status(), now: Date.now() }));
    } catch {
      // the close handler reaps it
    }
    sock.on('message', (data) => {
      let command;
      try {
        command = JSON.parse(data.toString());
      } catch {
        try {
          sock.send(JSON.stringify({ type: 'error', error_description: 'frames must be JSON' }));
        } catch {
          // gone
        }
        return;
      }
      if (!command || typeof command.type !== 'string' || command.type === '') {
        try {
          sock.send(JSON.stringify({ type: 'error', error_description: 'missing type' }));
        } catch {
          // gone
        }
        return;
      }
      // Playback commands come IN over the same socket and are relayed
      // ONWARD — to every other authorized listener; the worker itself only
      // interprets the lifecycle ones (stream-end arms the linger). The
      // overlay-facing relay is the ELM's job.
      this.relayPlayback(command, sock);
      this.onPlayback(command);
      try {
        sock.send(JSON.stringify({ type: 'ack', relayed: command.type, now: Date.now() }));
      } catch {
        // gone
      }
    });
    sock.on('close', () => {
      this.clients.delete(sock);
      log(`client left — total ${this.clients.size}`);
    });
    sock.on('error', (err) => {
      this.log.warn(`client socket error: ${err?.message ?? err}`);
      this.clients.delete(sock);
    });
  }
}
