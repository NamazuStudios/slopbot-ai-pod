// Vendored-behavior tests for the IRC half (parse / normalize / own-echo /
// first-chatter), against the exact shapes the reference produces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIrcLine, ircLineToCaptureEvent, rememberSent, clearSentEchoes, IrcClient, isOwnEchoForTest } from '../lib/irc.js';

test('parseIrcLine splits tags + parts, unescaping IRCv3 tag values', () => {
  const parsed = parseIrcLine('@badge-info=;badges=broadcaster/1;color=#0000FF;display-name=Streamer\\sName;user-id=12345 :streamer!streamer@streamer.tmi.twitch.tv PRIVMSG #chan :hello world');
  assert.equal(parsed.nick, 'streamer');
  assert.equal(parsed.command, 'PRIVMSG');
  assert.equal(parsed.text, 'hello world');
  assert.equal(parsed.tags['display-name'], 'Streamer Name'); // \s unescaped
  assert.equal(parsed.tags['user-id'], '12345');
});

test('parseIrcLine returns null for non-PRIVMSG/USERNOTICE lines', () => {
  assert.equal(parseIrcLine(':tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv'), null);
  assert.equal(parseIrcLine('PING :tmi.twitch.tv'), null);
  assert.equal(parseIrcLine('@k=v :nick!user@host PART #chan'), null);
});

test('ircLineToCaptureEvent: chat, cheer, and the USERNOTICE family', () => {
  assert.deepEqual(ircLineToCaptureEvent({ command: 'PRIVMSG', nick: 'viewer', tags: {}, text: 'hi' }), {
    type: 'chat', text: 'hi', login: 'viewer', mod: false, broadcaster: false,
  });
  assert.deepEqual(ircLineToCaptureEvent({ command: 'PRIVMSG', nick: 'viewer', tags: { badges: 'broadcaster/1', bits: '100' }, text: 'woohoo' }), {
    type: 'cheer', login: 'viewer', bits: 100,
  });
  assert.deepEqual(ircLineToCaptureEvent({ command: 'USERNOTICE', nick: 'viewer', tags: { 'msg-id': 'sub', 'msg-param-sub-plan': '2000' }, text: '' }), {
    type: 'sub', login: 'viewer', tier: 2,
  });
  assert.deepEqual(ircLineToCaptureEvent({ command: 'USERNOTICE', nick: 'viewer', tags: { 'msg-id': 'raid', 'msg-param-viewerCount': '42' }, text: '' }), {
    type: 'raid', login: 'viewer', viewers: 42,
  });
  assert.deepEqual(ircLineToCaptureEvent({ command: 'USERNOTICE', nick: 'viewer', tags: { 'msg-id': 'resub', 'msg-param-cumulative-months': '7', 'msg-param-sub-plan': '1000' }, text: '' }), {
    type: 'resub', login: 'viewer', tier: 1, months: 7,
  });
  assert.equal(ircLineToCaptureEvent({ command: 'USERNOTICE', nick: 'v', tags: { 'msg-id': 'whatever' }, text: '' }), null);
});

test('own-echo filter: only channel-matching, recently-sent texts are skipped (normalize + cap semantics)', () => {
  clearSentEchoes();
  rememberSent('Hello   World'); // normalized on record
  assert.equal(isOwnEchoForTest('chan', 'CHAN', 'hello  world'), true); // case-insensitive channel, whitespace-normalized text
  assert.equal(isOwnEchoForTest('chan', 'other-viewer', 'hello world'), false); // not the channel's own login
  assert.equal(isOwnEchoForTest('chan', 'chan', 'different text'), false);
  clearSentEchoes();
  assert.equal(isOwnEchoForTest('chan', 'chan', 'hello world'), false);
});

test('first-ever-chatter: the same user-id is marked first exactly once', () => {
  const seen = new Set();
  const markFirst = (event, userId) => {
    if (event.type === 'chat' && userId && !seen.has(userId)) {
      seen.add(userId);
      event.first = true;
    }
    return event;
  };
  assert.equal(markFirst({ type: 'chat', text: 'a' }, 'u1').first, true);
  assert.equal(markFirst({ type: 'chat', text: 'b' }, 'u1').first, undefined);
  assert.equal(markFirst({ type: 'chat', text: 'c' }, 'u2').first, true);
});

// The full own-echo + capture path over a live socket lives in the e2e test;
// this constant asserts the vendored keepalive timing contract stays put.
test('vendored keepalive constants match the reference', () => {
  const client = new IrcClient({ channel: 'c', onEvent: () => {} });
  assert.equal(client.pingEveryMs, 15_000); // [reference: PING_EVERY_MS]
  assert.equal(client.deadAfterMs, 12_000); // [reference: DEAD_AFTER_MS]
  assert.equal(client.reconnectDelayMs, 5_000); // [reference: reconnect delay]
});
