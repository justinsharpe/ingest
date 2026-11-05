// tests/card.test.js — the server-side card renderer (GEST U6, pure module).
// Proves the two-surfaces-one-truth law: the card + OG unfurl derive from the
// manifest (never a hand-written copy), the thumbnail rides og:image, and the
// share modal's three forms are emitted verbatim.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  manifestFields,
  shareForms,
  ogBlock,
  thumbnailImg,
  escAttr,
} = require("../api/lib/card.js");

const MANIFEST = `# INGEST.md — machine manifest for \`agentic-testing\`
> Convention: justinsharpe/ingest — INGEST.md (canonical) / AGENT-INGEST.md (alias), one schema.
> **Package fingerprint (sha256):** \`42b5d7f1a7501cf3\` — verify after transfer; if it differs, the tree changed.
> **Gest ID:** \`99q139ok8t\` — the load-bearing reference (owner in the URL is decoration).
> **Owner:** justin

**Visibility:** public — ingestion is open to anyone with the reference.
**Thumbnail:** https://viiy.to/assets/agentic-testing-thumb.png

## Load order (the one required section)

1. BLUF (below) — the one-paragraph bottom line.
2. The files in the file map, in listed order.

## BLUF

The answer to "how do we do agentic testing" as a working harness: 6-tier CI ladder.

## Tagline

> the build gate stays red until every attack is caught

## File map

- \`docs/README.md\` — 2,132 bytes
- \`docs/ops/agentic-testing.md\` — 19,605 bytes

## The one-liner

**Prompt form:** Read \`INGEST.md\` at the artifact root and execute its load order; it routes everything else.
`;

test("manifestFields parses title/BLUF/tagline/fingerprint/thumbnail FROM the manifest", () => {
  const f = manifestFields(MANIFEST);
  assert.equal(f.title, "agentic-testing");
  assert.equal(f.fp, "42b5d7f1a7501cf3");
  assert.match(f.bluf, /working harness/);
  assert.match(f.tagline, /build gate stays red/);
  assert.equal(f.thumbnail, "https://viiy.to/assets/agentic-testing-thumb.png");
  assert.equal(f.files.length, 2);
});

test("manifestFields parses a ## Thumbnail section image as the thumbnail", () => {
  const md = MANIFEST.replace(
    "**Thumbnail:** https://viiy.to/assets/agentic-testing-thumb.png",
    "## Thumbnail\n\n![the card](https://cdn.example.com/thumb.png)"
  );
  const f = manifestFields(md);
  assert.equal(f.thumbnail, "https://cdn.example.com/thumb.png");
});

test("ogBlock uses the manifest thumbnail as og:image (two-surfaces-one-truth)", () => {
  const f = manifestFields(MANIFEST);
  const og = ogBlock(f, { siteName: "viiy.to", slug: "agentic-testing", origin: "https://viiy.to" });
  assert.match(og, /property="og:image" content="https:\/\/viiy\.to\/assets\/agentic-testing-thumb\.png"/);
  assert.match(og, /property="og:title" content="agentic-testing"/);
  assert.match(og, /property="og:url" content="https:\/\/viiy\.to\/agentic-testing"/);
  assert.match(og, /name="twitter:card" content="summary_large_image"/);
});

test("ogBlock falls back to the host OG card when the manifest has no thumbnail", () => {
  const noThumb = MANIFEST.replace("**Thumbnail:** https://viiy.to/assets/agentic-testing-thumb.png\n", "");
  const f = manifestFields(noThumb);
  assert.equal(f.thumbnail, "");
  const og = ogBlock(f, {
    siteName: "viiy.to", slug: "agentic-testing", origin: "https://viiy.to",
    fallbackImage: "https://viiy.to/assets/design/og-card-owl.png",
  });
  assert.match(og, /property="og:image" content="https:\/\/viiy\.to\/assets\/design\/og-card-owl\.png"/);
});

test("thumbnailImg emits the image from the manifest, escaped (XSS law)", () => {
  const f = { thumbnail: 'x" onerror="alert(1)', title: "t" };
  const img = thumbnailImg(f);
  assert.match(img, /<img src="x&quot; onerror=&quot;alert\(1\)"/);
  assert.ok(!img.includes('<img src="x" onerror='));
});

test("thumbnailImg returns '' when the manifest carries no thumbnail", () => {
  assert.equal(thumbnailImg({ thumbnail: "" }), "");
});

test("shareForms emits exactly the three share-out forms", () => {
  const forms = shareForms("https://viiy.to/agentic-testing", "https://viiy.to");
  // one-liner (agent handoff)
  assert.equal(
    forms.oneLiner,
    "Read INGEST.md at https://viiy.to/agentic-testing/INGEST.md and execute its load order; it routes everything else."
  );
  // embed snippet (<div data-ingest>)
  assert.equal(
    forms.embedSnippet,
    '<div data-ingest="https://viiy.to/agentic-testing"></div>\n<script src="https://viiy.to/embed.js"></script>'
  );
  // direct URL
  assert.equal(forms.directUrl, "https://viiy.to/agentic-testing");
  // exactly three keys
  assert.deepEqual(Object.keys(forms).sort(), ["directUrl", "embedSnippet", "oneLiner"]);
});

test("escAttr neutralizes attribute-injection (quotes + angle brackets)", () => {
  assert.equal(escAttr('a"b<c>d&e'), "a&quot;b&lt;c&gt;d&amp;e");
});
