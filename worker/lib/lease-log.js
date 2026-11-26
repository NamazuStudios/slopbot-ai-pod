// The lease logger (a tiny shim so podlease.js doesn't import the forwarder's).
export const log = (...parts) => console.log('[pod-lease]', ...parts);
