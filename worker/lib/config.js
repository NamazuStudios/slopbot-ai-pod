// Env allow-list for the thin forwarder — exactly what the ELM's Conductor
// dispatch injects (the scope-change list), and NOTHING else:
//
//   SLOP_STREAMER        the tenant login
//   SLOP_CHANNEL         the Twitch channel to watch
//   SLOP_MCP_URL         the ELM's MCP endpoint (injected for the dispatch
//                        contract; the thin forwarder itself is MCP-free —
//                        required so a half-injected dispatch fails loudly)
//   SLOP_OIDC_TOKEN      the pod's OIDC token — re-read per attempt (the ELM
//                        rotates it while live)
//   SLOP_PROXY_AUDIENCE  the OIDC audience identifying this pod (the relay's
//                        verification chain)
//   SLOP_ELEMENTS_URL    the bound Elements instance — the ELM (the OIDC
//                        issuer the agent address's upgrade gate verifies
//                        the connecting client's token against)
//   SLOP_RELAY_PORT      the relay webserver port the ELM connects to
//   SLOP_ELM_URL         the ELM's REST root (the lease routes) — optional;
//                        absent = lease-less run (out-of-band dispatches)
//   SLOP_POD_TOKEN       the dispatch-minted pod token (the lease routes)
//   SLOP_POD_MODE        stream | build (default build)
//   SLOP_POD_HEARTBEAT_SECONDS / SLOP_POD_INSTANCE_ID — lease tuning
//   SLOP_TWITCH_*        the streamer's Twitch credentials
//                        (SLOP_TWITCH_USERNAME + SLOP_TWITCH_OAUTH_TOKEN
//                        required; SLOP_TWITCH_CLIENT_ID +
//                        SLOP_TWITCH_BROADCASTER_ID optional — EventSub
//                        stays dormant without them)
//
// No Hyper key for the forwarder itself (model access is the sidecar's).

const REQUIRED = [
  'SLOP_STREAMER',
  'SLOP_CHANNEL',
  'SLOP_MCP_URL',
  'SLOP_OIDC_TOKEN',
  'SLOP_PROXY_AUDIENCE',
  'SLOP_ELEMENTS_URL',
  'SLOP_RELAY_PORT',
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name] || !String(env[name]).trim());
  if (missing.length > 0) {
    throw new Error(`FATAL: env injection contract incomplete — missing: ${missing.join(', ')} (the ELM's dispatch must inject the full allow-list; see docs/SPEC.md)`);
  }
  const relayPort = Number(env.SLOP_RELAY_PORT);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error(`FATAL: SLOP_RELAY_PORT must be a valid port (got ${JSON.stringify(env.SLOP_RELAY_PORT)})`);
  }
  return {
    streamer: env.SLOP_STREAMER.trim(),
    channel: env.SLOP_CHANNEL.trim(),
    mcpUrl: env.SLOP_MCP_URL.trim(),
    audience: env.SLOP_PROXY_AUDIENCE.trim(),
    elementsUrl: env.SLOP_ELEMENTS_URL.trim().replace(/\/+$/, ''),
    elmUrl: (env.SLOP_ELM_URL ?? '').trim().replace(/\/+$/, ''),
    relayPort,
    twitchUsername: (env.SLOP_TWITCH_USERNAME ?? '').trim(),
  };
}
