#!/usr/bin/env node
// SlopBot thin forwarder — entrypoint (the worker container's main process).
//
// Boots the forwarder on the injected allow-list and exits 0 after the
// post-stream linger (Conductor retries the job until that successful
// exit). SIGTERM/SIGINT stop cleanly with exit 0 as well — a preempted pod
// is a retried pod, not a failed one.

import { loadConfig } from '../lib/config.js';
import { Forwarder } from '../lib/forwarder.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

process.on('SIGTERM', () => forwarder.stop(0));
process.on('SIGINT', () => forwarder.stop(0));

const forwarder = new Forwarder(config);
const code = await forwarder.run();
process.exit(code);
