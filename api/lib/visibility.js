// api/lib/visibility.js — the visibility law, pure + testable.
// public | unlisted | private. Enforced at the resolver + ledger:
//   public   → resolves + lists (board / gests.json)
//   unlisted → resolves (link-only), never lists
//   private  → resolves ONLY with the correct grant (--grant is the only path in)
//
// Pure: no I/O, no request object. resolve.js wires the request; this module
// decides. Deterministic, receipt-tested (tests/visibility.test.js).
const crypto = require("crypto");

const VISIBILITY_RE = /\*\*Visibility:\*\* ([a-z]+)/;
const GRANT_HASH_RE = /sha256 grant hash: `([0-9a-f]{16})`/;

// The manifest body's visibility tier. Unmarked manifests default to unlisted
// (fail toward privacy: an unmarked gest is link-only, never listed).
function visibilityOf(text) {
  const m = (text || "").match(VISIBILITY_RE);
  return m ? m[1] : "unlisted";
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
