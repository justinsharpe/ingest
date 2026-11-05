# Security (GEST U5)

Enterprise-grade hardening for the ingest lane: SSRF-safe fetching, manifest
input validation, response security headers, and a no-secrets gate. Mirrors
Deltos's `app/ssrf.py` policy. Builder ≠ auditor — these guards are
receipt-tested here and independently verified by `viiy-qa`.

## 1. SSRF-hardened ingest fetch (`tools/ssrf.py` + `tools/ingest-source.py`)

The source lane fetches a URL (the one-liner → `INGEST.md`, a feed, or a content
API). The fetch is hardened:

- **Scheme allowlist** — http/https only. `file://`, `ftp://`, `javascript:` etc. refused.
- **No userinfo** — `http://user:pass@host/` refused.
- **No CR/LF** — raw and percent-encoded, closed (header injection).
- **Port allowlist** — 80/443 only (a narrow allowlist, not a blacklist).
- **DNS-resolve + reject non-public** — the hostname is resolved; if **any** address
  is private/loopback/link-local/multicast/reserved/unspecified/ULA
  (`ipaddress.is_global` is False), the fetch is refused **before connecting**.
- **Re-resolve per redirect** — every redirect hop is re-resolved and re-validated
  (defeats DNS rebinding); max 3 redirects.
- **IP pinning** — the connection opens to the validated IP while Host + TLS SNI
  carry the real hostname, so no HTTP library re-resolves underneath.
- **Size cap + timeouts** — 8 MiB response cap; bounded connect/read.

**Receipt:** a manifest URL pointing at a private address is refused (exit 2,
nothing written). See `tests/ssrf.test.js`.

## 2. Manifest input validation (`ingest validate`)

`python3 ingest.py validate <dir>` parses the manifest and rejects it unless it
satisfies the schema: a 16-hex **fingerprint**, a non-empty **load order** (the
one required section), and a non-empty **file map**. BLUF is optional (degrades
gracefully). A malformed manifest is rejected with exit 2 and a named reason.

**Receipt:** a malformed manifest (missing load order / file map, or a bad
fingerprint) is rejected. See `tests/validate.test.js`.

## 3. CSP + security headers (`api/lib/headers.js`)

Applied once, up front, by the resolver — so every surface (HTML card, OG
unfurl, manifest, `gests.json`, `embed.js`, assets, 404/403) carries:

- `Content-Security-Policy` — `default-src 'none'`; inline style/script allowed
  (the surfaces are inline-heavy, and every dynamic value is already HTML-escaped);
  `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `form-action 'none'`.
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
- `Cross-Origin-Opener-Policy: same-origin`

**Receipt:** the resolver emits the header set on every surface. See
`tests/headers.test.js`. (A nonce/CSP-hash refactor of the inline handlers is
deliberately out of U5 scope.)

## 4. No secrets in source (`tools/scan-secrets.py`)

A stdlib scanner flags high-signal secret shapes — AWS access keys, GitHub/CI
tokens, `sk-*` API keys, Stripe keys, Slack tokens, Google API keys, PEM private
keys, and a narrow quoted password/api-key assignment. Conservative by design:
every pattern requires a distinctive prefix + long high-entropy body, so docs
and example fingerprints do not false-positive. Skips build output, binaries,
and VCS/dependency dirs.

**Receipt:** the repo scans clean; a planted secret is caught. See
`tests/secrets.test.js` and the CI `Secrets scan` gate.
