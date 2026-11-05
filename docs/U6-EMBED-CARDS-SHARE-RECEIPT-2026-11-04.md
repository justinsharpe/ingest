# GEST U6 — Embed / Cards / Share Surface (the Twitter-like inline layer)

**Standard:** enterprise-grade, per `design-references/GEST-ENTERPRISE-UPLEVEL-SPEC-2026-11-04.md` (U6) + `GEST-SPINE-ARCHITECTURE-SPEC-2026-11-04.md` (the card object).
**Builder:** viiy-feature-dev · **Auditor:** viiy-qa (builder ≠ auditor).

## What was built

Three surfaces, one truth — the card renders FROM the manifest; a gest can be dropped
into an article the way a tweet can, and shared out three ways.

### (a) `embed.js` — the inline widget
- `<div data-ingest="URL"></div>` + `<script src="HOST/embed.js">` renders a gest card
  inline from the manifest: **title, BLUF, tagline, thumbnail, fingerprint**, plus the
  file count and visibility.
- The thumbnail (`**Thumbnail:**` in the manifest) now renders as an `<img>` in the card.
- A **Share** button sits in the card footer (quip + action), opening the share modal.

### (b) The share modal — three share-out forms
- A share action emits exactly three equivalent forms, each with a copy affordance:
  1. **one-liner** (agent handoff): `Read INGEST.md at <url>/INGEST.md and execute its load order; it routes everything else.`
  2. **embed snippet**: `<div data-ingest="<url>"></div>\n<script src="<origin>/embed.js"></script>`
  3. **direct URL**: `<url>`
- The same three forms render on the server card page (static), so the card page and
  the widget agree.

### (c) The card renderer — two-surfaces-one-truth
- New pure module `api/lib/card.js` (`manifestFields`, `ogBlock`, `thumbnailImg`,
  `shareForms`, `escAttr`) — the single source of truth for "the card derives from the
  manifest, never a hand-written copy".
- `api/resolve.js` now imports it: `manifestFields` (replacing the inline copy),
  `ogBlock` (og:image prefers the manifest thumbnail, falls back to the host owl card),
  `thumbnailImg` (the human card's `<img>`).
- `ingest.py init --thumbnail <url>` stamps the `**Thumbnail:**` line; `schema/ingest-manifest.schema.json`
  gains the optional `thumbnail` field.

## The thumbnail contract

- Manifest field: `**Thumbnail:** <url-or-path>` (metadata line, matching `**Visibility:**` /
  `**Owner:**` / `**Gest ID:**` style) — or a `## Thumbnail` section's first `![...](...)` image.
- Rides both surfaces: the human card renders it; the crawler's `og:image` uses it.
- Absent → the host falls back to the owl OG card. No disagreement possible.

## Receipts (all forced, not asserted)

| # | Receipt | Proof |
|---|---|---|
| 1 | embedded gest renders the card FROM the manifest (no disagreement) | `tests/embed-share.test.js` — `cardHTML(parseManifest(manifest))` contains the manifest's title/fp/thumbnail; omits `<img>` when the manifest has none |
| 2 | share modal produces all three forms | `tests/card.test.js` + `tests/embed-share.test.js` — `shareForms()` returns exactly `{oneLiner, embedSnippet, directUrl}`; `shareModalHTML` emits all three with 3 copy buttons |
| 3 | crawler gets OG, agent gets INGEST.md | `tests/e2e.test.js` "three surfaces on one URL" + `tests/card.test.js` `ogBlock` (og:image = manifest thumbnail) |
| 4 | card never a hand-written copy | `tests/card.test.js` — every card/OG field is parsed from the manifest text; a changed manifest thumbnail changes `og:image` |

**Test totals (local, node v22):** `card.test.js` + `embed-share.test.js` + `embed-parse.test.js`
+ `e2e.test.js` + `classify.test.js` = **33/33 pass**. Full suite = 93 pass / 1 fail / 1 skip —
the single failure is a pre-existing uncommitted U3 sibling probe
(`tests/visibility.test.js` "(a) no-space private line") that asserts `/top-secret/` against a
manifest response whose text never contains it; unrelated to U6 (see handoff note).

## Files changed

- `host/embed.js` — thumbnail parse/render, `shareForms`, `shareModalHTML`, Share button + modal wiring.
- `api/lib/card.js` — NEW pure card renderer (manifestFields / ogBlock / thumbnailImg / shareForms / escAttr).
- `api/resolve.js` — import card.js; cardHTML uses `ogBlock` + `thumbnailImg` + the three share forms.
- `ingest.py` — `--thumbnail` flag → `**Thumbnail:**` line.
- `schema/ingest-manifest.schema.json` — optional `thumbnail` field.
- `tests/card.test.js`, `tests/embed-share.test.js` — NEW; `tests/e2e.test.js` — +1 U6 receipt test.

## Handoff

- Builder ≠ auditor: audit by viiy-qa (U1–U6 per the uplevel spec owners).
- Left uncommitted in the shared checkout (sibling U3/U4/U5 WIP present); regenerate
  `api/lib/packages.generated.js` via `node tools/embed-packages.js` before deploy (CI does this).
- A stray 6-byte `.u6-probe.txt` at the repo root is a terminal-boundary probe artifact — delete it.
