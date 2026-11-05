// tests/embed-share.test.js — the embed widget's U6 share surface (no DOM).
// Proves the inline card renders FROM the manifest (title/BLUF/tagline/
// thumbnail/fingerprint all derive from parseManifest), and the share modal
// emits the three share-out forms (one-liner + embed snippet + direct URL).
const { test } = require("node:test");
const assert = require("node:assert");
const { parseManifest, shareForms, cardHTML, shareModalHTML } = require("../host/embed.js");

const MANIFEST = `# INGEST.md — machine manifest for \`agentic-testing\`
> Convention: justinsharpe/ingest — INGEST.md (canonical) / AGENT-INGEST.md (alias), one schema.
> **Package fingerprint (sha256):** \`42b5d7f1a7501cf3\` — verify after transfer; if it differs, the tree changed.

**Visibility:** unlisted — ingestion is open to anyone holding the reference (not listed/indexed).
**Thumbnail:** https://viiy.to/assets/thumb.png

## Load order (the one required section)

1. BLUF (below) — the one-paragraph bottom line.
2. The files in the file map, in listed order.

## BLUF

The answer as a working harness: 6-tier CI ladder, personas, attack fixtures, panels.

## Tagline

> the build gate stays red until every attack is caught — that's the whole personality

## File map

- \`docs/README.md\` — 2,132 bytes
- \`docs/ops/agentic-testing.md\` — 19,605 bytes

## The one-liner

**Prompt form:** Read \`INGEST.md\` at the artifact root and execute its load order; it routes everything else.
`;

const URL = "https://viiy.to/agentic-testing";
const ORIGIN = "https://viiy.to";

test("parseManifest extracts the thumbnail from the manifest", () => {
  const m = parseManifest(MANIFEST);
  assert.equal(m.thumb, "https://viiy.to/assets/thumb.png");
  assert.equal(m.title, "agentic-testing");
  assert.equal(m.fp, "42b5d7f1a7501cf3");
});

test("the inline card renders the manifest thumbnail (no hand-written copy)", () => {
  const pkg = parseManifest(MANIFEST);
  const html = cardHTML(pkg, URL);
  // every card field is the manifest's value, rendered through esc()
  assert.ok(html.includes("agentic-testing"), "title from manifest");
  assert.ok(html.includes("42b5d7f1a7501cf3"), "fingerprint from manifest");
  assert.ok(html.includes("https://viiy.to/assets/thumb.png"), "thumbnail from manifest");
  assert.ok(html.includes("ingest-share-btn"), "the share action is present");
});

test("the inline card omits the <img> when the manifest has no thumbnail", () => {
  const noThumb = MANIFEST.replace("**Thumbnail:** https://viiy.to/assets/thumb.png\n", "");
  const pkg = parseManifest(noThumb);
  assert.equal(pkg.thumb, "");
  assert.ok(!cardHTML(pkg, URL).includes("<img src="));
});

test("shareForms emits exactly the three share-out forms", () => {
  const forms = shareForms(URL, ORIGIN);
  assert.equal(forms.directUrl, URL);
  assert.equal(forms.oneLiner, "Read INGEST.md at https://viiy.to/agentic-testing/INGEST.md and execute its load order; it routes everything else.");
  assert.equal(forms.embedSnippet, '<div data-ingest="https://viiy.to/agentic-testing"></div>\n<script src="https://viiy.to/embed.js"></script>');
  assert.deepEqual(Object.keys(forms).sort(), ["directUrl", "embedSnippet", "oneLiner"]);
});

test("the share modal emits all three forms with a copy affordance", () => {
  const pkg = parseManifest(MANIFEST);
  const html = shareModalHTML(pkg, URL, ORIGIN);
  // the three forms, each present (the embed snippet is HTML-escaped in <pre>)
  assert.ok(html.includes("Read INGEST.md at https://viiy.to/agentic-testing/INGEST.md"), "one-liner");
  assert.ok(html.includes('&lt;div data-ingest=&quot;https://viiy.to/agentic-testing&quot;&gt;&lt;/div&gt;'), "embed snippet");
  assert.ok(html.includes("https://viiy.to/agentic-testing"), "direct URL");
  // three copy buttons, one per form
  const copyCount = (html.match(/ingest-copy-btn/g) || []).length;
  assert.equal(copyCount, 3);
  // the fingerprint rides the modal header (two-surfaces-one-truth)
  assert.ok(html.includes("42b5d7f1a7501cf3"));
});

test("the share modal escapes hostile manifest values (XSS law)", () => {
  const evil = MANIFEST.replace("agentic-testing", "x\"><script>alert(1)</script>");
  const pkg = parseManifest(evil);
  const html = shareModalHTML(pkg, URL, ORIGIN);
  assert.ok(!html.includes('<script>alert(1)</script>'));
});
