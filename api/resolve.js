// api/resolve.js — the UA-aware resolver (Vercel serverless function).
// One URL, three readers: crawlers get OG, agents get the manifest, humans get the card.
// Public crown: agnt.in ("agent ingest" — the AGENT-INGEST.md alias as a domain).
// ingest.my + ingest.fm alias the crown; viiy.to is the personal host.

const { classify, TRY } = require("./lib/classify.js");
const PACKAGES = require("./lib/packages.generated.js");
const { zipBuild } = require("./lib/zip.js");

// In production, slugs map to package dirs under /packages at build time —
// tools/embed-packages.js bakes them into api/lib/packages.generated.js, so
// the resolver never touches the filesystem at runtime (cwd is / on Vercel).

const SITE = {
  name: "agnt.in",
  tagline: "INGEST.md — the shareable-artifact manifest convention",
  repo: "https://github.com/justinsharpe/ingest",
};

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  // root /embed.js — the widget (host-aware: ORIGIN = the serving host)
  if (url.pathname === "/embed.js") {
    const js = readPackageFile("__host", "embed.js");
    if (!js) return notFound(res, "embed.js");
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(js.text);
  }
  const { view, slug, file } = classify(url.pathname, req.headers);
  const host = ((req.headers.host || req.headers.Host || "") || "").toLowerCase();
  // Host-aware site naming: our family serves under their own name (the
  // crown agnt.in lands from Sedo transfer; until then fm/my/viiy are the
  // live hosts and must not advertise a domain that doesn't answer yet).
  const FAMILY = ["agnt.in", "gest.to", "ingest.fm", "ingest.my", "www.gest.to", "www.ingest.fm", "www.ingest.my"];
  const personal = host.endsWith("viiy.to");
  const siteName = FAMILY.includes(host) || personal ? host : SITE.name;

  // share_opened fires on every resolution (implementation-side; the spec
  // only names the events — how we record them is ours).
  try {
    res.setHeader("X-Ingest-Fm", `view=${view} slug=${slug || "-"}`);
  } catch {}

  const html = (body, status = 200) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  };

  // ── the demo page — the embed, live, on our own host (guarded: a single
  //    path segment that classify would otherwise treat as a package slug) ──
  if (url.pathname === "/demo") {
    const origin = `https://${siteName}`;
    return html(demoHTML(origin, siteName));
  }

  // ── the machine ledger — every public gest, JSON (agents + integrations) ──
  if (url.pathname === "/gests.json") {
    const ledger = Object.entries(PACKAGES)
      .filter(([slug]) => !slug.startsWith("__") && slug !== "assets")
      .map(([slug, files]) => {
        const m = files["INGEST.md"] || files["AGENT-INGEST.md"] || "";
        const text = typeof m === "string" && m.startsWith("__b64__") ? Buffer.from(m.slice(7), "base64").toString("utf8") : (m || "");
        const f = manifestFields(text);
        return {
          slug,
          gest_id: (text.match(/\*\*Gest ID:\*\* `([0-9a-z]{6,14})`/) || [])[1] || null,
          owner: (text.match(/\*\*Owner:\*\* ([^\n]+)/) || [])[1] || null,
          title: f.title,
          bluf1: f.bluf1,
          tagline: f.tagline || null,
          fingerprint: f.fp,
          visibility: (text.match(/\*\*Visibility:\*\* ([a-z]+)/) || [])[1] || "unlisted",
        };
      })
      .filter((g) => g.gest_id && g.visibility === "public");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ gests: ledger }, null, 1));
  }

  // ── the board — the human ledger (search/filterable, public gests only) ──
  if (url.pathname === "/board") {
    const origin = `https://${siteName}`;
    return html(boardHTML(origin, siteName));
  }

  // ── owner-scoped routing: /<owner>/<gest-id> and /<gest-id> both resolve;
  //    the ID is load-bearing, the owner is decoration (the x.com/i/status law) ──
  {
    const segs = url.pathname.split("/").filter(Boolean);
    const gestIdRe = /^[0-9a-z]{6,14}$/;
    if (segs.length === 1 && gestIdRe.test(segs[0]) && !PACKAGES[segs[0]]) {
      const hit = findByGestId(segs[0]);
      if (hit) return serveGest(req, res, hit.slug, siteName, host);
      return notFound(res, segs[0]);
    }
    if (segs.length === 2 && gestIdRe.test(segs[1])) {
      const hit = findByGestId(segs[1]);
      if (hit && ownerOf(hit.slug) === segs[0].toLowerCase()) return serveGest(req, res, hit.slug, siteName, host);
      return notFound(res, segs.join("/"));
    }
  }

  // ── static assets (the gest mark + OG cards) ─────────────────────
  if (url.pathname.startsWith("/assets/")) {
    // support one subdirectory level (assets/design/...): sanitize each
    // segment, never let a segment escape the assets root
    const segs = url.pathname.slice("/assets/".length).split("/")
      .filter(Boolean)
      .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, ""))
      .filter(Boolean);
    if (segs.length === 0 || segs.length > 2) return notFound(res, "assets", url.pathname);
    const file = segs[segs.length - 1];
    const dir = segs.length === 2 ? segs[0] + "/" : "";
    const key = dir + file;
    const raw = PACKAGES.assets && PACKAGES.assets[key];
    if (raw) {
      const isB64 = typeof raw === "string" && raw.startsWith("__b64__");
      const body = isB64 ? Buffer.from(raw.slice(7), "base64") : Buffer.from(String(raw), "utf8");
      res.writeHead(200, {
        "Content-Type": file.endsWith(".svg") ? "image/svg+xml" : "image/png",
        "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*",
      });
      return res.end(body);
    }
    return notFound(res, "assets", file);
  }

  // ── package routes ─────────────────────────────────────────────
  if (view === "manifest") {
    const manifest = readPackageFile(slug, file || "INGEST.md");
    if (!manifest) return notFound(res, slug);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Robots-Tag": "noindex",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(manifest.text);
  }

  if (view === "og" || view === "card") {
    const manifest = readPackageFile(slug, "INGEST.md");
    if (!manifest) return notFound(res, slug);
    const cardPage = cardHTML(manifest, {
      ogOnly: view === "og",
      siteName,
      slug,
      origin: `https://${host}`,
    });
    return html(cardPage);
  }

  if (view === "file") {
    // one-click install: the whole artifact set as a deterministic zip
    if (file === "archive.zip") {
      const entries = PACKAGES[slug];
      if (!entries) return notFound(res, slug);
      const zip = zipBuild(
        Object.entries(entries).map(([name, raw]) => ({
          name: `${slug}/${name}`,
          data: typeof raw === "string" && raw.startsWith("__b64__")
            ? Buffer.from(raw.slice(7), "base64")
            : Buffer.from(raw, "utf8"),
        }))
      );
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${slug}.zip"`,
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(zip);
    }
    // the embed widget, served host-aware (the ORIGIN is the serving host)
    if (file === "embed.js") {
      const js = readPackageFile("__host", "embed.js");
      if (!js) return notFound(res, slug, file);
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(js.text);
    }
    const data = readPackageFile(slug, file);
    if (!data) return notFound(res, slug, file);
    const types = {
      ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
      ".jsonl": "text/plain", ".png": "image/png", ".jpg": "image/jpeg",
      ".mp4": "video/mp4", ".html": "text/html", ".csv": "text/csv",
      ".zip": "application/zip", ".py": "text/plain", ".js": "text/javascript",
    };
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const blob = readPackageFile(slug, file);
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
    return res.end(blob.text);
  }

  // ── playground ────────────────────────────────────────────────
  if (view === TRY) {
    const origin = `https://${siteName}`;
    return html(tryHTML(origin, siteName));
  }

  // ── index ──────────────────────────────────────────────────────
  const slugs = listSlugs();
  return html(indexHTML(slugs, siteName));
};


// ── gest-id helpers (the ID is load-bearing; owner is decoration) ──
function manifestOf(slug) {
  const files = PACKAGES[slug];
  if (!files) return { text: "" };
  const m = files["INGEST.md"] || files["AGENT-INGEST.md"] || "";
  return { text: typeof m === "string" && m.startsWith("__b64__") ? Buffer.from(m.slice(7), "base64").toString("utf8") : (m || "") };
}

function findByGestId(id) {
  for (const slug of Object.keys(PACKAGES)) {
    if (slug.startsWith("__") || slug === "assets") continue;
    const t = manifestOf(slug).text;
    const gid = (t.match(/\*\*Gest ID:\*\* `([0-9a-z]{6,14})`/) || [])[1];
    if (gid === id) return { slug, text: t };
  }
  return null;
}

function ownerOf(slug) {
  const t = manifestOf(slug).text;
  return ((t.match(/\*\*Owner:\*\* ([^\n]+)/) || [])[1] || "").trim().toLowerCase();
}

// owner/id serving: same three surfaces, same code path as slug serving
function serveGest(req, res, slug, siteName, host) {
  const { classify } = require("./lib/classify.js");
  const url = new URL(req.url, "http://x");
  const { view } = classify(url.pathname, req.headers);
  // strip owner/id segments → route as the package's own paths
  const origin = `https://${host}`;
  const m = manifestOf(slug);
  if (!m.text) return notFound(res, slug);
  const f = manifestFields(m.text);
  if (view === "manifest" || isAgent(req.headers)) {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "X-Robots-Tag": "noindex", "Access-Control-Allow-Origin": "*" });
    return res.end(m.text);
  }
  if (isCardCrawler((req.headers["user-agent"] || "").toString())) {
    return htmlWrap(res, cardHTML({ text: m.text }, { ogOnly: true, siteName, slug, origin: `https://${siteName}` }));
  }
  return htmlWrap(res, cardHTML({ text: m.text }, { ogOnly: false, siteName, slug, origin: `https://${siteName}` }));
}
function isAgent(headers) {
  const ua = (headers["user-agent"] || "").toString();
  return !ua || /curl|wget|python|node|httpx|OpenAI|Anthropic/i.test(ua);
}
function isCardCrawler(ua) {
  return /Twitterbot|facebookexternalhit|Discord|Slack|TelegramBot|LinkedInBot|Googlebot/i.test(ua);
}
function htmlWrap(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

// ── the post surface (v1.2): paste blocks on the card page ──────────
// Clicking the post loads the code; pasting the URL works all the same.
function pasteBlocks(slug, origin, repo) {
  const url = `${origin}/${slug}`;
  const r = repo || `https://github.com/justinsharpe/${slug}`;
  return `
<h2>Paste-ready (all equivalent)</h2>
<p><b>Terminal:</b></p>
<pre><code>git clone ${r} ~/${slug} && bash ~/${slug}/install.sh && python3 ~/${slug}/source.py &lt;target&gt; --full</code></pre>
<p><b>Any AI agent:</b></p>
<pre><code>Read ${url}/INGEST.md and execute its load order; it routes everything else.</code></pre>
<p><b>Claude Code / Cursor / OpenClaw / VS Code / Hermes:</b></p>
<pre><code>git clone ${r} ~/${slug} && bash ~/${slug}/install-everywhere.sh</code></pre>`;
}

// ── helpers ──────────────────────────────────────────────────────
function readPackageFile(slug, file) {
  if (!slug) return null;
  const safeSlug = String(slug).replace(/[^a-zA-Z0-9._-]/g, "");
  const safeFile = (file || "").replace(/[^a-zA-Z0-9._\/-]/g, "").replace(/\.+/g, ".").replace(/\/{2,}/g, "/");
  if (!safeSlug || !safeFile || safeFile.includes("..")) return null;
  const entry = PACKAGES[safeSlug];
  if (!entry) return null;
  const raw = entry[safeFile];
  if (raw == null) return null;
  const text = typeof raw === "string" && raw.startsWith("__b64__")
    ? Buffer.from(raw.slice(7), "base64").toString("utf8")
    : raw;
  return { text };
}

function listSlugs() {
  return Object.keys(PACKAGES);
}

function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function notFound(res, slug, file) {
  // quip (the Sept-19 microcopy law): our lingo at the touchpoints
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>not found — agnt.in</title></head>
<body style="font-family:ui-monospace,monospace;background:#0d1117;color:#e6edf3;padding:8vh 24px">
<h2>404</h2><p><i>even the best tales wander off sometimes</i></p>
<p>No package <code>${esc(slug || "")}</code>${file ? ` / <code>${esc(file)}</code>` : ""} here.</p>
<p><a style="color:#58a6ff" href="/">← agnt.in</a></p></body></html>`;
  res.writeHead(404, { "Content-Type": "" + "text/html; charset=utf-8" });
  res.end(body);
}

function manifestFields(text) {
  const fp = (text.match(/`([0-9a-f]{16})`/) || [])[1] || "";
  const bluf = (text.match(/## BLUF\s*\n\n([\s\S]+?)(?:\n\n|\Z)/) || [])[1] || "";
  const bluf1 = bluf.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] || bluf.slice(0, 160);
  const files = [...text.matchAll(/^- `([^`]+)` — ([\d,]+) bytes/gm)].map((m) => ({ path: m[1], size: m[2] }));
  const title = (text.match(/^# INGEST\.md — machine manifest for `([^`]+)`/) || [])[1] || "package";
  const tagline = (text.match(/## (?:Tagline|Quip)\s*\n\n> ?(.+)/) || [])[1] || "";
  return { fp, bluf: bluf.replace(/\s+/g, " ").trim(), bluf1, files, title, tagline };
}

function cardHTML(m, { ogOnly = false, siteName, slug, origin } = {}) {
  const f = manifestFields(m.text);
  const canonical = m.text.includes("AGENT-INGEST.md") ? "INGEST.md" : "INGEST.md";
  // Watchman is the primary ingest mark everywhere (reverted 2026-10-17 per
  // Justin); gestowl stays in assets/ as the secondary gest mark for gests.
  const brandIcon = "/assets/owl-brand-48.png";
  const ogCard = "/assets/design/og-card-owl.png";
  const brandAlt = "The Watchman owl — the ingest mark";
  // Absolute share URLs — relative links break at no-trailing-slash package URLs
  // (Reader-style proxies and LLMs follow links verbatim).
  const base = slug && origin ? `${origin}/${slug}` : "";
  const manifestHref = base ? `${base}/INGEST.md` : "./INGEST.md";
  const ogBlock = `
<meta property="og:title" content="${esc(f.title)}">
<meta property="og:description" content="${esc(f.bluf1)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base)}">
<meta property="og:image" content="${esc(m.image || (origin + ogCard))}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Share card: ${esc(f.title)}, one-paragraph summary, and sha256 fingerprint on a dark background.">
<meta property="og:site_name" content="${esc(siteName)}">
<meta name="twitter:card" content="summary_large_image">`;
  const logoSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="34" height="34" style="border-radius:9px;background:#161b22">
    <path d="M17 39 a15 15 0 0 0 30 0" fill="none" stroke="#58a6ff" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="32" cy="26" r="5.5" fill="#ff8c66"/>
    <circle cx="32" cy="17.5" r="1.8" fill="#ff8c66" opacity="0.35"/>
  </svg>`;
  const style = `<style>
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
  .brand .name { font-family:ui-monospace,Menlo,Consolas,monospace; color:#8b949e; font-size:14px; letter-spacing:0.06em; }
  body { margin:0; font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; background:#0d1117; color:#e6edf3; }
  .card { max-width:640px; margin:8vh auto; padding:0 24px 48px; }
  h1 { font-size:34px; margin:0 0 8px; } .sub { color:#8b949e; font-size:15px; margin-bottom:28px; }
  .tagline { color:#79c0ff; font-style:italic; font-size:16px; margin:-14px 0 22px; }
  .bluf { font-size:17px; line-height:1.6; color:#c9d1d9; margin-bottom:28px; }
  .fp { font-family:ui-monospace,Menlo,Consolas,monospace; color:#58a6ff; font-size:14px; }
  .fphint { color:#8b949e; font-size:12px; font-style:italic; margin:4px 0 32px; }
  .oneliner { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:14px 16px;
              font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; color:#e6edf3; }
  .oneliner b { color:#58a6ff; }
  .files { margin:32px 0 0; font-size:13px; color:#8b949e; font-family:ui-monospace,monospace; line-height:1.8; }
  a { color:#58a6ff; text-decoration:none; }
</style>`;
  const body = `
<div class="card">
  <div class="brand"><img src="${brandIcon}" width="40" height="40" alt="${brandAlt}" style="image-rendering:-webkit-optimize-contrast"><span class="name">gest · INGEST.md</span></div>
  <h1>${esc(f.title)}</h1>
  <div class="sub">A gest — a shareable package any agent can ingest · INGEST.md convention · ${esc(siteName)}</div>
  ${f.tagline ? `<div class="tagline">&gt; ${esc(f.tagline)}</div>` : ""}
  <div class="bluf">${esc(f.bluf)}</div>
  <div class="fp">sha256 fingerprint: ${esc(f.fp)}</div>
  <div class="fphint">verify after transfer — if it differs, the tree changed</div>
  <div class="oneliner">For your agent: <b>Read ${canonical} at the artifact root and execute its load order; it routes everything else.</b></div>
  ${pasteBlocks(slug, origin, "")}
  <div class="files">${f.files.map((x) => `${esc(x.path)} — ${esc(x.size)} bytes`).join("<br>")}</div>
  <p><a href="${manifestHref}">INGEST.md manifest →</a> · <a href="${base ? `${base}/archive.zip` : "./archive.zip"}">⬇ Download .zip</a>${base ? ` · <a href="${base}/INGEST.md">absolute</a>` : ""} · <a href="${origin || "/"}">← host home</a></p>
</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 rx=%2714%27 fill=%27%230d1117%27/%3E%3Cpath d=%27M17 39 a15 15 0 0 0 30 0%27 fill=%27none%27 stroke=%27%2358a6ff%27 stroke-width=%273.5%27 stroke-linecap=%27round%27/%3E%3Ccircle cx=%2732%27 cy=%2726%27 r=%275.5%27 fill=%27%23ff8c66%27/%3E%3C/svg%3E">
<title>${esc(f.title)} — ${esc(siteName)}</title>${ogBlock}${style}
</head><body>${body}</body></html>`;
}

function tryHTML(origin, siteName) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>try — the INGEST.md playground</title>
<meta name="twitter:card" content="summary_large_image">
<meta property="og:title" content="INGEST.md playground — try the three-reader URL">
<meta property="og:description" content="One URL, three readers. See the classifier decide: crawlers get the unfurl, humans get the card, agents get the manifest.">
<style>
  body { margin:0; font-family:ui-monospace,Menlo,Consolas,monospace; background:#0d1117; color:#e6edf3; padding:8vh 6vw; line-height:1.7; }
  h1 { font-size:26px; } h2 { font-size:18px; color:#58a6ff; margin-top:40px; }
  pre { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:16px 18px; overflow-x:auto; font-size:13px; }
  a { color:#58a6ff; text-decoration:none; }
  .note { color:#8b949e; font-size:13px; }
  table { border-collapse:collapse; margin-top:12px; font-size:14px; }
  td, th { border:1px solid #30363d; padding:7px 12px; }
  th { background:#161b22; }
</style>
</head><body>
<h1>try — the playground</h1>
<p>One URL, three readers. The classifier is deterministic and inspectable: <a href="https://github.com/justinsharpe/ingest/blob/main/api/lib/classify.js">api/lib/classify.js</a>.</p>

<h2>1 — the same URL, three ways</h2>
<table>
  <tr><th>You send</th><th>You get</th></tr>
  <tr><td><code>curl ${origin}/agentic-testing</code></td><td>the manifest (machine surface)</td></tr>
  <tr><td>a browser visit to <code>${origin}/agentic-testing</code></td><td>the card page (human surface)</td></tr>
  <tr><td>paste <code>${origin}/agentic-testing</code> into X / Discord / Slack</td><td>the unfurl (crawler surface — OG + twitter:card)</td></tr>
</table>

<h2>2 — try it from your terminal</h2>
<pre><code># the machine surface (an agent's view)
curl -A "curl/8.4" ${origin}/agentic-testing

# the human surface
open ${origin}/agentic-testing

# the crawler surface (what X/Discord fetch)
curl -A "Twitterbot/1.0" ${origin}/agentic-testing | head -20</code></pre>

<h2>3 — the one-liner, live</h2>
<pre><code>Read ${origin}/agentic-testing/INGEST.md and execute its load order; it routes everything else.</code></pre>
<p class="note">Your agent fetches the manifest, executes the load order, and the whole package routes from one line. That is the entire convention.</p>

<h2>4 — arm your own</h2>
<pre><code>git clone https://github.com/justinsharpe/ingest
cd ingest
python3 ingest.py init ./my-package --bluf bluf.txt
python3 tools/arm.py ./my-package --slug my-package --url ${origin}/my-package</code></pre>
<p class="note">The arming tool copies the artifact set into the host's packages/ dir and stamps the share URL. The manifest stays the single source of truth.</p>

<p><a href="/">← host home</a></p>
</body></html>`;
}

function boardHTML(origin, siteName) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>the board — public gests</title>
<meta name="twitter:card" content="summary_large_image">
<meta property="og:title" content="The board — public gests">
<meta property="og:description" content="Every public gest on ${siteName}, search/filterable. The machine ledger: /gests.json.">
<style>
  body { margin:0; font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; background:#0d1117; color:#e6edf3; padding:6vh 6vw; line-height:1.65; }
  h1 { font-size:26px; } h2 { font-size:15px; color:#58a6ff; margin-top:40px; }
  a { color:#58a6ff; text-decoration:none; }
  .quip { color:#79c0ff; font-style:italic; font-size:13.5px; }
  .note { color:#8b949e; font-size:13px; }
  #q { width:100%; max-width:560px; background:#161b22; border:1px solid #30363d; border-radius:10px; color:#e6edf3; padding:12px 16px; font-size:15px; margin:8px 0 28px; }
  .gest { border:1px solid #30363d; border-radius:12px; background:#161b22; padding:16px 18px; margin:14px 0; cursor:pointer; }
  .gest:hover { border-color:#58a6ff; }
  .gest .t { font-size:16px; font-weight:600; }
  .gest .meta { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:#8b949e; margin-top:6px; }
  .gest .bluf { font-size:13.5px; color:#c9d1d9; margin-top:8px; }
  .gest .tagline { color:#79c0ff; font-style:italic; font-size:13px; margin-top:6px; }
  .none { color:#8b949e; font-style:italic; }
</style>
</head><body>
<h1>the board</h1>
<p class="quip">&gt; every public gest, on one board — the wells hold no secrets</p>
<p class="note">Search/filter the public ledger. The machine surface: <a href="/gests.json">/gests.json</a>. Unlisted gests resolve but never list; private gests need a grant.</p>
<input id="q" type="search" placeholder="filter gests — owner, title, bluf, id, tagline…" oninput="filterGests(this.value)">
<div id="list"></div>
<p class="none" id="none" style="display:none">no gests match — even the best filters miss sometimes</p>
<script>
var GESTS = [];
fetch("/gests.json").then(function (r) { return r.json(); }).then(function (d) {
  GESTS = d.gests || [];
  render("");
});
function render(q) {
  var list = document.getElementById("list");
  var none = document.getElementById("none");
  var needle = (q || "").toLowerCase();
  var hits = GESTS.filter(function (g) {
    return !needle || JSON.stringify(g).toLowerCase().includes(needle);
  });
  list.innerHTML = hits.map(function (g) {
    var url = "/" + (g.owner || "x") + "/" + g.gest_id;
    return '<div class="gest" onclick="location.assign(\\'' + url + '\\')">' +
      '<div class="t">' + esc2(g.title) + '</div>' +
      (g.tagline ? '<div class="tagline">&gt; ' + esc2(g.tagline) + '</div>' : '') +
      '<div class="bluf">' + esc2(g.bluf1) + '</div>' +
      '<div class="meta">' + esc2(g.owner || "—") + ' · ' + esc2(g.gest_id) + ' · sha256 ' + esc2(g.fingerprint) + '</div>' +
    '</div>';
  }).join("");
  none.style.display = hits.length ? "none" : "block";
}
function filterGests(q) { render(q); }
function esc2(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
</script>
</body></html>`;
}

function demoHTML(origin, siteName) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>demo — the gest embed, live</title>
<meta name="twitter:card" content="summary_large_image">
<meta property="og:title" content="The gest embed — live demo">
<meta property="og:description" content="Drop two lines on any site and the gest lands: the card renders inline, the sandbox opens, the install is one click.">
<style>
  body { margin:0; font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; background:#0d1117; color:#e6edf3; padding:6vh 6vw; line-height:1.7; }
  h1 { font-size:26px; } h2 { font-size:17px; color:#58a6ff; margin-top:44px; }
  pre { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:16px 18px; overflow-x:auto; font-size:13px; }
  a { color:#58a6ff; text-decoration:none; }
  .note { color:#8b949e; font-size:13px; }
  .quip { color:#79c0ff; font-style:italic; font-size:13.5px; }
</style>
</head><body>
<h1>demo — the gest embed, live</h1>
<p class="quip">&gt; this page eats its own cooking — the card below is the widget, running</p>

<h2>1 — the two lines</h2>
<pre>&lt;div data-ingest="${origin}/agentic-testing"&gt;&lt;/div&gt;
&lt;script src="${origin}/embed.js"&gt;&lt;/script&gt;</pre>
<p class="note">That's the whole integration. No build step, no account, no framework.</p>

<h2>2 — what your visitors see</h2>
<div data-ingest="${origin}/agentic-testing"></div>
<script src="/embed.js"></script>

<h2>3 — inside the sandbox</h2>
<p class="note">Click the card. The sandbox modal opens: the tale file-by-file, the one-click install (zip + OS-aware CLI line), the one-liner to copy. Every word in our lingo — the quips ride every touchpoint.</p>

<p><a href="/">← host home</a> · <a href="/try">the playground →</a></p>
</body></html>`;
}

function indexHTML(slugs, siteName) {
  const list = slugs.length
    ? slugs.map((s) => `<li><a href="/${esc(s)}">${esc(s)}</a></li>`).join("")
    : `<li><em>no packages armed yet</em></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(siteName)} — INGEST.md live host</title>
<meta property="og:title" content="${esc(siteName)} — INGEST.md live host">
<meta property="og:description" content="The live reference host for the INGEST.md shareable-artifact manifest convention. One URL, three readers: crawlers get the card unfurl, humans get the card page, agents get the manifest.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<style>body{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;background:#0d1117;color:#e6edf3;padding:8vh 6vw}
a{color:#58a6ff;text-decoration:none} h1{font-size:28px} li{margin:8px 0}</style>
</head><body>
<h1>${esc(siteName)}</h1>
<p>The live reference host for the <a href="${SITE.repo}">INGEST.md convention</a>.</p>
<p>One URL, three readers: <b>crawlers</b> get the unfurl, <b>humans</b> get the card, <b>agents</b> get the manifest.</p>
<ul>${list}</ul>
<p><a href="/try">try the playground →</a></p>
</body></html>`;
}