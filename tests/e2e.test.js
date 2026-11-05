// tests/e2e.test.js — the full resolver battery, local invocation (no server).
// Covers: the three surfaces, host identity, root /embed.js, /<slug>/archive.zip
// (byte-valid per real unzip), /<slug>/embed.js, playground, 404s.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const handler = require("../api/resolve.js");

function hit(url, headers = {}) {
  return new Promise((resolve) => {
    const req = { url, method: "GET", headers };
    const chunks = [];
    const res = {
      setHeader() {},
      writeHead(s, h) {
        this.status = s;
        // normalize header names to lowercase (what a real HTTP layer does)
        const lower = {};
        for (const [k, v] of Object.entries(h || {})) lower[k.toLowerCase()] = v;
        this.headers = lower;
      },
      end(b) { chunks.push(b || ""); },
    };
    handler(req, res).then(() => resolve({
      status: res.status,
      headers: res.headers || {},
      body: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))),
      text: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8"),
    }));
  });
}

test("three surfaces on one URL (host: viiy.to)", async () => {
  const agent = await hit("/agentic-testing", { "user-agent": "curl/8.4", host: "viiy.to" });
  assert.equal(agent.status, 200);
  assert.match(agent.text, /^# INGEST\.md — machine manifest/);
  const crawler = await hit("/agentic-testing", { "user-agent": "Twitterbot/1.0", host: "viiy.to" });
  assert.match(crawler.text, /og:title/);
  const human = await hit("/agentic-testing", { "user-agent": "Mozilla/5.0 Safari", host: "viiy.to" });
  assert.match(human.text, /<h1>/);
  assert.match(human.text, /fingerprint: 42b5d7f1a7501cf3/);
});

test("root /embed.js serves the widget host-aware", async () => {
  const r = await hit("/embed.js", { host: "viiy.to" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/javascript/);
  assert.match(r.text, /parseManifest/);
});

test("package embed.js also serves (/<slug>/embed.js)", async () => {
  const r = await hit("/agentic-testing/embed.js", { host: "agnt.in" });
  assert.equal(r.status, 200);
  assert.match(r.text, /data-ingest/);
});

test("U6: the human card emits the three share-out forms (from the manifest URL)", async () => {
  const human = await hit("/agentic-testing", { "user-agent": "Mozilla/5.0 Safari", host: "viiy.to" });
  assert.equal(human.status, 200);
  // one-liner (agent handoff) — verbatim
  assert.match(human.text, /Read INGEST\.md at https:\/\/viiy\.to\/agentic-testing\/INGEST\.md and execute its load order/);
  // embed snippet (<div data-ingest>) — esc() escaped in the <pre>
  assert.match(human.text, /&lt;div data-ingest=&quot;https:\/\/viiy\.to\/agentic-testing&quot;&gt;&lt;\/div&gt;/);
  assert.match(human.text, /&lt;script src=&quot;https:\/\/viiy\.to\/embed\.js&quot;&gt;&lt;\/script&gt;/);
  // direct URL
  assert.match(human.text, /direct URL/);
});

test("archive.zip is a real, unzip-clean zip of the artifact set", async () => {
  const r = await hit("/agentic-testing/archive.zip", { host: "viiy.to" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /application\/zip/);
  assert.match(r.headers["content-disposition"], /agentic-testing\.zip/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-e2e-"));
  const zf = path.join(tmp, "pkg.zip");
  fs.writeFileSync(zf, r.body);
  const out = execFileSync("unzip", ["-t", zf]).toString();
  assert.match(out, /No errors detected/);
  const names = execFileSync("unzip", ["-l", zf]).toString();
  assert.match(names, /agentic-testing\/INGEST\.md/);
  assert.match(names, /agentic-testing\/docs\/ops\/agentic-testing\.md/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("playground + index + 404", async () => {
  const t = await hit("/try", { "user-agent": "Mozilla/5.0", host: "agnt.in" });
  assert.equal(t.status, 200);
  const i = await hit("/", { "user-agent": "Mozilla/5.0", host: "agnt.in" });
  assert.equal(i.status, 200);
  const nf = await hit("/nope", { "user-agent": "curl/8", host: "agnt.in" });
  assert.equal(nf.status, 404);
});