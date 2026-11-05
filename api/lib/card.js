// api/lib/card.js — the card renderer (GEST U6). Pure, testable, single source
// of truth for "the card renders FROM the manifest" (two-surfaces-one-truth).
//
// One URL, three readers: crawlers get OG (ogBlock), humans get the card
// (cardFields -> the host page body), agents get INGEST.md (the manifest text).
// The card is NEVER a hand-written copy: every field the human or the crawler
// sees is parsed from the manifest text — title, BLUF, tagline, thumbnail, and
// fingerprint all ride the manifest and only the manifest.
//
// SPEC: design-references/GEST-ENTERPRISE-UPLEVEL-SPEC-2026-11-04.md (U6) +
// GEST-SPINE-ARCHITECTURE-SPEC-2026-11-04.md (the card object).

// The manifest's load-bearing card fields. Every regex is anchored to its own
// field marker; none is a loose scan for a 16-hex run anywhere in the text.
// The `## Thumbnail` section carries an optional image reference; when absent,
// thumbnail is "" and the host falls back to the default OG card.
function manifestFields(text) {
  const t = text || "";
  const pick = (re, g = 1) => (t.match(re) || [])[g] || "";
  const fp = pick(/\*\*Package fingerprint \(sha256\):\*\*\s*`([0-9a-f]{16})`/) ||
    pick(/`([0-9a-f]{16})`/);
  const blufRaw = pick(/## BLUF\s*\n\n([\s\S]+?)(?=\n##|\n\Z|\Z)/);
  const bluf = blufRaw.replace(/\s+/g, " ").trim();
  const bluf1 = bluf.split(/(?<=[.!?])\s/)[0] || bluf.slice(0, 160);
  const files = [...t.matchAll(/^- `([^`]+)` — ([\d,]+) bytes/gm)]
    .map((m) => ({ path: m[1], size: m[2] }));
  const title = pick(/^# INGEST\.md — machine manifest for `([^`]+)`/) || "package";
  const tagline = pick(/## (?:Tagline|Quip)\s*\n\n>\s*(.+)/);
  // Thumbnail: a `**Thumbnail:**` metadata line (preferred, matches the
  // `**Visibility:**`/`**Owner:**` style) or a `## Thumbnail` section's first
  // `![...](...)` image. Value is an absolute URL or a package-relative path.
  const thumbnail =
    pick(/\*\*Thumbnail:\*\*\s*([^\s\n]+)/) ||
    pick(/## Thumbnail\s*\n\n!\[[^\]]*\]\(([^)\s]+)\)/);
  return { fp, bluf, bluf1, files, title, tagline, thumbnail };
}

// The three share-out forms (U6 receipt b): the one-liner (agent handoff), the
// `<div data-ingest>` embed snippet (drop-in inline card), and the direct URL.
// All three are equivalent entry points; the manifest is the single source.
function shareForms(url, origin) {
  const directUrl = url;
  const oneLiner = `Read INGEST.md at ${url}/INGEST.md and execute its load order; it routes everything else.`;
  const embedSnippet = `<div data-ingest="${url}"></div>\n<script src="${origin}/embed.js"></script>`;
  return { oneLiner, embedSnippet, directUrl };
}

// The OG / Twitter unfurl block (crawler surface). og:image prefers the
// manifest's thumbnail; when the gest carries none, it falls back to the host
// OG card — so the crawler's unfurl and the human's card can never disagree on
// the thumbnail (both derive from the manifest).
function ogBlock(f, { siteName = "", slug = "", origin = "", fallbackImage = "" } = {}) {
  const base = slug && origin ? `${origin}/${slug}` : "";
  const image = f.thumbnail || fallbackImage || (origin ? `${origin}/assets/og-card.png` : "");
  return `
<meta property="og:title" content="${escAttr(f.title)}">
<meta property="og:description" content="${escAttr(f.bluf1)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${escAttr(base)}">
<meta property="og:image" content="${escAttr(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Share card: ${escAttr(f.title)}, one-paragraph summary, and sha256 fingerprint on a dark background.">
<meta property="og:site_name" content="${escAttr(siteName)}">
<meta name="twitter:card" content="summary_large_image">`;
}

// The thumbnail element for the human card body, when the manifest carries one.
// Returns "" when absent — the host then omits the image entirely.
function thumbnailImg(f, { alt = "" } = {}) {
  if (!f.thumbnail) return "";
  return `<img src="${escAttr(f.thumbnail)}" alt="${escAttr(alt || f.title)}" class="thumb" loading="lazy">`;
}

// XSS law: attribute/HTML interpolation escapes quotes + angle brackets so a
// hostile manifest value (title/BLUF/thumbnail) can never break out of the tag
// or inject markup. This is the same esc() contract as the host page + embed.js.
function escAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = { manifestFields, shareForms, ogBlock, thumbnailImg, escAttr };
