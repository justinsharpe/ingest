# ADR — U4: board/ledger hardening (viiy.to/board + gests.json as a service)

**Date:** 2026-11-04
**Status:** Proposed (builder-complete; auditor = viiy-qa per GEST-ENTERPRISE-UPLEVEL-SPEC)
**Decision-maker:** viiy-systems-dev
**Spec:** `design-references/GEST-ENTERPRISE-UPLEVEL-SPEC-2026-11-04.md` (U4)

## Context

`viiy.to/board` + `gests.json` were spec'd as the public ledger of the gest spine
(the feed engine — "feeds are boards") but never hardened. The affiliate spine
(`code > click > session > direct` attribution, lineage = `gest_id` + `content_hash`)
needs a ledger it can trust. U4 closes three gaps, each with a forced receipt:

1. no **visibility law** proven at the ledger (public listed; unlisted/private never leak);
2. no **rate limit** (a scraper could hammer the board);
3. no **write path** with owner auth (the ledger was read-only, baked at build).

## Decision

The ledger becomes a real service by factoring it out of the monolithic resolver:

- **`api/lib/ledger.js`** — pure functions over the baked `PACKAGES` map + an
  in-memory write overlay. Owns the **stable `gests.json` contract**, the
  **visibility law**, and the **write-owner auth** (fail-closed).
- **`api/lib/rate-limit.js`** — a fixed-window rate limiter (injectable clock,
  bounded store). Env-tunable: `GEST_RATE_MAX`, `GEST_RATE_WINDOW_MS`.
- **`api/resolve.js`** — wires the two modules in at the ledger routes only:
  `GET /gests.json` (rate-limited, visibility-filtered, tenant-scoped via
  `?owner=` + `?q=`), `GET /board` (rate-limited), `POST /gests` (write path,
  owner-grant-gated).

### The stable `gests.json` contract

```jsonc
{
  "contract": "gests.json/v1",
  "generated_at": "<ISO8601>",
  "count": 3,
  "visibility": { "listed": "public", "unlisted": "link-only", "private": "grant-gated" },
  "gests": [
    {
      "slug": "agentic-testing",
      "gest_id": "99q139ok8t",
      "owner": "justin",
      "visibility": "public",
      "kind": "post",
      "fingerprint": "42b5d7f1a7501cf3",   // sha256(artifact set), 16 hex (SPEC §4)
      "content_hash": "42b5d7f1a7501cf3", // == fingerprint; the lineage key
      "lineage": { "gest_id": "99q139ok8t", "content_hash": "42b5d7f1a7501cf3" },
      "title": "…", "bluf1": "…", "tagline": "…"
    }
  ]
}
```

`content_hash === fingerprint` by construction: both are `sha256(artifact set,
manifest excluded)[:16]` — the same value the event spine (`engine/share-engine/spine/spine.py`)
carries as `lineage.content_hash`. One value, two names: `fingerprint` is the
human verify surface, `content_hash` is the machine attribution surface.

### Auth: read-public, write-owner

- **Read** (`GET /gests.json`, `/board`) is public — no auth.
- **Write** (`POST /gests`) requires `Authorization: Bearer <token>` where the
  token is the grant bound to the payload's declared `owner`. Grants come from
  `GEST_OWNER_GRANTS` env (JSON `{ owner: token }`). **Fail-closed**: no grants
  configured → every write refused. Owner mismatch (token for A, payload.owner=B)
  → refused. Refusals are **403**, malformed payloads **400**, success **201**.
- The write lands in an **in-memory overlay** merged into the public ledger.
  Persistence (KV/Postgres) is a deployment toggle per the open-source law; the
  contract + refusal semantics are what U4's receipt proves.

### Rate limit

Fixed window per client (X-Forwarded-For → X-Real-IP → socket → "local").
Over the window → **429 + `Retry-After`** (seconds, ≥1). Default 60 req/min;
0 disables.

## Consequences

**Positive**
- The affiliate spine gets a trustable, machine-verifiable ledger with lineage.
- The visibility law is now *proven* at the ledger, not just named (U3 proves it
  at the resolver; U4 at the board).
- Rate limit + write auth close the two abuse surfaces (scraping, unauthorized arm).

**Negative**
- Adds two modules + a write endpoint to a repo that was read-only. In-memory
  overlay is non-durable on serverless (acceptable for the reference; durable
  deploy swaps the backing store).
- `api/resolve.js` is now the shared integration seam for U3+U4+U5 — three
  concurrent workers edit it. See "Collision & rollback".

**Neutral**
- The board HTML is unchanged; it still reads `/gests.json` client-side (the
  server-side `?owner=`/`?q=` filters are the auditable path).

## Collision & reconciliation (hotspot)

`api/resolve.js` is edited by **three concurrent builders** in the same shared
working tree: U3 (visibility enforcement — `enforceVisibility`/`forbidden`/`listSlugs`),
U4 (this ledger hardening), U5 (security headers/SSRF). My U4 edits are
**region-disjoint** from U3's (I touch only the `/gests.json` + `/board` +
`POST /gests` routes and append helpers at the file tail; U3 touches the package
routes + `serveGest` + `listSlugs`). My logic is factored into `api/lib/ledger.js`
+ `api/lib/rate-limit.js` (files no sibling touches), so the only shared file is
`resolve.js`. The ratifier reconciles the three `resolve.js` edits when merging
U3+U4+U5 — the disjoint regions merge clean.

## Rollback

Revert `api/resolve.js` (the ledger routes + helpers) and delete the two new
modules + `tests/ledger.test.js`. The prior inline `/gests.json` handler is the
fallback (it still lists public gests; it just lacks auth/rate-limit/contract).

## Receipts (builder self-verification — run, not claimed)

```
node tools/embed-packages.js && node --test tests/*.test.js
# 58 pass / 0 fail / 1 skip (includes 12 U4 tests + 20 U3 tests + existing e2e/classify/embed/zip/ingest-source)
node --test tests/ledger.test.js   # 12/12 — the three U4 receipts forced:
#   (a) /gests.json serves the visibility law (public listed; unlisted/private absent)
#   (b) stable contract: fingerprint == content_hash; lineage {gest_id, content_hash}
#   (c) rate-limited client → 429 + Retry-After
#   (d) write without owner grant → 403 (no token / bad token / owner mismatch)
#   (d') write WITH owner grant → 201, listed in the ledger
#   (e) ?owner= tenant isolation + ?q= search provenance
```

Auditor: viiy-qa (builder ≠ auditor).
