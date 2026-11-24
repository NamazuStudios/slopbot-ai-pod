// Twitch chat IRC client — the SlopBot thin forwarder's live-half, VENDORED
// from the reference implementation `NamazuStudios/slopbot-ai` (lib/slop.js,
// parseIrcLine / badgesOf / ircLineToTriggerEvent / isOwnEcho / sentEchoes /
// startChatListener — see that file for the original; keep the behavior
// byte-compatible: same constants, same parsing, same filtering, same
// reconnect timing). Restructured as a plain Node module (no engine state):
// everything captured goes out through the single onEvent callback, and the
// connect URL / timers are injectable so tests can run fast.
//
// NO trigger evaluation, NO cooldowns, NO queues, NO chat sending — capture
// and liveness only; the engine is ELM-side.

// Split a Twitch IRC line into tags + parts: '@k=v;… :nick!user@host PRIVMSG
// #chan :text' → { tags, nick, command, text }. Tags are unescaped per the
// IRCv3 spec (\: \s \\ \r). [vendored: lib/slop.js parseIrcLine]
export function parseIrcLine(line) {
  let rest = line;
  let tags = {};
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    if (space === -1) return null;
    for (const pair of rest.slice(1, space).split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq);
      const value = pair
        .slice(eq + 1)
        .replace(/\\:/g, ';')
        .replace(/\\s/g, ' ')
        .replace(/\\\\/g, '\\')
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n');
      tags[key] = value;
    }
    rest = rest.slice(space + 1);
  }
  const match = rest.match(/^:([^! ]+)!\S* +(PRIVMSG|USERNOTICE) +#\S+(?:\s+:?([\s\S]*))?$/);
  if (!match) return null;
  return { tags, nick: match[1], command: match[2], text: match[3] ?? '' };
}

// IRC tags → who typed it (badges=broadcaster/1, moderator/1, …).
// [vendored: lib/slop.js badgesOf]
const badgesOf = (tags) => new Set(String(tags?.badges ?? '').split(',').map((b) => b.split('/')[0]));

// USERNOTICE events (sub / resub / gift / raid) and PRIVMSG bits → normalized
// capture events. Anonymous IRC delivers all of these with tags, scope-free.
// [vendored: lib/slop.js ircLineToTriggerEvent — same normalized shapes; the
// DISPATCH is gone (ELM-side engine), only the capture shape remains]
export function ircLineToCaptureEvent(parsed) {
  const badges = badgesOf(parsed.tags);
  if (parsed.command === 'PRIVMSG') {
    const bits = Number(parsed.tags.bits) || 0;
    if (bits > 0) {
      return { type: 'cheer', login: parsed.nick, bits };
    }
    return {
      type: 'chat',
      text: parsed.text.trim(),
      login: parsed.nick,
      mod: badges.has('moderator') || badges.has('broadcaster'),
      broadcaster: badges.has('broadcaster'),
    };
  }
  // USERNOTICE — the msg-id tag names the event
  const msgId = parsed.tags['msg-id'] ?? '';
  const num = (key) => Number(parsed.tags[key]) || 0;
  const tier = { 1000: 1, Prime: 1, 2000: 2, 3000: 3 }[parsed.tags['msg-param-sub-plan'] ?? ''] ?? 0;
  if (msgId === 'sub') return { type: 'sub', login: parsed.nick, tier };
  if (msgId === 'resub') return { type: 'resub', login: parsed.nick, tier, months: num('msg-param-cumulative-months') };
  if (msgId === 'subgift' || msgId === 'anonsubgift') return { type: 'subgift', login: parsed.nick, tier };
  if (msgId === 'submysterygift' || msgId === 'anonsubmysterygift') return { type: 'subgift', login: parsed.nick, tier, count: num('msg-param-mass-gift-count') };
  if (msgId === 'raid' || msgId === 'raid_mystery') {
    const viewers = num('msg-param-viewerCount');
    return { type: 'raid', login: parsed.nick, viewers: Number.isFinite(viewers) ? viewers : 0 };
  }
  return null;
}

// --- own-echo filtering ------------------------------------------------------
// [vendored: lib/slop.js sentEchoes / rememberSent / isOwnEcho — identical
// normalization, cap, and cutoff. The thin forwarder sends no chat of its
// own today, but the filter stays: the ELM's playback relay can carry a
// chat-send command later, and its echoes must not re-enter as captures.]

const sentEchoes = new Map(); // normalized text → sentAt

export const rememberSent = (text) => {
  const key = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) return;
  sentEchoes.set(key, Date.now());
  if (sentEchoes.size > 50) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, t] of sentEchoes) if (t < cutoff) sentEchoes.delete(k);
  }
};

const isOwnEcho = (channel, login, text) => {
  if (login.toLowerCase() !== String(channel ?? '').toLowerCase()) return false;
  const key = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return sentEchoes.has(key);
};

export function clearSentEchoes() {
  sentEchoes.clear();
}

// Test hook — the filter itself is module-private and baked into the client
// (the client supplies the channel); tests exercise the same function.
export const isOwnEchoForTest = isOwnEcho;

// --- the chat listener -------------------------------------------------------
// [vendored: lib/slop.js startChatListener — same anonymous login
// (PASS SCHMOOPIIE + justinfan nick), same CAP REQ :twitch.tv/tags, same
// PING/PONG liveness (15s pings, dead after two unanswered), same 5s
// reconnect-after-close, same own-echo skip. First-ever-chatter marking
// (issue #4) is capture metadata, kept: the ID is recorded even when
// nothing downstream matches.]

export class IrcClient {
  /**
   * @param {object} options
   * @param {string} options.channel the streamer's channel login
   * @param {(event: object) => void} options.onEvent every captured event
   * @param {string} [options.url] WebSocket IRC endpoint (default Twitch)
   * @param {number} [options.pingEveryMs] keepalive ping cadence (default 15000)
   * @param {number} [options.deadAfterMs] silence before force-reconnect (default 12000)
   * @param {number} [options.reconnectDelayMs] delay before re-opening (default 5000)
   * @param {Console} [options.log]
   */
  constructor({ channel, onEvent, url = 'wss://irc-ws.chat.twitch.tv:443', pingEveryMs = 15_000, deadAfterMs = 12_000, reconnectDelayMs = 5_000, log = console }) {
    if (!channel) throw new Error('IrcClient: channel is required');
    this.channel = channel;
    this.onEvent = onEvent;
    this.url = url;
    this.pingEveryMs = pingEveryMs;
    this.deadAfterMs = deadAfterMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.log = log;

    this.ws = null;
    this.keepalive = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.connectionCount = 0;
    this.lastTrafficAt = 0;
    this.joined = false;
    this.seenUsers = new Set(); // first-ever-chatter IDs (pod-ephemeral capture metadata)
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.keepalive = null;
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already gone
      }
    }
    this.ws = null;
  }

  _connect() {
    if (this.stopped) return;
    const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.connectionCount += 1;

    // Liveness: a TCP connection can die without a close frame (NAT timeout,
    // network blip), leaving this "connected" but deaf — every chat line then
    // vanishes. Ping Twitch on our own schedule and force-reconnect when the
    // pongs stop. [vendored: lib/slop.js startChatListener's keepalive]
    let lastTrafficAt = Date.now();
    this.lastTrafficAt = lastTrafficAt;
    const PING_EVERY_MS = this.pingEveryMs;
    const DEAD_AFTER_MS = this.deadAfterMs;
    this.keepalive = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastTrafficAt > PING_EVERY_MS + DEAD_AFTER_MS) {
        this.log.warn('[forwarder] irc link is dead (no traffic) — force-reconnecting');
        try {
          ws.close();
        } catch {
          // close → the reconnect path
        }
        return;
      }
      try {
        ws.send('PING :tmi.twitch.tv');
      } catch {
        // the error handler takes over
      }
    }, PING_EVERY_MS);

    ws.addEventListener('open', () => {
      lastTrafficAt = Date.now();
      ws.send('PASS SCHMOOPIIE'); // anonymous read-only login — no token needed
      ws.send(`NICK ${nick}`);
      // Tags carry the event details (badges, bits, msg-id, viewer counts,
      // user-id — the last is what first-time-chatter capture keys on).
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send(`JOIN #${this.channel}`);
      this.joined = true;
      this.log.log(`[forwarder] watching #${this.channel} — forwarding chat and trigger events to the ELM`);
    });

    ws.addEventListener('message', (data) => {
      lastTrafficAt = Date.now(); // ANY traffic proves the link is alive
      this.lastTrafficAt = lastTrafficAt;
      for (const line of data.data.toString().split('\r\n')) {
        if (line.startsWith('PING')) {
          ws.send(line.replace('PING', 'PONG'));
          continue;
        }
        if (line.startsWith(':tmi.twitch.tv PONG') || line.startsWith('PONG')) continue;
        const parsed = parseIrcLine(line);
        if (!parsed) continue;
        const { nick: login, command } = parsed;
        // Capture events arrive from USERNOTICE regardless of chat flow.
        if (command === 'USERNOTICE') {
          const event = ircLineToCaptureEvent(parsed);
          if (event) this._emit(event);
          continue;
        }
        const text = parsed.text.trim();
        // Skip ONLY the echo of our own posts coming back through IRC —
        // matching text sent by this process recently. The broadcaster's own
        // typed commands still count. [vendored: lib/slop.js]
        if (isOwnEcho(this.channel, login, text)) continue;
        const event = ircLineToCaptureEvent(parsed);
        if (event) {
          // First-ever chatter (issue #4): marks the event once per user,
          // per pod — the ID is recorded even when nothing matches, so
          // "first" means genuinely first, not first-matching.
          const userId = parsed.tags['user-id'];
          if (event.type === 'chat' && userId && !this.seenUsers.has(userId)) {
            this.seenUsers.add(userId);
            event.first = true;
          }
          this._emit(event);
        }
      }
    });

    ws.addEventListener('close', () => {
      if (this.keepalive) clearInterval(this.keepalive);
      this.keepalive = null;
      this.joined = false;
      this.ws = null;
      if (this.stopped) return;
      // The chat reader should outlive hiccups. [vendored: 5s reconnect]
      this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelayMs);
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        // already gone
      }
    });
  }

  _emit(event) {
    try {
      this.onEvent({ ...event, at: Date.now() });
    } catch (err) {
      // A consumer throwing must never kill the chat link.
      this.log.warn('[forwarder] onEvent handler failed:', err?.message ?? err);
    }
  }
}
