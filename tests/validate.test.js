// tests/validate.test.js — GEST U5: manifest schema validation.
// A malformed manifest (missing load order / file map, or a bad fingerprint)
// is rejected with exit 2 + a reason; a valid manifest passes. Exercises
// `ingest validate` — the input-validation guard over the BLUF / load-order /
// file-map schema.
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CORE = path.join(ROOT, "ingest.py");

function run(args) {
  return spawnSync("python3", [CORE, ...args], { encoding: "utf8" });
}

const VALID = `# INGEST.md — machine manifest for \`good\`

> **Package fingerprint (sha256):** \`aaaaaaaaaaaaaaaa\`

## Load order

1. BLUF (below) — the one-paragraph bottom line.
2. The files in the file map.

## BLUF

A valid fixture manifest.

## File map

- \`a.txt\` — 3 bytes
`;

function tmpManifest(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-validate-"));
  fs.writeFileSync(path.join(dir, "INGEST.md"), body);
  return dir;
}

test("a valid manifest validates (exit 0)", () => {
  const r = run(["validate", tmpManifest(VALID)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: manifest schema valid/);
});

test("a manifest missing the load order is rejected", () => {
  const dir = tmpManifest(VALID.replace(
    "## Load order\n\n1. BLUF (below) — the one-paragraph bottom line.\n2. The files in the file map.\n",
    ""));
  const r = run(["validate", dir]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Load order/);
});

test("a manifest missing the file map is rejected", () => {
  const dir = tmpManifest(VALID.replace("## File map\n\n- `a.txt` — 3 bytes\n", ""));
  const r = run(["validate", dir]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /File map/);
});

test("a manifest with a malformed fingerprint is rejected", () => {
  const dir = tmpManifest(VALID.replace("aaaaaaaaaaaaaaaa", "nothex"));
  const r = run(["validate", dir]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /fingerprint/);
});

test("the shipped example package validates (regression)", () => {
  const r = run(["validate", path.join(ROOT, "examples", "simple-package")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
