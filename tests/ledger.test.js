// tests/ledger.test.js — U4 receipts: board/ledger hardening.
// Proves the GEST-ENTERPRISE-UPLEVEL-SPEC U4 gap is closed:
//
//   (a) gests.json serves the visibility law — public listed, unlisted/private absent
//   (b) the stable contract — fingerprint / owner / visibility / content_hash lineage
//   (c) a rate-limited client → 429 + Retry-After
//   (d) a write without an owner grant is refused (read-public, write-owner)
//   (e) tenant isolation — ?owner= scopes the ledger; ?q= search provenance
//
// Two layers: pure unit tests of api/lib/ledger.js + api/lib/rate-limit.js (the
// decision), then resolver-level integration (the enforcement) with synthetic
// packages injected into the generated PACKAGES object.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const ledger = require("../api/lib/ledger.js");
const rateLimit = require("../api/lib/rate-limit.js");
const handler = require("../api/resolve.js");
const PACKAGES = require("../api/lib/packages.generated.js");

beforeEach(() => {
  rateLimit.reset();
  ledger.resetOverlay();
  delete process.env.GEST_RATE_MAX;
  delete process.env.GEST_RATE_WINDOW_MS;
  delete process.env.GEST_OWNER_GRANTS;
});

// ── resolver invocation helper (mirrors tests/e2e.test.js) ───────────────
function hit(url, { headers = {}, method = "GET", body } = {}) {
  return new Promise((resolve) => {
    const req = { url, method, headers, body };
    const chunks = [];
    const res = {
      setHeader() {},
      writeHead(s, h) {
        this.status = s;
        const lower = {};
        for (const [k, v] of Object.entries(h || {})) lower[k.toLowerCase()] = v;
        this.headers = lower;
      },
      end(b) { chunks.push(b || ""); },
    };
    handler(req, res).then(() => {
      const text = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8");
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      resolve({ status: res.status, headers: res.headers || {}, text, json });
    });
  });
}

// ── synthetic packages (distinct slugs; injected into PACKAGES) ──────────
function manifest({ slug, vis, gestId, owner = "tester" }) {
  const visLine = vis === "private"
    ? "**Visibility:** private — ingestion requires an access grant (sha256 grant hash: `0123456789abcdef`)."
    : `**Visibility:** ${vis} — ingestion is open.`;
  return `# INGEST.md — machine manifest for \`${slug}\`

> Convention: justinsharpe/ingest — INGEST.md (canonical) / AGENT-INGEST.md (alias), one schema.
> **Package fingerprint (sha256):** \`0123456789abcdef\` — verify after transfer; if it differs, the tree changed.

> **Gest ID:** \`${gestId}\` — the load-bearing reference (owner in the URL is decoration).
> **Owner:** ${owner}

${visLine}

## Load order (the one required section)

1. BLUF (below) — the one-paragraph bottom line.
2. The files in the file map, in listed order.

## BLUF

${slug} bluf body.

## File map

- \`data.txt\` — 6 bytes

## The one-liner

**Prompt form:** Read \`INGEST.md\` at the artifact root and execute its load order; it routes everything else.
**CLI form:** \`ingest <dir>\` — this reference tool reads the manifest.
`;
}

// u4-prefixed slugs avoid colliding with the real packages and the U3 battery.
PACKAGES["u4pub"] = { "INGEST.md": manifest({ slug: "u4pub", vis: "public", gestId: "u4pubgst1", owner: "justin" }), "data.txt": "hello\n" };
PACKAGES["u4unl"] = { "INGEST.md": manifest({ slug: "u4unl", vis: "unlisted", gestId: "u4unlgst1", owner: "justin" }), "data.txt": "hello\n" };
PACKAGES["u4priv"] = { "INGEST.md": manifest({ slug: "u4priv", vis: "private", gestId: "u4prvgst1", owner: "brandon" }), "data.txt": "secret\n" };

// ════════════════════════════════════════════════════════════════════════
// 1 — pure unit tests: the contract + visibility law (api/lib/ledger.js)
// ════════════════════════════════════════════════════════════════════════
test("gestEntry: stable contract carries fingerprint/owner/visibility/content_hash/lineage", () => {
  const e = ledger.gestEntry("u4pub", manifest({ slug: "u4pub", vis: "public", gestId: "u4pubgst1", owner: "justin" }));
  assert.equal(e.gest_id, "u4pubgst1");
  assert.equal(e.owner, "justin");
  assert.equal(e.visibility, "public");
  assert.equal(e.fingerprint, "0123456789abcdef");
  assert.equal(e.content_hash, "0123456789abcdef", "content_hash is the lineage key == fingerprint");
  assert.deepEqual(e.lineage, { gest_id: "u4pubgst1", content_hash: "0123456789abcdef" });
});

test("publicLedger: applies the visibility law — public listed, unlisted/private absent", () => {
  const list = ledger.publicLedger(PACKAGES);
  const slugs = list.map((g) => g.slug);
  assert.ok(slugs.includes("u4pub"), "public must list");
  assert.ok(slugs.includes("agentic-testing"), "real public package must list");
  assert.ok(!slugs.includes("u4unl"), "unlisted must not list");
  assert.ok(!slugs.includes("u4priv"), "private must not list");
  assert.ok(!slugs.includes("consumer"), "real unlisted package (no gest id) must not list");
});

test("filterLedger: ?owner= tenant isolation + ?q= search provenance", () => {
  const all = ledger.publicLedger(PACKAGES);
  const justin = ledger.filterLedger(all, { owner: "justin" });
  assert.ok(justin.every((g) => g.owner === "justin"));
  assert.ok(justin.some((g) => g.slug === "u4pub"));
  const hit_ = ledger.filterLedger(all, { q: "agentic" });
  assert.ok(hit_.some((g) => g.slug === "agentic-testing"));
  assert.equal(hit_.some((g) => g.slug === "u4pub"), false);
});

// ════════════════════════════════════════════════════════════════════════
// 2 — pure unit tests: the write auth (read-public, write-owner)
// ════════════════════════════════════════════════════════════════════════
const GRANTS = { justin: "grant-justin", brandon: "grant-brandon" };

test("authorizeWrite: fail-closed — no grants / no token / bad token / owner mismatch refused", () => {
  assert.deepEqual(ledger.authorizeWrite("grant-justin", "justin", null), { ok: false, reason: "writes_disabled" });
  assert.deepEqual(ledger.authorizeWrite(null, "justin", GRANTS), { ok: false, reason: "no_token" });
  assert.deepEqual(ledger.authorizeWrite("wrong", "justin", GRANTS), { ok: false, reason: "invalid_token" });
  // token bound to justin cannot write under brandon's owner
  assert.deepEqual(ledger.authorizeWrite("grant-justin", "brandon", GRANTS), { ok: false, reason: "owner_mismatch", boundOwner: "justin" });
  assert.deepEqual(ledger.authorizeWrite("grant-brandon", "brandon", GRANTS), { ok: true, owner: "brandon" });
});

test("validateEntry: rejects malformed write payloads", () => {
  assert.deepEqual(ledger.validateEntry(null), ["payload must be a JSON object"]);
  const bad = ledger.validateEntry({ owner: "justin", gest_id: "UPPER", fingerprint: "0123456789abcdef" });
  assert.ok(bad.some((m) => m.includes("gest_id")), "uppercase gest_id refused");
  const badFp = ledger.validateEntry({ owner: "justin", gest_id: "okgest1", fingerprint: "xyz" });
  assert.ok(badFp.some((m) => m.includes("fingerprint")), "bad fingerprint refused");
  const noOwner = ledger.validateEntry({ gest_id: "okgest1", fingerprint: "0123456789abcdef" });
  assert.ok(noOwner.some((m) => m.includes("owner")), "missing owner refused");
  assert.deepEqual(ledger.validateEntry({ owner: "justin", gest_id: "okgest1", fingerprint: "0123456789abcdef" }), []);
});

// ════════════════════════════════════════════════════════════════════════
// 3 — pure unit tests: the rate limiter (api/lib/rate-limit.js)
// ════════════════════════════════════════════════════════════════════════
test("rate limiter: fixed window, 429 + Retry-After math (pure, injectable clock)", () => {
  process.env.GEST_RATE_MAX = "2";
  process.env.GEST_RATE_WINDOW_MS = "1000";
  const rl = rateLimit.makeLimiter();
  const t0 = 1_000_000_000_000;
  assert.deepEqual(rl.check("k", t0), { allowed: true, retryAfterMs: 0, retryAfterSec: 0 });
  assert.deepEqual(rl.check("k", t0 + 100), { allowed: true, retryAfterMs: 0, retryAfterSec: 0 });
  const blocked = rl.check("k", t0 + 200);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 800, "800ms remain in the window");
  assert.equal(blocked.retryAfterSec, 1, "ceil(0.8s) = 1s Retry-After");
  assert.equal(rl.check("other", t0 + 300).allowed, true, "a different key is independent");
  assert.equal(rl.check("k", t0 + 1000).allowed, true, "after the window rolls, allowed again");
});

// ════════════════════════════════════════════════════════════════════════
// 4 — resolver integration: the enforcement (api/resolve.js)
// ════════════════════════════════════════════════════════════════════════
test("(a) /gests.json serves the visibility law with the stable contract", async () => {
  const r = await hit("/gests.json", { headers: { "x-forwarded-for": "203.0.113.10" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.contract, "gests.json/v1");
  const slugs = r.json.gests.map((g) => g.slug);
  assert.ok(slugs.includes("u4pub"), "public listed");
  assert.ok(slugs.includes("agentic-testing"), "real public listed");
  assert.ok(!slugs.includes("u4unl"), "unlisted absent");
  assert.ok(!slugs.includes("u4priv"), "private absent");
  assert.ok(!slugs.includes("consumer"), "unlisted (no gest id) absent");
  // the stable contract fields, on a real entry
  const agentic = r.json.gests.find((g) => g.slug === "agentic-testing");
  assert.ok(agentic.fingerprint && /^[0-9a-f]{16}$/.test(agentic.fingerprint), "fingerprint present");
  assert.equal(agentic.owner, "justin");
  assert.equal(agentic.visibility, "public");
  assert.equal(agentic.content_hash, agentic.fingerprint, "content_hash == fingerprint");
  assert.deepEqual(agentic.lineage, { gest_id: agentic.gest_id, content_hash: agentic.content_hash });
  assert.equal(r.json.count, r.json.gests.length);
});

test("(e) /gests.json?owner= scopes the ledger (tenant isolation)", async () => {
  const r = await hit("/gests.json?owner=justin", { headers: { "x-forwarded-for": "203.0.113.11" } });
  assert.equal(r.status, 200);
  assert.ok(r.json.gests.every((g) => g.owner === "justin"));
  assert.ok(!r.json.gests.some((g) => g.owner === "brandon"));
});

test("(c) a rate-limited client → 429 + Retry-After", async () => {
  process.env.GEST_RATE_MAX = "1";
  process.env.GEST_RATE_WINDOW_MS = "60000";
  const ip = { "x-forwarded-for": "203.0.113.12" };
  const first = await hit("/gests.json", { headers: ip });
  assert.equal(first.status, 200, "first request allowed");
  const second = await hit("/gests.json", { headers: ip });
  assert.equal(second.status, 429, "second request rate-limited");
  assert.ok(Number(second.headers["retry-after"]) >= 1, "Retry-After header present and >= 1s");
  assert.equal(second.json.error, "rate_limited");
});

test("(d) a write without an owner grant is refused (403)", async () => {
  const payload = { owner: "justin", gest_id: "u4w0001", fingerprint: "0123456789abcdef", visibility: "public" };
  const noAuth = await hit("/gests", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(noAuth.status, 403, "no token refused");
  const badToken = await hit("/gests", { method: "POST", body: JSON.stringify(payload), headers: { authorization: "Bearer nope" } });
  assert.equal(badToken.status, 403, "invalid token refused");
  // owner mismatch: brandon's grant cannot write a justin-owned gest
  process.env.GEST_OWNER_GRANTS = JSON.stringify({ brandon: "grant-brandon" });
  const mismatch = await hit("/gests", { method: "POST", body: JSON.stringify(payload), headers: { authorization: "Bearer grant-brandon" } });
  assert.equal(mismatch.status, 403, "owner mismatch refused");
});

test("(d) a write WITH the owner grant is accepted and lands in the ledger", async () => {
  process.env.GEST_OWNER_GRANTS = JSON.stringify({ justin: "grant-justin" });
  const payload = {
    owner: "justin",
    gest_id: "u4w0002",
    fingerprint: "0123456789abcdef",
    visibility: "public",
    title: "U4 write path",
    bluf1: "A gest armed through the owner-granted write path.",
    tagline: "write-owner",
  };
  const r = await hit("/gests", { method: "POST", body: JSON.stringify(payload), headers: { authorization: "Bearer grant-justin" } });
  assert.equal(r.status, 201, "accepted");
  assert.equal(r.json.gest.gest_id, "u4w0002");
  assert.equal(r.json.gest.content_hash, "0123456789abcdef");
  // and it is now listed in the public ledger
  const l = await hit("/gests.json", { headers: { "x-forwarded-for": "203.0.113.13" } });
  assert.ok(l.json.gests.some((g) => g.gest_id === "u4w0002"), "overlay write appears in gests.json");
});

test("(d) a valid grant with a malformed payload is refused (400), not stored", async () => {
  process.env.GEST_OWNER_GRANTS = JSON.stringify({ justin: "grant-justin" });
  const bad = await hit("/gests", { method: "POST", body: JSON.stringify({ owner: "justin" }), headers: { authorization: "Bearer grant-justin" } });
  assert.equal(bad.status, 400);
  const l = await hit("/gests.json", { headers: { "x-forwarded-for": "203.0.113.14" } });
  assert.ok(!l.json.gests.some((g) => g.gest_id === undefined), "nothing malformed stored");
});
