# INGEST.md — machine manifest for `simple-package`

> Convention: justinsharpe/ingest — INGEST.md (canonical) / AGENT-INGEST.md (alias), one schema.
> **Package fingerprint (sha256):** `e19926789c46d428` — verify after transfer; if it differs, the tree changed.

**Visibility:** unlisted — ingestion is open to anyone holding the reference (not listed/indexed).

## Load order (the one required section)

1. BLUF (below) — the one-paragraph bottom line.
2. The files in the file map, in listed order.


## BLUF

A minimal example: one README, one data file, one fingerprint.

## File map

- `README.md` — 23 bytes
- `data.txt` — 8 bytes
- `share-card.html` — 1,083 bytes
- `share-card.png` — 41,880 bytes

## The one-liner

**Prompt form:** Read `INGEST.md` at the artifact root and execute its load order; it routes everything else.
**CLI form:** `ingest <dir>` — this reference tool reads the manifest.
