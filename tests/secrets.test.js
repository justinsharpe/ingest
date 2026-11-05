// tests/secrets.test.js — GEST U5: no secrets in source; planted secret caught.
// Two receipts: (1) the repo tree scans clean; (2) planted secrets are caught.
// The planted secrets are BUILT BY CONCATENATION so no literal secret string
// ever appears in this source — the repo must itself stay scan-clean.
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCAN = path.join(ROOT, "tools", "scan-secrets.py");

function scan(root) {
  return spawnSync("python3", [SCAN, "--root", root], { encoding: "utf8" });
}

test("the repo scans clean (no secrets in source)", () => {
  const r = scan(ROOT);
  assert.equal(r.status, 0, `scan found secrets:\n${r.stdout}${r.stderr}`);
});

test("a planted AWS access key is caught", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-secrets-"));
  const secret = "AKIA" + "IOSFODNN7EXAMPLE"; // concatenated — never a literal in source
  fs.writeFileSync(path.join(dir, "creds.txt"), `aws_key=${secret}\n`);
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /aws_access_key/);
});

test("a planted private key is caught", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-secrets-"));
  fs.writeFileSync(path.join(dir, "key.pem"),
    "-----BEGIN " + "RSA PRIVATE KEY-----\nabcdef\n-----END RSA PRIVATE KEY-----\n");
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /private_key_pem/);
});

test("a planted GitHub token is caught", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-secrets-"));
  const token = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 36 chars
  fs.writeFileSync(path.join(dir, ".env"), `GITHUB_TOKEN=${token}\n`);
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /github_token/);
});
