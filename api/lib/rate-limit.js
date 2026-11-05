// api/lib/rate-limit.js — edge-local fixed-window rate limiter (GEST U4).
// The ledger is a public product surface; a rate-limited client gets
// 429 + Retry-After. Pure + injectable clock, bounded in-memory store.
// Persistence is a deployment concern (open-source law): here the store is
// per-lambda-instance and resets on cold start. A durable deploy swaps this
// module's backing store for KV/Postgres without touching the contract.
//
// Config (env, re-read per request so tests/deploys can tune live):
//   GEST_RATE_MAX       — requests per window (0 = unlimited/disabled)
//   GEST_RATE_WINDOW_MS — window size in ms (default 60_000)
//
// SPEC: design-references/GEST-ENTERPRISE-UPLEVEL-SPEC-2026-11-04.md (U4)

const DEFAULTS = { windowMs: 60_000, max: 60 };

function envNum(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function config() {
  return {
    windowMs: envNum("GEST_RATE_WINDOW_MS", DEFAULTS.windowMs),
    max: envNum("GEST_RATE_MAX", DEFAULTS.max),
  };
}

function makeLimiter() {
  const buckets = new Map(); // key -> { windowStart, count }
  return {
    check(key, now = Date.now()) {
      const { windowMs, max } = config();
      if (max <= 0) return { allowed: true, retryAfterSec: 0, retryAfterMs: 0 }; // disabled
      const win = windowMs > 0 ? windowMs : DEFAULTS.windowMs;
      const k = String(key);
      let b = buckets.get(k);
      if (!b || now - b.windowStart >= win) {
        b = { windowStart: now, count: 0 };
        buckets.set(k, b);
      }
      if (b.count >= max) {
        const retryAfterMs = Math.max(0, b.windowStart + win - now);
        return { allowed: false, retryAfterMs, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      b.count += 1;
      // bound the store: evict the oldest window once over a large threshold
      if (buckets.size > 10_000) {
        let oldestKey = null;
        let oldestStart = Infinity;
        for (const [kk, v] of buckets) {
          if (v.windowStart < oldestStart) { oldestStart = v.windowStart; oldestKey = kk; }
        }
        if (oldestKey !== null) buckets.delete(oldestKey);
      }
      return { allowed: true, retryAfterMs: 0, retryAfterSec: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

const singleton = makeLimiter();

module.exports = {
  check: (key, now) => singleton.check(key, now),
  reset: () => singleton.reset(),
  config,
  makeLimiter,
  DEFAULTS,
};
