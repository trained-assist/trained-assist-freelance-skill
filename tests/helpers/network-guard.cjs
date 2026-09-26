'use strict';
// Hermetic network guard for the behavior/replay suites: no real HTTP leaves the
// process — loopback only (for deterministic local fixtures). Mirrors the
// outbound half of scripts/staging/isolation-guard.cjs, without requiring the
// full staging data-root isolation to run a single suite locally.
const net = require('net');
const https = require('https');
const http = require('http');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '']);
const blocked = (target) => Object.assign(new Error(`STAGING_OUTBOUND_BLOCKED: ${target} (behavior suites allow loopback only)`), { code: 'STAGING_OUTBOUND_BLOCKED' });

function isLoopback(host) {
  if (host == null) return true;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK.has(h) || h.startsWith('127.') || h === '::ffff:127.0.0.1';
}

let installed = false;
function installNetworkGuard() {
  if (installed) return;
  installed = true;

  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      let url;
      try { url = new URL(typeof input === 'string' ? input : input?.url ?? String(input)); } catch { return origFetch(input, init); }
      if (!['http:', 'https:'].includes(url.protocol) || isLoopback(url.hostname)) return origFetch(input, init);
      return Promise.reject(blocked(url.host));
    };
  }

  for (const mod of [http, https]) {
    const origRequest = mod.request;
    mod.request = function guardedRequest(...args) {
      const opts = args[0];
      const host = typeof opts === 'string' ? new URL(opts).hostname : (opts?.hostname || opts?.host);
      if (!isLoopback(host)) throw blocked(host);
      return origRequest.apply(this, args);
    };
  }

  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const opts = args[0];
    if (Array.isArray(opts)) return origConnect.apply(this, args);
    let host;
    if (typeof opts === 'object' && opts) { if (opts.path) return origConnect.apply(this, args); host = opts.host; }
    else if (typeof opts === 'string' && isNaN(Number(opts))) return origConnect.apply(this, args);
    else host = typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!isLoopback(host)) {
      const err = blocked(host);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return origConnect.apply(this, args);
  };
}

module.exports = { installNetworkGuard, isLoopback };
