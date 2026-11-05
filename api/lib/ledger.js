// api/lib/ledger.js — the board/ledger contract (GEST U4).
// Pure functions over the baked PACKAGES map + an in-memory write overlay.
// The stable gests.json contract: fingerprint, owner, visibility, content_hash
// lineage — so the affiliate spine can trust it (code > click > session > direct).
//
// Visibility law (GEST-FEED-INTEGRATION-SPEC §3 / GEST-SPINE):
//   public   — listed on the board + gests.json
//   unlisted — resolvable by reference, NEVER listed
//   private  — grant-gated, never listed, never resolvable without a grant
//
// Auth (read-public, write-owner):
//   GET /gests.json + /board are public. POST /gests requires an owner grant.
//   Grants come from GEST_OWNER_GRANTS env — a JSON map { owner: token }.
//   Fail-closed: no grants configured -> every write is refused.
//
// SPEC: design-references/GEST-ENTERPRISE-UPLEVEL-SPEC-2026-11-04.md (U4)

const MANIFEST_NAMES = ["INGEST.md", "AGENT-INGEST.md"];
const ID_RE = /^[0-9a-z]{6,14}$/;
const FP_RE = /^[0-9a-f]{16}$/;
const VISIBILITIES = ["public", "unlisted", "private"];

function decode(raw) {
  return typeof raw === "string" && raw.startsWith("__b64__")
    ? Buffer.from(raw.slice(7), "base64").toString("utf8")
    : (raw || "");
}

function manifestTextOf(packages, slug) {
  const files = packages && packages[slug];
  if (!files) return "";
  return decode(files["INGEST.md"] ?? files["AGENT-INGEST.md"] ?? "");
}

// Parse the manifest's load-bearing fields. Every regex is anchored to its
// field's own marker line (not a loose `([0-9a-f]{16})` anywhere in the text).
function parseGest(text, slug = null) {
  const pick = (re, g = 1) => (text.match(re) || [])[g] || null;
  const gest_id = pick(/\*\*Gest ID:\*\*\s*`([0-9a-z]{6,14})`/);
  const owner = (pick(/\*\*Owner:\*\*\s*([^\n]+)/) || "").trim() || null;
  const visibility = pick(/\*\*Visibility:\*\*\s*([a-z]+)/);
  const fingerprint =
    pick(/\*\*Package fingerprint \(sha256\):\*\*\s*`([0-9a-f]{16})`/) ||
    pick(/`([0-9a-f]{16})`/);
  const title = pick(/^# INGEST\.md — machine manifest for `([^`]+)`/) || slug || "package";
  const tagline = pick(/## Tagline\s*\n\n>\s*(.+)/);
  const kind = pick(/\*\*Kind:\*\*\s*([a-z-]+)/) || "post";
  const blufRaw = pick(/## BLUF\s*\n\n([\s\S]+?)(?=\n##|\Z)/) || "";
  const bluf = blufRaw.replace(/\s+/g, " ").trim();
  const bluf1 = bluf.split(/(?<=[.!?])\s/)[0] || bluf.slice(0, 160);
  return { slug, gest_id, owner, visibility, fingerprint, title, tagline, kind, bluf, bluf1 };
}

// The stable contract entry. content_hash === fingerprint: both are
// sha256(artifact set, manifest excluded), hex-truncated to 16 (SPEC §4) —
// the same value the event spine (spine.py) carries as lineage.content_hash.
function gestEntry(slug, text) {
  const g = parseGest(text, slug);
  const content_hash = g.fingerprint || null;
  return {
    slug: g.slug,
    gest_id: g.gest_id,
    owner: g.owner,
    visibility: g.visibility || "unlisted",
    kind: g.kind,
    fingerprint: g.fingerprint || null,
    content_hash,
    lineage: { gest_id: g.gest_id, content_hash },
    title: g.title,
    bluf1: g.bluf1,
    tagline: g.tagline,
  };
}

function isPublic(g) {
  return g && g.visibility === "public" && !!g.gest_id && !!g.fingerprint;
}

// The baked ledger: every public gest from the build-time package set.
function publicLedger(packages) {
  const entries = [];
  for (const slug of Object.keys(packages || {})) {
    if (slug.startsWith("__") || slug === "assets") continue;
    const text = manifestTextOf(packages, slug);
    if (!text) continue;
    const e = gestEntry(slug, text);
    if (isPublic(e)) entries.push(e);
  }
  sortLedger(entries);
  return entries;
}

function sortLedger(entries) {
  entries.sort((a, b) =>
    String(a.owner || "").localeCompare(String(b.owner || "")) ||
    String(a.gest_id || "").localeCompare(String(b.gest_id || "")));
}

// ── the write overlay (in-memory; non-durable on serverless) ──────────────
const overlay = new Map(); // gest_id -> entry

function upsertOverlay(entry) {
  overlay.set(entry.gest_id, entry);
  return entry;
}

function resetOverlay() {
  overlay.clear();
}

// Baked public gests + overlay writes, deduped by gest_id, deterministic order.
function mergedLedger(packages) {
  const list = publicLedger(packages);
  const seen = new Set(list.map((e) => e.gest_id));
  for (const e of overlay.values()) {
    if (isPublic(e) && !seen.has(e.gest_id)) {
      list.push(e);
      seen.add(e.gest_id);
    }
  }
  sortLedger(list);
  return list;
}

// Server-side filter — tenant isolation (?owner=) + search provenance (?q=).
function filterLedger(list, { owner, q } = {}) {
  let out = list;
  if (owner) {
    const o = String(owner).toLowerCase();
    out = out.filter((e) => String(e.owner || "").toLowerCase() === o);
  }
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((e) =>
      [e.owner, e.gest_id, e.title, e.bluf1, e.tagline]
        .some((f) => String(f || "").toLowerCase().includes(needle)));
  }
  return out;
}

// ── auth: read-public, write-owner ─────────────────────────────────────────
function grantsFromEnv() {
  const raw = process.env.GEST_OWNER_GRANTS;
  if (!raw) return null;
  try {
    const g = JSON.parse(raw);
    if (g && typeof g === "object" && !Array.isArray(g)) return g;
    return null;
  } catch {
    return null;
  }
}

// A write is allowed only when the bearer token is the grant bound to the
// owner the payload declares. Every other case is refused (fail-closed).
function authorizeWrite(token, owner, grants) {
  if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
    return { ok: false, reason: "writes_disabled" };
  }
  if (!token) return { ok: false, reason: "no_token" };
  const boundOwner = Object.keys(grants).find((o) => grants[o] === token);
  if (!boundOwner) return { ok: false, reason: "invalid_token" };
  if (!owner || boundOwner !== owner) {
    return { ok: false, reason: "owner_mismatch", boundOwner };
  }
  return { ok: true, owner: boundOwner };
}

function validateEntry(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["payload must be a JSON object"];
  }
  if (!ID_RE.test(payload.gest_id || "")) {
    errors.push("gest_id must be 6-14 lowercase alphanumerics");
  }
  if (!FP_RE.test(payload.fingerprint || payload.content_hash || "")) {
    errors.push("fingerprint/content_hash must be 16 hex chars");
  }
  if (!payload.owner) errors.push("owner is required");
  if (payload.visibility !== undefined && !VISIBILITIES.includes(payload.visibility)) {
    errors.push("visibility must be public|unlisted|private");
  }
  return errors;
}

// Normalize a validated write payload into a stable contract entry.
function entryFromPayload(payload) {
  const fingerprint = FP_RE.test(payload.fingerprint || "") ? payload.fingerprint : payload.content_hash;
  const content_hash = fingerprint;
  const gest_id = payload.gest_id;
  return {
    slug: payload.slug || gest_id,
    gest_id,
    owner: payload.owner,
    visibility: payload.visibility || "unlisted",
    kind: payload.kind || "post",
    fingerprint,
    content_hash,
    lineage: { gest_id, content_hash },
    title: payload.title || gest_id,
    bluf1: payload.bluf1 || "",
    tagline: payload.tagline || null,
  };
}

module.exports = {
  MANIFEST_NAMES,
  ID_RE,
  FP_RE,
  VISIBILITIES,
  decode,
  manifestTextOf,
  parseGest,
  gestEntry,
  isPublic,
  publicLedger,
  mergedLedger,
  filterLedger,
  overlay,
  upsertOverlay,
  resetOverlay,
  grantsFromEnv,
  authorizeWrite,
  validateEntry,
  entryFromPayload,
};
