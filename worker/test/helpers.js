// Test fixtures for the thin forwarder: a stub OIDC issuer (real keys, real
// discovery/JWKS), a stub Twitch IRC server (WebSocket, `ws`), and a stub
// ELM (ingestion endpoint + OIDC issuer in one).

import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { WebSocketServer } from 'ws';

export async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

export function close(serverOrWs) {
  return new Promise((resolve) => {
    if (!serverOrWs) return resolve();
    if (typeof serverOrWs.closeAllConnections === 'function') serverOrWs.closeAllConnections?.();
    serverOrWs.close(() => resolve());
  });
}

/** Stub OIDC issuer (same shape as the proxy's test fixture, self-contained). */
export async function startStubIssuer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { kid: 'test-key-1', alg: 'RS256', use: 'sig', ...(await exportJWK(publicKey)) };
  const state = {
    issuer: null,
    failMode: false,
    jwksKeys: [jwk],
    server: null,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (url.pathname === '/.well-known/openid-configuration') {
      if (state.failMode) return res.writeHead(500).end('down');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ issuer: state.issuer, jwks_uri: `${state.issuer}/jwks.json` }));
    }
    if (url.pathname === '/jwks.json') {
      if (state.failMode) return res.writeHead(500).end('down');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: state.jwksKeys }));
    }
    res.writeHead(404).end();
  });
  state.issuer = await listen(server);
  state.server = server;
  state.signToken = async (claims = {}, { kid = 'test-key-1', key = privateKey } = {}) => {
    const t = Date.now();
    return new SignJWT({
      iss: state.issuer,
      aud: 'slopbot-pod',
      sub: 'the-elm',
      iat: Math.floor(t / 1000),
      exp: Math.floor(t / 1000) + 300,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(key);
  };
  return state;
}

/**
 * Stub Twitch IRC server (WebSocket, `ws`): records connections and the
 * client's lines; `behavior` hooks let a test inject lines, stop answering
 * pongs, or refuse the handshake.
 */
export async function startStubIrc() {
  const state = {
    connections: [],
    clientLines: [],
    behavior: {
      answerPong: true,
      autoWelcome: true, // send a NOTICE welcome on join
      silent: false, // when true, never send anything (dead-link simulation)
    },
    inject: (line) => {
      for (const sock of state.connections) {
        if (sock.readyState === 1) sock.send(line);
      }
    },
    lastClient: () => state.connections[state.connections.length - 1] ?? null,
  };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  state.url = await new Promise((resolve) => wss.once('listening', () => resolve(`ws://127.0.0.1:${wss.address().port}`)));
  wss.on('connection', (sock) => {
    state.connections.push(sock);
    sock.on('message', (data) => {
      const line = data.toString();
      state.clientLines.push(line);
      if (state.behavior.silent) return;
      if (line.startsWith('PING')) {
        if (state.behavior.answerPong) sock.send(':tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv');
        return;
      }
      if (line.startsWith('JOIN') && state.behavior.autoWelcome) {
        sock.send(`:${state.behavior.welcomeNick ?? 'slopbot'}!slop@tmi.twitch.tv JOIN #chan`);
      }
    });
  });
  state.wss = wss;
  state.server = wss; // close() works on both
  return state;
}

/**
 * Stub ELM — the bound Elements instance: the OIDC issuer (discovery +
 * JWKS) the forwarder verifies against, and the token minter for the
 * websocket client the tests connect to the agent address with. One base
 * URL — that is the pod's real shape (SLOP_ELEMENTS_URL).
 */
export async function startStubElm({ audience = 'slopbot-pod' } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { kid: 'test-key-1', alg: 'RS256', use: 'sig', ...(await exportJWK(publicKey)) };
  const state = {
    issuer: null,
    failMode: false, // 500 the OIDC endpoints (fail-closed exercises)
    jwksKeys: [jwk],
    server: null,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://elm');
    if (url.pathname === '/.well-known/openid-configuration') {
      if (state.failMode) return res.writeHead(500).end('down');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ issuer: state.issuer, jwks_uri: `${state.issuer}/jwks.json` }));
    }
    if (url.pathname === '/jwks.json') {
      if (state.failMode) return res.writeHead(500).end('down');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: state.jwksKeys }));
    }
    res.writeHead(404).end();
  });
  state.issuer = await listen(server);
  state.server = server;
  state.signToken = async (claims = {}, { kid = 'test-key-1', key = privateKey } = {}) => {
    const t = Date.now();
    return new SignJWT({
      iss: state.issuer,
      aud: audience,
      sub: 'the-elm',
      iat: Math.floor(t / 1000),
      exp: Math.floor(t / 1000) + 300,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(key);
  };
  return state;
}
