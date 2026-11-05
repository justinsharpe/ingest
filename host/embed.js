// embed.js — the INGEST.md embed widget (layer 3: "embed code was the share format
// of the social era; agent-ingest is the share format of the agentic era").
//
// USAGE (any site owner):
//   <div data-ingest="https://viiy.to/agentic-testing"></div>
//   <script src="https://HOST/embed.js"></script>
//
// The widget fetches the manifest, renders the card inline, and on click opens a
// sandbox-style modal: browse the artifact file-by-file (rendered from the
// manifest's file map), one-click install (zip download + OS-aware CLI prompt +
// copy-the-one-liner). Zero dependencies, one request, no build step.

(function () {
  "use strict";
  // SECURITY LAW for this file: every dynamic value interpolated into an
  // innerHTML template goes through esc() (below) — title, bluf, quip, paths,
  // sizes, URL, OS line. The templates themselves are static strings. No
  // event-handler strings are ever built from data. This is why the innerHTML
  // pattern is safe here; any new interpolation MUST go through esc().
  var script = (typeof document !== "undefined" && document.currentScript) || null;
  var ORIGIN = script ? script.src.replace(/\/embed\.js.*$/, "") : "";
  var q = function (sel) { return document.querySelector(sel); };

  // ── OS detection (the "windows vs mac vs linux" install prompt) ──
  function detectOS() {
    var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/Windows/i.test(ua)) return "windows";
    if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
    if (/Linux|X11/i.test(ua)) return "linux";
    if (/Android|iPhone|iPad/i.test(ua)) return "mobile";
    return "unknown";
  }
  var OS_LINES = {
    windows: 'powershell -c "irm https://github.com/justinsharpe/ingest/raw/main/ingest.py -OutFile ingest.py; python ingest.py verify <dir>"',
    mac: 'curl -O https://github.com/justinsharpe/ingest/raw/main/ingest.py && python3 ingest.py verify <dir>',
    linux: 'curl -O https://github.com/justinsharpe/ingest/raw/main/ingest.py && python3 ingest.py verify <dir>',
    mobile: "(on mobile: download the zip — install from a desktop)",
    unknown: "python3 ingest.py verify <dir>",
  };

  // ── the quips (brand-lingo microcopy at UI touchpoints — the Sept-19
  //    directive: "playful quips in our lingo at UI touchpoints") ──
  var QUIPS = {
    cardFooter: "the tale, boxed — click to ungest it",
    download:   "⬇ Download .zip — carry the tale home",
    copy:       "⧉ Copy the one-liner",
    copied:     "✓ the one-liner is yours now",
    installFor: "how this gest lands on your machine:",
    verifyHint: "then ask the bytes if they're the same bytes",
    openPage:   "open the share page ↗",
    share:      "Share",
    shareHint:  "three ways out — the one-liner, the embed, or the bare URL",
    closeHint:  "esc — the tale waits",
    error:      "this gest got lost between the wells — the host didn't answer",
    empty:      "no gest here yet — arm one and it lands"
  };

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── manifest parsing (same shape the resolver uses) ──
  function parseManifest(text) {
    var fp = (text.match(/`([0-9a-f]{16})`/) || [])[1] || "";
    var title = (text.match(/^# INGEST\.md — machine manifest for `([^`]+)`/m) || [])[1] || "package";
    var bluf = (text.match(/## BLUF\s*\n\n([\s\S]+?)(?:\n\n## |$)/) || [])[1] || "";
    var tagline = (text.match(/## (?:Tagline|Quip)\s*\n\n> ?(.+)/) || [])[1] || "";
    var files = [];
    var re = /^- `([^`]+)` — ([\d,]+) bytes/gm, m2;
    while ((m2 = re.exec(text))) files.push({ path: m2[1], size: m2[2] });
    var vis = (text.match(/\*\*Visibility:\*\* ([a-z]+)/) || [])[1] || "unlisted";
    var thumb = (text.match(/\*\*Thumbnail:\*\*\s*([^\s\n]+)/) || [])[1] || "";
    return { fp: fp, title: title, bluf: bluf.trim(), tagline: tagline, files: files, vis: vis, thumb: thumb };
  }

  // ── the three share-out forms (U6 receipt b) ─────────────────────
  // one-liner (agent handoff) · embed snippet (<div data-ingest>) · direct URL.
  // All three derive from the manifest URL — never a hand-written copy.
  function shareForms(url, origin) {
    var directUrl = url;
    var oneLiner = "Read INGEST.md at " + url + "/INGEST.md and execute its load order; it routes everything else.";
    var embedSnippet = '<div data-ingest="' + url + '"></div>\n<script src="' + origin + '/embed.js"></script>';
    return { oneLiner: oneLiner, embedSnippet: embedSnippet, directUrl: directUrl };
  }

  // ── the inline card ──
  function cardHTML(pkg, url) {
    return '' +
      '<div class="ingest-card" style="max-width:620px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;border:1px solid #30363d;border-radius:12px;background:#0d1117;color:#e6edf3;overflow:hidden;cursor:pointer">' +
        '<div style="padding:16px 18px 12px">' +
          '<div style="font-size:15px;font-weight:600">' + esc(pkg.title) + '</div>' +
          '<div style="font-size:13px;color:#8b949e;margin-top:4px">' + esc(url) + ' · ' + pkg.files.length + ' files · ' + esc(pkg.vis) + '</div>' +
          (pkg.thumb ? '<img src="' + esc(pkg.thumb) + '" alt="' + esc(pkg.title) + '" style="display:block;max-width:100%;margin-top:12px;border-radius:8px;border:1px solid #30363d">' : '') +
          (pkg.tagline ? '<div style="font-size:13px;color:#79c0ff;margin-top:8px;font-style:italic">&gt; ' + esc(pkg.tagline) + '</div>' : '') +
          '<div style="font-size:13.5px;line-height:1.55;color:#c9d1d9;margin-top:10px">' + esc(pkg.bluf.slice(0, 220)) + (pkg.bluf.length > 220 ? '…' : '') + '</div>' +
          '<div style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#58a6ff;margin-top:10px">sha256 ' + esc(pkg.fp) + '</div>' +
        '</div>' +
        '<div style="padding:10px 18px;border-top:1px solid #30363d;background:#161b22;font-size:12.5px;color:#8b949e;display:flex;justify-content:space-between;align-items:center;gap:10px">' +
          '<span style="min-width:0">' + esc(QUIPS.cardFooter) + '</span>' +
          '<button class="ingest-share-btn" data-act="share" style="flex:none;background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;font-weight:600">' + esc(QUIPS.share) + '</button>' +
        '</div>' +
      '</div>';
  }

  // ── the share modal (U6: the three share-out forms) ─────────────
  // A share action that emits the one-liner + the <div data-ingest> snippet +
  // the direct URL — each with a copy affordance.
  function shareModalHTML(pkg, url, origin) {
    var forms = shareForms(url, origin);
    function row(label, val) {
      return '<div style="margin:14px 0">' +
        '<div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">' + esc(label) + '</div>' +
        '<pre style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 14px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#e6edf3;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:0">' + esc(val) + '</pre>' +
        '<button class="ingest-copy-btn" data-copy="' + esc(val) + '" style="margin-top:6px;background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer">' + esc(QUIPS.copy) + '</button>' +
        '</div>';
    }
    return '' +
      '<div id="ingest-share-back" style="position:fixed;inset:0;background:rgba(1,4,9,.72);backdrop-filter:blur(3px);z-index:2147483100;display:flex;align-items:center;justify-content:center">' +
        '<div style="width:min(640px,92vw);max-height:84vh;overflow:auto;background:#0d1117;border:1px solid #30363d;border-radius:14px;color:#e6edf3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">' +
          '<div style="position:sticky;top:0;background:#161b22;padding:14px 20px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center">' +
            '<div><div style="font-size:16px;font-weight:600">share this gest</div>' +
            '<div style="font-size:12px;color:#8b949e;font-family:ui-monospace,Menlo,monospace">' + esc(pkg.title) + ' · sha256 ' + esc(pkg.fp) + '</div></div>' +
            '<button id="ingest-share-close" title="' + esc(QUIPS.closeHint) + '" style="background:none;border:1px solid #30363d;color:#e6edf3;border-radius:7px;padding:5px 12px;cursor:pointer">esc ✕</button>' +
          '</div>' +
          '<div style="padding:18px 20px">' +
            '<div style="font-size:13px;color:#8b949e;margin-bottom:4px">' + esc(QUIPS.shareHint) + '</div>' +
            row('one-liner · for any agent', forms.oneLiner) +
            row('embed · drop into any site', forms.embedSnippet) +
            row('direct URL', forms.directUrl) +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ── the sandbox modal ──
  function modalHTML(pkg, url, os) {
    var fileRows = pkg.files.map(function (f) {
      return '<div style="display:flex;justify-content:space-between;padding:7px 12px;border-bottom:1px solid #21262d;font-size:12.5px">' +
        '<span style="font-family:ui-monospace,Menlo,monospace;color:#c9d1d9">' + esc(f.path) + '</span>' +
        '<span style="color:#8b949e">' + esc(f.size) + ' B</span></div>';
    }).join("");
    return '' +
      '<div id="ingest-modal-back" style="position:fixed;inset:0;background:rgba(1,4,9,.72);backdrop-filter:blur(3px);z-index:2147483000;display:flex;align-items:center;justify-content:center">' +
        '<div style="width:min(720px,92vw);max-height:84vh;overflow:auto;background:#0d1117;border:1px solid #30363d;border-radius:14px;color:#e6edf3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">' +
          '<div style="position:sticky;top:0;background:#161b22;padding:14px 20px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center">' +
          '<div><div style="font-size:16px;font-weight:600">' + esc(pkg.title) + '</div>' +
          '<div style="font-size:12px;color:#8b949e;font-family:ui-monospace,Menlo,monospace">sha256 ' + esc(pkg.fp) + '</div></div>' +
          '<button id="ingest-close" title="' + esc(QUIPS.closeHint) + '" style="background:none;border:1px solid #30363d;color:#e6edf3;border-radius:7px;padding:5px 12px;cursor:pointer">esc ✕</button>' +
          '</div>' +
          '<div style="padding:18px 20px">' +
            (pkg.tagline ? '<div style="font-style:italic;color:#79c0ff;font-size:13.5px;margin-bottom:12px">&gt; ' + esc(pkg.tagline) + '</div>' : '') +
            '<div style="font-size:13.5px;line-height:1.6;color:#c9d1d9">' + esc(pkg.bluf) + '</div>' +
            '<div style="margin-top:18px;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em">the artifact set</div>' +
            '<div style="margin-top:8px;border:1px solid #30363d;border-radius:10px;overflow:hidden">' + fileRows + '</div>' +
            '<div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap">' +
              '<a id="ingest-zip" href="' + esc(url + '/archive.zip') + '" style="text-decoration:none;background:#238636;color:#fff;padding:10px 18px;border-radius:8px;font-size:13.5px;font-weight:600">' + esc(QUIPS.download) + '</a>' +
              '<button id="ingest-copy" style="background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:10px 18px;border-radius:8px;font-size:13.5px;cursor:pointer">' + esc(QUIPS.copy) + '</button>' +
              '<a href="' + esc(url) + '" target="_blank" style="text-decoration:none;background:none;border:1px solid #30363d;color:#58a6ff;padding:10px 18px;border-radius:8px;font-size:13.5px">' + esc(QUIPS.openPage) + '</a>' +
            '</div>' +
            '<div style="margin-top:18px;font-size:12px;color:#8b949e">' + esc(QUIPS.installFor) + ' ' + esc(os) + '</div>' +
            '<pre id="ingest-cli" style="margin-top:6px;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 14px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#e6edf3;overflow-x:auto">' + esc(OS_LINES[os]) + '</pre>' +
            '<div style="font-size:12px;color:#8b949e;margin-top:12px">' + esc(QUIPS.verifyHint) + ' — <span style="font-family:ui-monospace,Menlo,monospace;color:#58a6ff">ingest verify &lt;unzipped-dir&gt;</span> · exit 0 = the same bytes (' + esc(pkg.fp) + ')</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ── boot ──
  function openShareModal(pkg, url, origin) {
    var wrap = document.createElement("div");
    wrap.innerHTML = shareModalHTML(pkg, url, origin);
    document.body.appendChild(wrap);
    document.body.style.overflow = "hidden";
    function close() { wrap.remove(); document.body.style.overflow = ""; }
    wrap.querySelector("#ingest-share-close").addEventListener("click", close);
    wrap.querySelector("#ingest-share-back").addEventListener("click", function (e) {
      if (e.target === this) close();
    });
    var copyBtns = wrap.querySelectorAll(".ingest-copy-btn");
    Array.prototype.forEach.call(copyBtns, function (btn) {
      btn.addEventListener("click", function () {
        var val = btn.getAttribute("data-copy") || "";
        if (navigator.clipboard) navigator.clipboard.writeText(val);
        var old = btn.textContent;
        btn.textContent = QUIPS.copied;
        setTimeout(function () { btn.textContent = old; }, 1600);
      });
    });
    document.addEventListener("keydown", function esc2(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc2); }
    });
  }

  function boot() {
    var embedOrigin = ORIGIN || (typeof location !== "undefined" ? location.origin : "");
    var hosts = document.querySelectorAll("[data-ingest]");
    Array.prototype.forEach.call(hosts, function (el) {
      var url = (el.getAttribute("data-ingest") || "").replace(/\/$/, "");
      if (!url) return;
      fetch(url + "/INGEST.md").then(function (r) { return r.text(); }).then(function (text) {
        var pkg = parseManifest(text);
        el.innerHTML = cardHTML(pkg, url);
        el.querySelector(".ingest-card").addEventListener("click", function (ev) {
          ev.preventDefault();
          var os = detectOS();
          var wrap = document.createElement("div");
          wrap.innerHTML = modalHTML(pkg, url, os);
          document.body.appendChild(wrap);
          document.body.style.overflow = "hidden";
          wrap.querySelector("#ingest-close").addEventListener("click", function () {
            wrap.remove(); document.body.style.overflow = "";
          });
          wrap.querySelector("#ingest-modal-back").addEventListener("click", function (e) {
            if (e.target === this) { wrap.remove(); document.body.style.overflow = ""; }
          });
          var copyBtn = wrap.querySelector("#ingest-copy");
          if (copyBtn) copyBtn.addEventListener("click", function () {
            var line = "Read INGEST.md at " + url + "/INGEST.md and execute its load order; it routes everything else.";
            if (navigator.clipboard) navigator.clipboard.writeText(line);
            copyBtn.textContent = QUIPS.copied;
          });
          document.addEventListener("keydown", function esc2(e) {
            if (e.key === "Escape") { wrap.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", esc2); }
          });
        });
        // U6: the Share button opens the share modal (three share-out forms).
        var shareBtn = el.querySelector(".ingest-share-btn");
        if (shareBtn) shareBtn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openShareModal(pkg, url, embedOrigin);
        });
      }).catch(function () {
        el.innerHTML = '<div style="border:1px solid #30363d;border-radius:10px;padding:14px;background:#0d1117;color:#8b949e;font-size:13px;font-family:monospace">' + esc(QUIPS.error) + ' — ' + esc(url) + '</div>';
      });
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  // Node test hook — parseManifest/detectOS are pure functions; test them
  // without a DOM (tests/embed-parse.test.js). Browser flow is untouched.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseManifest: parseManifest, detectOS: detectOS, esc: esc, OS_LINES: OS_LINES, QUIPS: QUIPS, shareForms: shareForms, cardHTML: cardHTML, shareModalHTML: shareModalHTML };
  }
})();