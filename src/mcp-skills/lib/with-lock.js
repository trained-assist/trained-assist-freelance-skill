'use strict';

// Cross-process advisory lock for the shared freelance index (and other
// critical read-modify-write files). The Control Plane managed adapter spawns
// one provider child per action call (#1271), so two children of the same
// profile can mutate _index.json concurrently — a plain read-modify-write loses
// updates (§18 of the epic). Atomic mkdir is the lock primitive (mkdir fails
// with EEXIST if the directory already exists); no external deps, works across
// processes, released on process exit by the OS removing nothing — so stale
// locks are detected by age and cleared.

const fs = require('fs');
const path = require('path');

const STALE_MS = 15000;
const RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 8000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function acquire(lockDir, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const start = Date.now();
  // The lock's parent may not exist yet (first project for a profile) — create
  // it once. mkdir of the parent is itself racy-safe (EEXIST ignored).
  try { fs.mkdirSync(path.dirname(lockDir), { recursive: true }); } catch { /* ignore */ }
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      fs.writeFileSync(path.join(lockDir, 'owner'), `pid=${process.pid} at=${Date.now()}`);
      return () => release(lockDir);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale lock: owner died without releasing. Age it out.
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch { /* lock vanished between stat and rm — retry acquire */ }
      if (Date.now() - start > timeoutMs) {
        throw Object.assign(new Error(`Lock timeout: ${lockDir}`), { code: 'LOCK_TIMEOUT' });
      }
      await sleep(RETRY_MS);
    }
  }
}

function release(lockDir) {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Reentrancy guard: within one process the mkdir lock is held once; nested
// withLock calls for the same lockDir reuse it instead of self-deadlocking
// (a new_project handler runs the whole dupe-check+create under one lock and
// saveProject → upsertIndexEntry would otherwise re-acquire it).
const held = new Map(); // lockDir -> { depth, release }

async function withLock(lockDir, fn, options) {
  const existing = held.get(lockDir);
  if (existing) {
    existing.depth++;
    try { return await fn(); }
    finally { existing.depth--; if (existing.depth === 0) { held.delete(lockDir); existing.release(); } }
  }
  const release = await acquire(lockDir, options);
  const state = { depth: 1, release };
  held.set(lockDir, state);
  try { return await fn(); }
  finally { state.depth--; if (state.depth === 0) { held.delete(lockDir); state.release(); } }
}

module.exports = { withLock, acquire, release };