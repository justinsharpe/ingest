// tests/visibility.test.js — U3 receipts: visibility enforcement (public/unlisted/private).
// Proves the GEST-ENTERPRISE-UPLEVEL-SPEC U3 gap is closed at both choke points:
//
//   (a) private gest → 403 to an un-granted reader (--grant is the only path in)
//   (b) unlisted     → resolves by reference, but is ABSENT from the public ledger
//   (c) public       → resolves and is LISTED in the public ledger
//   (d) owner mismatch → 404 (the owner in the URL is decoration; wrong owner = not found)
//
// Two layers: pure unit tests of api/lib/visibility.js (the decision), then
// resolver-level integration tests (the enforcement) with synthetic packages
// injected into the generated PACKAGES object.
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const { visibilityOf, grantHashOf, grantMatches, access } = require("../api/lib/visibility.js");
const handler = require("../api/resolve.js");
const PACKAGES = require("../api/lib/packages.generated.js");

// ── resolver invocation helper (mirrors tests/e2e.test.js) ───────────────
function hit(url, headers = {}) {
  return new Promise((resolve) => {
    const req = { url, method: "GET", headers };
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
    handler(req, res).then(() => resolve({
      status: res.status,
      headers: res.headers || {},
      text: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8"),
    }));
  });
}

// ── synthetic packages (injected into the shared PACKAGES object) ────────
const GRANT = "open-sesame-token";
const grantHash = crypto.createHash("sha256").update(GRANT).digest("hex").slice(0, 16);

function manifest({ slug, vis, gestId, owner = "tester", grant }) {
  const visLine = vis === "private"
    ? `**Visibility:** private — ingestion requires an access grant (sha256 grant hash: \`${grant}\`).`
    : `**Visibility:** ${vis} — ingestion is open to anyone.`;
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

// Inject before any resolver test runs. Node caches modules, so resolve.js
// sees the same object this file mutated. Slugs are lowercase alphanumerics
// with a "z" prefix to avoid colliding with the real packages.
PACKAGES["zpub"] = { "INGEST.md": manifest({ slug: "zpub", vis: "public", gestId: "zpubgst1" }), "data.txt": "hello\n" };
PACKAGES["zunl"] = { "INGEST.md": manifest({ slug: "zunl", vis: "unlisted", gestId: "zunlgst1" }), "data.txt": "hello\n" };
PACKAGES["zpriv"] = { "INGEST.md": manifest({ slug: "zpriv", vis: "private", gestId: "zprvgst1", grant: grantHash }), "data.txt": "secret\n" };

// ════════════════════════════════════════════════════════════════════════
// 1 — pure unit tests: the decision (api/lib/visibility.js)
// ════════════════════════════════════════════════════════════════════════
test("visibilityOf: parses the three tiers, defaults to unlisted", () => {
  assert.equal(visibilityOf("**Visibility:** public — ..."), "public");
  assert.equal(visibilityOf("**Visibility:** unlisted — ..."), "unlisted");
  assert.equal(visibilityOf("**Visibility:** private — ..."), "private");
  assert.equal(visibilityOf("no visibility line"), "unlisted");
  assert.equal(visibilityOf(""), "unlisted");
});

test("grantHashOf: extracts the 16-hex grant hash, or null when absent", () => {
  assert.equal(grantHashOf("**Visibility:** private — ingestion requires an access grant (sha256 grant hash: `abcdef0123456789`)."), "abcdef0123456789");
  assert.equal(grantHashOf("**Visibility:** public — ..."), null);
});

test("grantMatches: correct token opens, wrong/absent token refused", () => {
  const text = `**Visibility:** private — (sha256 grant hash: \`${grantHash}\`).`;
  assert.equal(grantMatches(text, GRANT), true);
  assert.equal(grantMatches(text, "wrong-token"), false);
  assert.equal(grantMatches(text, null), false);
  assert.equal(grantMatches(text, ""), false);
});

test("access: public/unlisted allow; private gated by grant (fail closed)", () => {
  assert.deepEqual(access("**Visibility:** public — ...", null), { allow: true });
  assert.deepEqual(access("**Visibility:** unlisted — ...", null), { allow: true });
  // private: correct grant allows, absent/wrong grant denies with 403
  const priv = `**Visibility:** private — (sha256 grant hash: \`${grantHash}\`).`;
  assert.deepEqual(access(priv, GRANT), { allow: true });
  assert.deepEqual(access(priv, null), { allow: false, status: 403 });
  assert.deepEqual(access(priv, "nope"), { allow: false, status: 403 });
  // fail closed: a private gest with NO recorded hash cannot be entered at all
  assert.deepEqual(access("**Visibility:** private — (no hash).", GRANT), { allow: false, status: 403 });
});

// ════════════════════════════════════════════════════════════════════════
// 2 — resolver integration: the enforcement (api/resolve.js)
// ════════════════════════════════════════════════════════════════════════
test("(a) private gest → 403 to an un-granted reader (manifest surface)", async () => {
  const r = await hit("/zpriv", { "user-agent": "curl/8.4" });
  assert.equal(r.status, 403);
  assert.match(r.text, /private/);
  assert.doesNotMatch(r.text, /zpriv bluf body/); // no content leak
});

test("(a) private gest opens WITH the grant (?grant= query)", async () => {
  const r = await hit(`/zpriv?grant=${GRANT}`, { "user-agent": "curl/8.4" });
  assert.equal(r.status, 200);
  assert.match(r.text, /zpriv bluf body/);
});

test("(a) private gest opens WITH the grant (X-Gest-Grant header)", async () => {
  const r = await hit("/zpriv", { "user-agent": "curl/8.4", "x-gest-grant": GRANT });
  assert.equal(r.status, 200);
  assert.match(r.text, /zpriv bluf body/);
});

test("(a) private gest with a WRONG grant → 403", async () => {
  const r = await hit("/zpriv?grant=wrong-token", { "user-agent": "curl/8.4" });
  assert.equal(r.status, 403);
});

test("(a) private gest card + archive are also gated (not just the manifest)", async () => {
  const card = await hit("/zpriv", { "user-agent": "Mozilla/5.0 Safari" });
  assert.equal(card.status, 403);
  const zip = await hit("/zpriv/archive.zip", { "user-agent": "curl/8.4" });
  assert.equal(zip.status, 403);
});

test("(a) private gest-id URL (owner decoration) is gated the same way", async () => {
  const denied = await hit("/zprvgst1", { "user-agent": "curl/8.4" });
  assert.equal(denied.status, 403);
  const granted = await hit(`/zprvgst1?grant=${GRANT}`, { "user-agent": "curl/8.4" });
  assert.equal(granted.status, 200);
});

test("(d) owner mismatch → 404 (correct owner + grant still serves)", async () => {
  const wrong = await hit("/impostor/zprvgst1", { "user-agent": "curl/8.4" });
  assert.equal(wrong.status, 404);
  const rightDenied = await hit("/tester/zprvgst1", { "user-agent": "curl/8.4" });
  assert.equal(rightDenied.status, 403); // right owner, no grant
  const rightGranted = await hit(`/tester/zprvgst1?grant=${GRANT}`, { "user-agent": "curl/8.4" });
  assert.equal(rightGranted.status, 200); // right owner + grant
});

test("(b) unlisted resolves by reference but is ABSENT from the public ledger", async () => {
  const r = await hit("/zunl", { "user-agent": "curl/8.4" });
  assert.equal(r.status, 200);
  assert.match(r.text, /zunl bluf body/);

  const ledger = JSON.parse((await hit("/gests.json")).text).gests;
  assert.ok(!ledger.some((g) => g.slug === "zunl"), "unlisted must not list");
  assert.ok(!ledger.some((g) => g.slug === "zpriv"), "private must not list");
});

test("(c) public is listed in the public ledger; unlisted/private are not", async () => {
  const ledger = JSON.parse((await hit("/gests.json")).text).gests;
  assert.ok(ledger.some((g) => g.slug === "zpub"), "public must list");
  assert.ok(!ledger.some((g) => g.slug === "zunl"), "unlisted must not list");
  assert.ok(!ledger.some((g) => g.slug === "zpriv"), "private must not list");
});

test("the host index lists only public gests (unlisted/private never enumerate)", async () => {
  const idx = await hit("/", { "user-agent": "Mozilla/5.0 Safari" });
  assert.equal(idx.status, 200);
  assert.match(idx.text, /zpub/);
  assert.doesNotMatch(idx.text, /zunl/);
  assert.doesNotMatch(idx.text, /zpriv/);
});
