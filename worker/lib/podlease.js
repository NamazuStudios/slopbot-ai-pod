import { log } from './lease-log.js';

const warn = (...parts) => console.warn('[pod-lease]', ...parts);

/**
 * The pod's lease integration (Pod Boot Mechanics §boot steps 3–4): the
 * worker registers with the ELM, claims the lease, heartbeats while live,
 * and releases on exit. A 409 EVICTED means another pod holds the streamer
 * — the invariant is one pod per streamer, so this pod self-evicts (exit 0,
 * Conductor sees the successful exit; the standing pod stays).
 */
export class PodLease {
  constructor(config, options = {}) {
    this.streamer = config.streamer;
    this.elmUrl = (config.elmUrl ?? '').replace(/\/+$/, '');
    this.token = config.podToken ?? '';
    this.podInstanceId = config.podInstanceId ?? `pod-${process.pid}`;
    this.address = config.address ?? '';
    this.mode = config.mode ?? 'build';
    this.heartbeatSeconds = options.heartbeatSeconds ?? Number(process.env.SLOP_POD_HEARTBEAT_SECONDS ?? 30);
    // The injected log comes in two shapes — a bare function (the lease-log
    // shim) or a console-shaped object ({log, warn}, what the forwarder
    // passes for the relay/IRC clients). Normalize to a callable here;
    // a console OBJECT passed bare is what crashed the register handler.
    const injected = options.log ?? log;
    this.log = typeof injected === 'function'
      ? injected
      : (typeof injected?.log === 'function' ? injected.log.bind(injected) : null)
        ?? ((...parts) => console.log('[pod-lease]', ...parts));
    this.timer = null;
    this.evicted = false;
  }

  get enabled() { return Boolean(this.streamer && this.elmUrl && this.token); }

  async _call(path, body) {
    const res = await fetch(`${this.elmUrl}/slop/api/pod/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /**
   * Register + claim. Returns true when this pod holds the lease; false
   * when the registration is unavailable (fail-open — the pod still runs,
   * the ELM just has no lease record); THROWS `Evicted` on a 409.
   */
  async register(retries = 3) {
    if (!this.enabled) {
      this.log('[pod-lease] disabled (missing streamer/elmUrl/token) — running lease-less');
      return true;
    }
    for (let i = 0; i <= retries; i++) {
      try {
        const { status, body } = await this._call('register', {
          streamer: this.streamer,
          token: this.token,
          podInstanceId: this.podInstanceId,
          address: this.address,
          mode: this.mode,
        });
        if (status === 200) {
          this.log(`lease ${body.lease} claimed (${body.status}) for ${this.streamer}`);
          this._startHeartbeat();
          return true;
        }
        if (status === 409) {
          this.evicted = true;
          const err = new Error('EVICTED');
          err.evicted = true;
          throw err;
        }
        if (status === 404) {
          warn('no lease for this streamer — running lease-less');
          return true; // dispatched out-of-band; stay up, no heartbeat
        }
        warn(`register attempt ${i + 1} → ${status}`);
      } catch (e) {
        if (e.evicted) throw e;
        warn(`register attempt ${i + 1} failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
    warn('registration exhausted — running lease-less');
    return true;
  }

  _startHeartbeat() {
    this.timer = setInterval(async () => {
      try {
        const { status, body } = await this._call('heartbeat', {
          streamer: this.streamer, podInstanceId: this.podInstanceId,
        });
        if (status === 409) {
          warn('the lease moved on — self-evicting (one pod per streamer)');
          this.evicted = true;
          this.stop(0);
          process.exit(0);
        }
        if (status !== 200) warn(`heartbeat → ${status}`);
      } catch (e) {
        warn(`heartbeat failed: ${e.message}`); // the ELM's staleness window absorbs blips
      }
    }, this.heartbeatSeconds * 1000);
    this.timer.unref?.();
  }

  /** The clean exit: release the lease (best-effort). */
  async release() {
    if (this.timer) clearInterval(this.timer);
    if (!this.enabled || this.evicted) return;
    try {
      await this._call('release', { streamer: this.streamer, podInstanceId: this.podInstanceId });
      this.log('lease released');
    } catch (e) {
      warn(`release failed: ${e.message}`);
    }
  }
}
