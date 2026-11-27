// The SlopBot thin forwarder — the pod's main container.
//
// Duties (ONLY these, per the designer's "thin forwarder" scope decision +
// the websocket transport refinement):
//   1. keep the Twitch connections alive (chat IRC + EventSub, vendored
//      from the reference implementation's battle-tested live-half)
//   2. capture chat lines / events / redemptions
//   3. PUSH every event over the websocket to each connected client
//      (today: the ELM; the design leaves room for other authorized
//      listeners) — worker↔ELM is WEBSOCKETS END TO END
//   4. receive playback commands over that websocket and relay them onward
//      (the overlay-facing relay is the ELM's job — the worker only serves
//      its own websocket); {type:'stream-end'} arms the linger
//   5. linger ~10 minutes after stream end, then exit 0 (Conductor retries
//      the job until that successful exit)
//
// NO trigger evaluation, NO cooldowns, NO queues, NO engine, NO model
// access, NO REST ingestion — all of that is ELM-side or withdrawn.

import { IrcClient } from './irc.js';
import { EventSubClient } from './eventsub.js';
import { RelayServer } from './relay.js';
import { PodLease } from './podlease.js';

const LINGER_MS = 10 * 60_000; // ~10 minutes after stream end, then exit 0

const log = (...parts) => console.log('[forwarder]', ...parts);
const warn = (...parts) => console.warn('[forwarder]', ...parts);

export class Forwarder {
  /**
   * @param {object} config see lib/config.js loadConfig()
   * @param {object} [options] test overrides: {lingerMs, ircUrl, eventSubUrl,
   *   pingEveryMs, deadAfterMs, reconnectDelayMs, credentials: {oidcToken,
   *   twitchToken, twitchClientId, twitchBroadcasterId}, log}
   */
  constructor(config, options = {}) {
    this.config = config;
    this.lingerMs = options.lingerMs ?? LINGER_MS;
    this.log = options.log ?? console;
    this.exitCode = null; // resolved run() value: 0 on the clean path

    this.streamEnded = false;
    this.lingerTimer = null;
    this._lingerResolve = null;

    // The lease (Pod Boot Mechanics): register at boot, heartbeat while
    // live, release on exit; a 409 self-evicts (one pod per streamer).
    this.lease = new PodLease({
      streamer: config.streamer,
      elmUrl: config.elmUrl ?? config.elementsUrl,
      podToken: options.credentials?.podToken ?? process.env.SLOP_POD_TOKEN ?? '',
      podInstanceId: process.env.SLOP_POD_INSTANCE_ID ?? `pod-${process.pid}`,
      address: `${options.advertiseAddress ?? process.env.SLOP_POD_IP ?? '127.0.0.1'}:${config.relayPort}`,
      mode: process.env.SLOP_POD_MODE ?? 'build',
    }, { log: this.log });

    // Credential getters — env re-read by default (the ELM rotates the pod
    // token while live, so a per-call re-read picks up the rotation),
    // injectable for tests.
    const getters = options.credentials ?? {};

    // The websocket relay: the ELM (and any other authorized listener)
    // connects here; every captured event is PUSHED to each live client.
    this.relay = new RelayServer({
      port: config.relayPort,
      elementsUrl: config.elementsUrl,
      audience: config.audience,
      onPlayback: (command) => this._onPlayback(command),
      status: () => ({
        streamer: config.streamer,
        channel: config.channel,
        irc: { connected: Boolean(this.irc?.ws), connectionCount: this.irc?.connectionCount ?? 0, lastTrafficAgoMs: this.irc?.lastTrafficAt ? Date.now() - this.irc.lastTrafficAt : null },
        eventsub: { connectionCount: this.eventSub?.connectionCount ?? 0 },
        clients: this.clients.size,
        streamEnded: this.streamEnded,
      }),
      log: this.log,
    });
    this.clients = this.relay.clients;

    // Twitch chat — the vendored live-half. Anonymous login; the pod's own
    // credentials are only needed for EventSub.
    this.irc = new IrcClient({
      channel: config.channel,
      onEvent: (event) => this.relay.push(event),
      url: options.ircUrl,
      pingEveryMs: options.pingEveryMs,
      deadAfterMs: options.deadAfterMs,
      reconnectDelayMs: options.reconnectDelayMs,
      log: this.log,
    });

    // EventSub (redemptions + follows) — vendored session management;
    // dormant unless the ELM injected the app credentials.
    this.eventSub = new EventSubClient({
      getToken: getters.twitchToken ?? (() => process.env.SLOP_TWITCH_OAUTH_TOKEN ?? ''),
      getClientId: getters.twitchClientId ?? (() => process.env.SLOP_TWITCH_CLIENT_ID ?? ''),
      getBroadcasterId: getters.twitchBroadcasterId ?? (() => process.env.SLOP_TWITCH_BROADCASTER_ID ?? config.streamer),
      onEvent: (event) => this.relay.push(event),
      url: options.eventSubUrl,
      log: this.log,
    });
  }

  async run() {
    // The lease first: claim (or self-evict) BEFORE Twitch capture — two
    // pods for one streamer must never both capture.
    let evicted = false;
    try {
      await this.lease.register();
    } catch (e) {
      if (e.evicted) {
        log('self-evicting — another pod holds the streamer (one pod per streamer)');
        this.exitCode = 0;
        evicted = true;
      } else {
        log(`lease registration failed — continuing lease-less: ${e.message}`);
      }
    }
    if (evicted) {
      await this.relay.close();
      return this.exitCode ?? 0;
    }

    await this.relay.listen();
    this.irc.start();
    this.eventSub.start();
    log(`forwarder up for ${this.config.streamer} (channel #${this.config.channel}) — pushing captured events to each websocket client at /slop/relay/ws`);

    // Resolves when the linger after stream end has elapsed (or stop() was
    // called externally — SIGTERM).
    await new Promise((resolve) => {
      this._lingerResolve = resolve;
    });
    await this.relay.close();
    this.irc.stop();
    this.eventSub.stop();
    await this.lease.release();
    log(`forwarder down (exit ${this.exitCode ?? 0})`);
    return this.exitCode ?? 0;
  }

  _onPlayback(command) {
    if (command.type === 'buildDone') {
      if ((process.env.SLOP_POD_MODE ?? 'build') !== 'build') return;
      log(`build ${command.name ?? ''} completed — exiting 0 (the build-mode pod's work is done)`);
      this.exitCode = 0;
      this._lingerResolve?.();
      return;
    }
    if (command.type === 'stream-end') {
      if (this.streamEnded) return;
      this.streamEnded = true;
      log(`stream ended — lingering ${Math.round(this.lingerMs / 1000)}s, then exiting 0 (Conductor retries the job until the successful exit)`);
      this.lingerTimer = setTimeout(() => {
        this.exitCode = 0;
        this._lingerResolve?.();
      }, this.lingerMs);
    }
    // Other playback command types are relayed onward by the RelayServer
    // verbatim; the thin forwarder has no engine to interpret them.
  }

  /** Immediate stop (SIGTERM path) — resolves run() with the given code. */
  stop(exitCode = 0) {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.exitCode = exitCode;
    this._lingerResolve?.();
  }
}
