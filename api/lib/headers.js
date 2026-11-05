// api/lib/headers.js — security headers for every surface (GEST U5).
// Applied once at the top of the resolver so every response (HTML card, OG
// unfurl, manifest, gests.json, embed.js, assets, 404/403) carries them.
//
// CSP note: the surfaces are inline-script/inline-style heavy (board search,
// demo embed), so script-src/style-src allow 'unsafe-inline'. That is not a
// blank check: every dynamic value interpolated into a template is already
// HTML-escaped (esc() in resolve.js, embed.js), frame-ancestors/base-uri/
// object-src/form-action are locked, no external subresource origin is granted,
// and connect-src stays 'self'. The remaining hardening (SSRF fetch, no-secrets
// scan, manifest schema) closes the input + egress surface; a nonce/CSP-hash
// refactor of the inline handlers is deliberately out of U5 scope.

const CSP = [
  "default-src 'none'",
  "img-src 'self' data: https:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join("; ");

function securityHeaders() {
  return {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

// Apply to a Node http.ServerResponse (or Vercel's response object). Idempotent
// and non-throwing (test stubs may not implement setHeader). Call once before
// any writeHead so every later writeHead/end carries them.
function applySecurityHeaders(res) {
  const headers = securityHeaders();
  for (const [name, value] of Object.entries(headers)) {
    try {
      res.setHeader(name, value);
    } catch {
      // non-settable response (test stub) — ignore
    }
  }
}

module.exports = { securityHeaders, applySecurityHeaders, CSP };
