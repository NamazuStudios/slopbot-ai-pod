// Twitch EventSub over WebSocket — the SlopBot thin forwarder's live-half,
// VENDORED from the reference implementation `NamazuStudios/slopbot-ai`
// (lib/eventsub.js — see that file for the original; keep the session
// behavior byte-compatible: same 15s connect timeout, same capped reconnect
// backoff [1,2,5,10,30]s, same keepalive-reset-on-any-message with a
// keepalive+5s dead-man switch, same session_welcome adoption/handover,
// session_reconnect transfer, revocation logging, and the same 409
// sweep-and-retry on subscribing).
//
// What is deliberately NOT vendored: the OAuth browser-flow lifecycle and
// config/-file persistence (the pod's Twitch identity arrives via the ELM's
// injected env — SLOP_TWITCH_OAUTH_TOKEN + SLOP_TWITCH_CLIENT_ID — and its
// data authority is the ELM, nothing is persisted). Token access goes
// through the injected getToken() getter so a rotated token is picked up
// per helix call. Everything captured goes out through onEvent.
//
// Docs: https://dev.twitch.tv/docs/eventsub/handling-websocket-events/

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX_URL = 'https://api.twitch.tv/helix';

const REDEMPTION_TYPE = 'channel.channel_points_custom_reward_redemption.add';
const FOLLOW_TYPE = 'channel.follow'; // v2 (condition: broadcaster + moderator)

const CONNECT_TIMEOUT_MS = 15000; // give up on a socket that never says hello
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]; // capped backoff

const log = (...parts) => console.log('[eventsub]', ...parts);
const warn = (...parts) => console.warn('[eventsub]', ...parts);

// [vendored: lib/eventsub.js normalizeRedemption — identical shape]
export const normalizeRedemption = (event) => ({
  id: event.id,
  at: Date.now(),
  user: {
    id: event.user_id,
    login: event.user_login,
    name: event.user_name,
  },
  reward: {
    id: event.reward?.id,
    title: event.reward?.title ?? 'Unknown reward',
    cost: event.reward?.cost ?? 0,
    prompt: event.reward?.prompt ?? '',
  },
  input: event.user_input || '',
  status: event.status,
  redeemedAt: event.redeemed_at ? Date.parse(event.redeemed_at) : Date.now(),
});

export class EventSubClient {
  /**
   * @param {object} options
   * @param {() => string} options.getToken the current Twitch user token
   *   (re-read per call — rotation-aware)
   * @param {() => string} options.getClientId the Twitch app client-id
   * @param {() => string|null} options.getBroadcasterId the broadcaster's user id
   * @param {(event: object) => void} options.onEvent captured events
   *   (normalized redemptions, {type:'follow', login, userId})
   * @param {string} [options.url] EventSub WS endpoint (default Twitch)
   * @param {Console} [options.log]
   */
  constructor({ getToken, getClientId, getBroadcasterId, onEvent, url = EVENTSUB_WS_URL, log = console }) {
    this.getToken = getToken;
    this.getClientId = getClientId;
    this.getBroadcasterId = getBroadcasterId;
    this.onEvent = onEvent;
    this.url = url;
    this.log = { log: log.log.bind(log), warn: log.warn.bind(log) };

    this.socket = null; // the live EventSub socket (may briefly differ mid-handover)
    this.sessionId = null;
    this.keepaliveMs = 10000;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.retryIndex = 0;
    this.stopped = false;
    this.connectionCount = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already gone
      }
    }
    this.socket = null;
  }

  // Helix call — minimal, per-call credential read (rotation-aware). The
  // reference's helix() also handled silent token refresh; the pod's token
  // is rotated by the ELM instead, so a 401 here surfaces as a warn and the
  // next attempt picks up the fresh token.
  async helix(pathname, init = {}) {
    const token = this.getToken();
    const clientId = this.getClientId();
    if (!token || !clientId) throw new Error('no twitch credentials (SLOP_TWITCH_* not fully injected)');
    const response = await fetch(`${HELIX_URL}${pathname}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  // [vendored: lib/eventsub.js subscribe + createWithSweep — identical 409
  // sweep-and-retry cadence: 6 sweep rounds 5s apart, then one delayed
  // retry after 60s before conceding to the next reconnect]
  async subscribe(sessionId) {
    const broadcasterId = this.getBroadcasterId();
    if (!sessionId || !broadcasterId) {
      this.log.warn('cannot subscribe yet — waiting for session welcome and broadcaster id');
      return;
    }

    const post = (type, version, condition) =>
      this.helix('/eventsub/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          version,
          condition,
          transport: { method: 'websocket', session_id: sessionId },
        }),
      });

    const createWithSweep = async (type, version, condition, describe) => {
      const attempt = async () => post(type, version, condition);
      let { status, body } = await attempt();
      for (let round = 0; status === 409 && round < 6; round++) {
        this.log.log(`${type} already exists on a dead session — sweeping and retrying (${round + 1})`);
        const list = await this.helix('/eventsub/subscriptions');
        const stale = (list.body?.data ?? []).filter(
          (sub) => sub.type === type && sub.transport?.method === 'websocket' && sub.status !== 'enabled',
        );
        for (const sub of stale) {
          await this.helix(`/eventsub/subscriptions?id=${sub.id}`, { method: 'DELETE' });
        }
        // Twitch marks a just-died session's subscriptions disconnected on
        // its own schedule — give it a beat before re-checking.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        ({ status, body } = await attempt());
      }
      if (status === 409) {
        // Still colliding after ~30s of sweeps — one more attempt after a
        // minute before conceding to the next reconnect.
        this.log.warn(`${type} still colliding — one delayed retry in 60s`);
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        ({ status, body } = await attempt());
      }
      if (status === 200 || status === 202) {
        this.log.log(`subscribed to ${type}${describe ?? ''}`);
      } else {
        this.log.warn(`${type} subscription failed (${status})`, JSON.stringify(body?.detail ?? body?.message ?? body));
      }
    };

    await createWithSweep(REDEMPTION_TYPE, '1', { broadcaster_user_id: broadcasterId });
    await createWithSweep(FOLLOW_TYPE, '2', {
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }, ' (follow captures live)');
  }

  // [vendored: lib/eventsub.js stopKeepalive / resetKeepalive /
  // scheduleReconnect — same timers and backoff table]
  stopKeepalive() {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  resetKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      this.log.warn(`no keepalive for ${Math.round(this.keepaliveMs / 1000) + 5}s — reconnecting`);
      try {
        this.socket?.close();
      } catch {
        // close handler takes over from here
      }
    }, this.keepaliveMs + 5000);
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)];
    this.retryIndex += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.log.log(`reconnecting in ${Math.round(delay / 1000)}s`);
  }

  // [vendored: lib/eventsub.js wire — the shared message/close handlers,
  // attached to every socket including handover replacements]
  wire(sock) {
    sock.addEventListener('open', () => {
      // A socket that never receives its welcome is dead weight — close it
      // and let the close handler schedule a retry.
      sock._connectTimer = setTimeout(() => {
        this.log.warn('no welcome within 15s — closing');
        try {
          sock.close();
        } catch {
          // already gone
        }
      }, CONNECT_TIMEOUT_MS);
    });
    sock.addEventListener('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.data.toString());
      } catch {
        return;
      }
      this.resetKeepalive();
      switch (msg.metadata?.message_type) {
        case 'session_welcome': {
          clearTimeout(sock._connectTimer);
          // Reconnect handover: adopt the new socket, retire the old one.
          if (this.socket && this.socket !== sock) {
            try {
              this.socket.close();
            } catch {
              // already gone
            }
          }
          this.socket = sock;
          this.sessionId = msg.payload.session.id;
          this.keepaliveMs = (msg.payload.session.keepalive_timeout_seconds || 10) * 1000;
          this.retryIndex = 0; // a welcome means Twitch is reachable again
          this.log.log('session established');
          // On handover the subscriptions transfer across; only a fresh
          // connection needs to subscribe.
          if (!sock._transfer) {
            this.subscribe(this.sessionId).catch((err) => this.log.warn('subscribe failed:', err?.message ?? err));
          }
          break;
        }
        case 'session_reconnect': {
          const url = msg.payload.session.reconnect_url;
          this.log.log('server requested reconnect — opening handover socket');
          const replacement = new WebSocket(url);
          replacement._transfer = true; // subscriptions move over, don't re-post
          this.wire(replacement);
          this.socket = replacement; // old socket's close is now a no-op
          break;
        }
        case 'notification': {
          if (msg.payload.subscription?.type === REDEMPTION_TYPE) {
            const reward = normalizeRedemption(msg.payload.event);
            this.log.log(`redeem: ${reward.user.login} → ${reward.reward.title}${reward.input ? ` (${reward.input})` : ''}`);
            this._emit(reward);
          } else if (msg.payload.subscription?.type === FOLLOW_TYPE) {
            const login = msg.payload.event?.user_login ?? 'someone';
            this.log.log(`follow: ${login}`);
            this._emit({ type: 'follow', login, userId: msg.payload.event?.user_id ?? null, at: Date.now() });
          }
          break;
        }
        case 'revocation': {
          this.log.warn(`subscription revoked (${msg.payload.subscription?.status}) — the ELM must re-inject valid SLOP_TWITCH_* credentials`);
          break;
        }
        default:
          break; // session_keepalive and anything unknown
      }
    });
    sock.addEventListener('close', () => {
      clearTimeout(sock._connectTimer);
      if (sock !== this.socket) return; // a superseded handover socket — ignore
      this.socket = null;
      this.sessionId = null;
      this.stopKeepalive();
      if (this.stopped) return;
      this.scheduleReconnect();
    });
    sock.addEventListener('error', (err) => this.log.warn(`socket error: ${err?.message ?? err}`));
  }

  // [vendored: lib/eventsub.js connect — minus the config-file gates; the
  // pod's credentials come from the injected env getters, and a missing
  // client-id leaves the session dormant rather than crashing the pod]
  connect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stopped) return;
    if (!this.getClientId() || !this.getToken()) {
      this.log.log('no twitch app credentials injected (SLOP_TWITCH_CLIENT_ID / SLOP_TWITCH_OAUTH_TOKEN) — EventSub dormant');
      return;
    }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

    const sock = new WebSocket(this.url);
    sock._transfer = false;
    this.wire(sock);
    this.socket = sock;
    this.connectionCount += 1;
    this.log.log('connecting…');
  }

  _emit(event) {
    try {
      this.onEvent(event);
    } catch (err) {
      // A consumer throwing must never kill the EventSub link.
      this.log.warn('onEvent handler failed:', err?.message ?? err);
    }
  }
}
