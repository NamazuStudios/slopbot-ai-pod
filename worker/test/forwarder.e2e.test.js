// End-to-end tests for the thin forwarder — WEBSOCKETS END TO END (the
// designer's transport refinement): stub Twitch IRC + a stub ELM whose OIDC
// issuer backs the tokens the test's websocket CLIENTS present. Covers:
// connect + join, events PUSHED over the websocket to each live client,
// auth on the upgrade (401/403/reject), the play-command round trip
// (relayed onward to other clients + acked), {type:'stream-end'} arming the
// linger, and the exit-0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Forwarder } from '../lib/forwarder.js';
import { loadConfig } from '../lib/config.js';
import { startStubIrc, startStubElm, close } from './helpers.js';

function testConfig({ elementsUrl, relayPort }) {
  return loadConfig({
    SLOP_STREAMER: 'savorysailor',
    SLOP_CHANNEL: 'chan',
    SLOP_MCP_URL: 'https://elm.invalid/slop/api/mcp',
    SLOP_OIDC_TOKEN: 'token-v1',
    SLOP_PROXY_AUDIENCE: 'slopbot-pod',
    SLOP_ELEMENTS_URL: elementsUrl,
    SLOP_RELAY_PORT: String(relayPort),
    SLOP_TWITCH_USERNAME: 'slopbot',
    SLOP_TWITCH_OAUTH_TOKEN: 'twitch-token',
  });
}

const PRIVMSG = (nick, text, tags = {}) =>
  `@badges=;display-name=${nick};user-id=${nick}-id${tags.bits ? `;bits=${tags.bits}` : ''} :${nick}!${nick}@${nick}.tmi.twitch.tv PRIVMSG #chan :${text}`;
const USERNOTICE = (nick, msgId, extra = {}) =>
  `@msg-id=${msgId};display-name=${nick};user-id=${nick}-id${extra} :${nick}!${nick}@${nick}.tmi.twitch.tv USERNOTICE #chan :`;

/** A websocket client speaking for the stub ELM; collects incoming frames. */
async function elmSocket(port, token, { queryToken = false } = {}) {
  const url = `ws://127.0.0.1:${port}/slop/relay/ws${queryToken ? `?token=${token}` : ''}`;
  const sock = new WebSocket(url, queryToken ? {} : { headers: { authorization: `Bearer ${token}` } });
  const frames = [];
  const waiters = [];
  sock.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    for (const w of waiters.splice(0)) w(frame);
  });
  await new Promise((resolve, reject) => {
    sock.on('open', resolve);
    sock.on('error', reject);
  });
  return {
    sock,
    frames,
    nextFrame: (ms = 2000) => new Promise((resolve, reject) => {
      if (frames.length > 0) return resolve(frames.shift());
      const timer = setTimeout(() => reject(new Error('no frame arrived in time')), ms);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frames.shift());
      });
    }),
    close: () => new Promise((resolve) => sock.on('close', resolve).close()),
  };
}

/** Raw upgrade against the agent address, resolving the HTTP verdict. */
function rawUpgrade(port, headers = {}, path = '/slop/relay/ws') {
  import('node:http').then(({ request }) => {
    const req = request({ host: '127.0.0.1', port, path, headers });
    req.on('response', () => {}); // upgrades never answer like this
    req.end();
  });
}

test('thin forwarder: websocket end to end — push, auth gate, play round trip, linger exit', async (t) => {
  const elm = await startStubElm(); // the bound instance: OIDC issuer for the clients' tokens
  const irc = await startStubIrc();
  const relayPort = 28000 + Math.floor(Math.random() * 2000);

  const forwarder = new Forwarder(testConfig({ elementsUrl: elm.issuer, relayPort }), {
    ircUrl: irc.url,
    pingEveryMs: 100,
    deadAfterMs: 90,
    reconnectDelayMs: 100,
    lingerMs: 150,
  });

  const runPromise = forwarder.run();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250)); // let it connect + join

    await t.test('the IRC client joined the channel with the vendored anonymous handshake', () => {
      assert.ok(irc.clientLines.some((l) => l.startsWith('PASS SCHMOOPIIE')));
      assert.ok(irc.clientLines.some((l) => l.startsWith('NICK justinfan')));
      assert.ok(irc.clientLines.some((l) => l === 'CAP REQ :twitch.tv/tags'));
      assert.ok(irc.clientLines.some((l) => l === 'JOIN #chan'));
    });

    await t.test('the upgrade gate rejects: no token, bad token, wrong path', async () => {
      const { request } = await import('node:http');
      // Real WebSocket UPGRADE requests (the http handler answers plain GETs
      // with 404 — the gate lives on the upgrade path).
      const UPGRADE_HEADERS = {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      };
      const verdict = (path, headers = {}) =>
        new Promise((resolve) => {
          const req = request({ host: '127.0.0.1', port: relayPort, path, headers: { ...UPGRADE_HEADERS, ...headers } }, (res) => {
            res.resume();
            resolve(res.statusCode);
          });
          req.on('upgrade', () => resolve(101)); // accepted — must not happen here
          req.on('error', () => resolve(0));
          req.end();
        });

      assert.equal(await verdict('/slop/relay/ws'), 401, 'upgrade without a token is rejected');
      assert.equal(await verdict('/slop/relay/ws', { authorization: 'Bearer garbage' }), 401, 'upgrade with an invalid token is rejected');
      assert.equal(await verdict('/nope'), 404, 'unknown websocket path is rejected');
    });

    await t.test('a connected ELM client receives a hello state, then every captured event PUSHED', async () => {
      const client = await elmSocket(relayPort, await elm.signToken({}));
      try {
        const hello = await client.nextFrame();
        assert.equal(hello.type, 'state');
        assert.equal(hello.channel, 'chan');
        assert.equal(hello.streamEnded, false);

        // Authenticated WITHOUT a header, via the ?token= fallback.
        const qsClient = await elmSocket(relayPort, await elm.signToken({ sub: 'the-elm-2' }), { queryToken: true });
        const qsHello = await qsClient.nextFrame();
        assert.equal(qsHello.type, 'state');

        irc.inject(PRIVMSG('viewer1', 'hello from chat'));
        const chat = await client.nextFrame();
        assert.equal(chat.type, 'chat');
        assert.equal(chat.login, 'viewer1');
        assert.equal(chat.text, 'hello from chat');
        assert.ok(chat.now > 0);

        // EVERY live client gets the push — the qs client sees the same line.
        const qsChat = await qsClient.nextFrame();
        assert.equal(qsChat.type, 'chat');
        assert.equal(qsChat.login, 'viewer1');

        irc.inject(USERNOTICE('viewer2', 'sub', ';msg-param-sub-plan=2000'));
        const sub = await client.nextFrame();
        assert.equal(sub.type, 'sub');
        assert.equal(sub.tier, 2);

        irc.inject(PRIVMSG('viewer3', 'cheer50 nice', { bits: '50' }));
        const cheer = await client.nextFrame();
        assert.equal(cheer.type, 'cheer');
        assert.equal(cheer.bits, 50);

        await qsClient.close();
      } finally {
        await client.close();
      }
    });

    await t.test('play-command round trip: sent over the socket, relayed onward to other clients, acked to the sender', async () => {
      const elm1 = await elmSocket(relayPort, await elm.signToken({ sub: 'elm-1' }));
      const elm2 = await elmSocket(relayPort, await elm.signToken({ sub: 'elm-2' }));
      try {
        await elm1.nextFrame(); // hello state
        await elm2.nextFrame();

        elm1.sock.send(JSON.stringify({ type: 'play', name: 'some-slop' }));
        const ack = await elm1.nextFrame();
        assert.equal(ack.type, 'ack');
        assert.equal(ack.relayed, 'play');

        const relayed = await elm2.nextFrame();
        assert.equal(relayed.type, 'playback');
        assert.equal(relayed.command.type, 'play');
        assert.equal(relayed.command.name, 'some-slop');
      } finally {
        await elm1.close();
        await elm2.close();
      }
    });

    await t.test('{type:"stream-end"} over the socket arms the linger, then the forwarder exits 0', async () => {
      const client = await elmSocket(relayPort, await elm.signToken({}));
      await client.nextFrame(); // hello state
      client.sock.send(JSON.stringify({ type: 'stream-end' }));
      const ack = await client.nextFrame();
      assert.equal(ack.relayed, 'stream-end');
      const code = await Promise.race([
        runPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('forwarder did not exit after the linger')), 3000)),
      ]);
      assert.equal(code, 0);
      await client.close();
    });
  } finally {
    await close(elm.server);
    await close(irc.wss);
    void runPromise?.catch(() => {});
  }
});

test('keepalive: the client pings on its own schedule and force-reconnects when the pongs stop', async () => {
  const elm = await startStubElm();
  const irc = await startStubIrc();
  const relayPort = 30000 + Math.floor(Math.random() * 2000);

  const forwarder = new Forwarder(testConfig({ elementsUrl: elm.issuer, relayPort }), {
    ircUrl: irc.url,
    pingEveryMs: 60,
    deadAfterMs: 40, // silent after ~2 unanswered pings — [reference: two unanswered]
    reconnectDelayMs: 60,
    lingerMs: 60_000,
  });

  const runPromise = forwarder.run();
  try {
    const connectionsBefore = irc.connections.length;
    // The stub answers pongs normally — the client should stay connected and
    // keep the traffic warm.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(irc.clientLines.filter((l) => l === 'PING :tmi.twitch.tv').length >= 2, 'pings sent on the vendored schedule');

    // Now the link goes deaf: the stub stops answering (traffic stops) —
    // the client must force-reconnect.
    irc.behavior.answerPong = false;
    irc.behavior.silent = true;
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(irc.connections.length > connectionsBefore, 'a new connection was opened after the pongs stopped');

    // And the new connection re-joins (the capture link is self-healing).
    assert.ok(irc.clientLines.filter((l) => l === 'JOIN #chan').length >= 2, 're-joined on the fresh connection');
  } finally {
    forwarder.stop(0);
    await runPromise.catch(() => {});
    await close(elm.server);
    await close(irc.wss);
  }
});

test('config: a half-injected dispatch fails loudly with the missing names', () => {
  assert.throws(() => loadConfig({ SLOP_STREAMER: 'x' }), /missing:.*SLOP_CHANNEL.*SLOP_OIDC_TOKEN/);
  assert.throws(
    () => loadConfig({
      SLOP_STREAMER: 'x', SLOP_CHANNEL: 'c', SLOP_MCP_URL: 'm', SLOP_OIDC_TOKEN: 't',
      SLOP_PROXY_AUDIENCE: 'a', SLOP_ELEMENTS_URL: 'e', SLOP_RELAY_PORT: 'not-a-port',
      SLOP_TWITCH_USERNAME: 'u', SLOP_TWITCH_OAUTH_TOKEN: 'o',
    }),
    /SLOP_RELAY_PORT/,
  );
});
