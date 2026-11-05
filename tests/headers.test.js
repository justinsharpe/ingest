// tests/headers.test.js — GEST U5: CSP + security headers on every surface.
// The resolver applies security headers once, up front, so every response
// carries them. Asserted two ways: the pure header set, and a live invocation
// of the resolver with a header-capturing mock.
const { test } = require("node:test");
const assert = require("node:assert");
const headers = require("../api/lib/headers.js");
const handler = require("../api/resolve.js");

function hit(url, headers = {}) {
  return new Promise((resolve) => {
    const req = { url, method: "GET", headers };
    const chunks = [];
    const captured = {};
    const res = {
      setHeader(name, value) { captured[name.toLowerCase()] = value; },
      writeHead(s, h) {
        this.status = s;
        const lower = {};
        for (const [k, v] of Object.entries(h || {})) lower[k.toLowerCase()] = v;
        this.headers = { ...captured, ...lower };
      },
      end(b) { chunks.push(b || ""); },
    };
    handler(req, res).then(() => resolve({
      status: res.status,
      headers: res.headers || {},
    }));
  });
}

test("securityHeaders() carries the U5 header set", () => {
  const h = headers.securityHeaders();
  assert.ok(h["Content-Security-Policy"], "CSP present");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.match(h["Referrer-Policy"], /origin/);
  assert.ok(h["Permissions-Policy"], "Permissions-Policy present");
});

test("CSP locks framing, base, object and form", () => {
  assert.match(headers.CSP, /frame-ancestors 'none'/);
  assert.match(headers.CSP, /base-uri 'none'/);
  assert.match(headers.CSP, /object-src 'none'/);
  assert.match(headers.CSP, /form-action 'none'/);
});

test("the resolver applies security headers to the card surface", async () => {
  const r = await hit("/agentic-testing", { "user-agent": "Mozilla/5.0", host: "viiy.to" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
});

test("the resolver applies security headers to the machine + error surfaces too", async () => {
  const m = await hit("/agentic-testing/INGEST.md", { "user-agent": "curl/8", host: "agnt.in" });
  assert.match(m.headers["content-security-policy"], /base-uri 'none'/);
  const nf = await hit("/nope", { "user-agent": "curl/8", host: "agnt.in" });
  assert.equal(nf.status, 404);
  assert.equal(nf.headers["x-content-type-options"], "nosniff");
});
