// tests/ssrf.test.js — GEST U5: SSRF-hardened ingest fetch (no network).
// Mirrors deltos-backend/tests/test_ssrf.py: private/loopback/link-local/ULA/
// unspecified addresses are refused BEFORE any connection, and the
// ingest-source CLI exits 2 with a reason and writes nothing. Pure-function
// checks go through tools/ssrf.py's check-ip / check-url hooks; the
// integration path goes through tools/ingest-source.py.
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SSRF = path.join(ROOT, "tools", "ssrf.py");
const TOOL = path.join(ROOT, "tools", "ingest-source.py");

function run(script, args) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8" });
}

test("validate_ip rejects private / loopback / link-local / ULA / unspecified", () => {
  const denied = [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
    "169.254.1.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::",
  ];
  for (const ip of denied) {
    const r = run(SSRF, ["check-ip", ip]);
    assert.equal(r.status, 1, `${ip} must be denied, got: ${r.stdout}`);
    assert.equal(r.stdout.trim(), "private");
  }
});

test("validate_ip accepts public unicast addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    const r = run(SSRF, ["check-ip", ip]);
    assert.equal(r.status, 0, `${ip} must be accepted, got: ${r.stdout}`);
    assert.equal(r.stdout.trim(), "public");
  }
});

test("parse_url refuses non-http schemes, userinfo, and non-default ports", () => {
  const bad = [
    "ftp://example.com/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:pass@example.com/",
    "http://example.com:8080/",
    "http://example.com/%0d%0aX-Evil:y",
  ];
  for (const u of bad) {
    const r = run(SSRF, ["check-url", u]);
    assert.equal(r.status, 1, `${u} must be refused`);
    assert.match(r.stdout, /refused/);
  }
  assert.equal(run(SSRF, ["check-url", "https://example.com/"]).status, 0);
});

test("ingest-source fetch refuses a private-address URL (exit 2, nothing written)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-ssrf-"));
  const out = path.join(tmp, "out");
  const r = run(TOOL, ["fetch", "--source", "rss", "--from", "http://127.0.0.1/feed.xml", "--out", out]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /refused|non-public/);
  const written = fs.existsSync(out) ? fs.readdirSync(out) : [];
  assert.deepEqual(written, [], "no files written from a refused fetch");
});

test("ingest-source fetch refuses a localhost URL (resolves to loopback)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-ssrf-"));
  const out = path.join(tmp, "out");
  const r = run(TOOL, ["fetch", "--source", "json", "--from", "http://localhost/x.json", "--out", out]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /refused|non-public/);
});
