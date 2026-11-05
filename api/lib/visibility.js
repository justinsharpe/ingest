// api/lib/visibility.js — the visibility law, pure + testable.
// public | unlisted | private. Enforced at the resolver + ledger:
//   public   → resolves + lists (board / gests.json)
//   unlisted → resolves (link-only), never lists
//   private  → resolves ONLY with the correct grant (--grant is the only path in)
//
// Pure: no I/O, no request object. resolve.js wires the request; this module
// decides. Deterministic, receipt-tested (tests/visibility.test.js).
const crypto = require("crypto");

const VISIBILITY_RE = /\*\*Visibility:\*\*\s*([a-z]+)/i;
const GRANT_HASH_RE = /sha256 grant hash: `([0-9a-f]{16})`/;

// The manifest body's visibility tier. Unmarked manifests default to unlisted
// (fail toward privacy: an unmarked gest is link-only, never listed).
//
// Grammar parity with the CLI: ingest.py parses this field with `\s*([a-z]+)`
// (zero-or-more whitespace). The resolver must agree, so a manifest line
// `**Visibility:**private` (no space), double-space, or tab — which the CLI
// reads as "private" — is enforced as private HERE, never silently downgraded
// to the (link-only-but-resolvable) "unlisted" default. Case is normalized
// (the /i flag + toLowerCase) so a hand-edited "Private"/"PRIVATE" still gates
// fail-closed instead of downgrading; only the three named tiers are meaningful.
function visibilityOf(text) {
  const m = (text || "").match(VISIBILITY_RE);
  if (!m) return "unlisted";
  const v = m[1].toLowerCase();
  return v === "public" || v === "unlisted" || v === "private" ? v : "unlisted";
}

// The stored grant hash (sha256 of the grant token, first 16 hex), or null
// when the manifest records none. Only `private` gests carry one.
function grantHashOf(text) {
  const m = (text || "").match(GRANT_HASH_RE);
  return m ? m[1] : null;
}

// Does the presented grant token open this manifest? Fail closed: no token,
// or a private gest with no recorded hash, is a refusal — never a bypass.
function grantMatches(text, token) {
  const want = grantHashOf(text);
  if (!want || token == null) return false;
  const got = crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
  return got === want;
}

// The single access decision the resolver consults:
//   { allow: true }              → public/unlisted, or private with a valid grant
//   { allow: false, status: 403 } → private without a valid grant
function access(text, token) {
  if (visibilityOf(text) !== "private") return { allow: true };
  if (grantMatches(text, token)) return { allow: true };
  return { allow: false, status: 403 };
}

module.exports = { visibilityOf, grantHashOf, grantMatches, access };
