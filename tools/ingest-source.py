#!/usr/bin/env python3
"""ingest-source — materialize a source into an artifact directory, then arm it.

The core tool (`ingest init/verify/card/pack`) presumes you already HAVE the
artifact set. Real adopters don't: the content lives in a CMS, an API, a feed.
This is the source lane — the capability that gets a package to the door. It is
deliberately a SIBLING tool, not a verb in ingest.py: the format core stays the
invariant, sources are a deployment capability.

    python3 tools/ingest-source.py fetch --source rss --from <feed-url> --out ./pkg
    python3 ingest.py init ./pkg --bluf ./bluf.md --visibility public
    python3 ingest.py verify ./pkg

Source classes (the four every publishing stack actually uses):
  dir    copy an artifact directory in as-is
  file   a single local file
  json   a content API: {"items":[...]} / {"posts":[...]} / {"data":[...]} / bare list
  rss    RSS 2.0 or Atom, from a URL or a local path

Field names are matched loosely across the common vendor shapes
(title|name|headline, url|link|permalink|web_url, text|content|body|summary|
description|excerpt|markdown) so no per-vendor adapter is ever needed.

Every item lands as Markdown with front-matter (title, source_url, published,
fetched_at) so the manifest's file map stays human-readable and the fingerprint
stays meaningful. A SOURCES.json receipt records origin + sha256 + bytes per
item: provenance at the door, not after the fact.

Deterministic: pass --now <ISO> and the same source yields byte-identical
content, into any directory. The receipt's own log fields (`out`, `fetched_at`)
are the only variance, so a package's fingerprint is stable across machines
while its provenance is still recorded.

Zero dependencies, no account, no service (stdlib only; SSRF-hardened
http.client fetch + xml.etree).
Runs on Python 3.9 (stock macOS) through 3.13+ — the annotations are lazy.

Exit: 0 ok; 2 source problem (unreachable locator, malformed payload, refused
XML, empty result — nothing is written and the reason is printed).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import pathlib
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET

# ssrf.py is a sibling tool; the script dir is on sys.path when run as a
# script, and this insert makes it robust when imported as a module.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ssrf  # noqa: E402  (SSRF-hardened fetch)

VERSION = "0.1.0"
SOURCES_RECEIPT = "SOURCES.json"
MAX_BYTES = 8 * 1024 * 1024  # refuse oversized payloads before parsing (bomb defence)
FIELD_SEPARATOR = "\0"


class SourceError(Exception):
    """A source problem the CLI reports and exits 2 on — never a traceback.

    One class for every failure mode (unreachable locator, malformed payload,
    refused XML, empty result) so the caller has a single catch and the exit
    contract stays uniform: reason printed, nothing written, exit code 2.
    """


def read_locator(locator: str) -> bytes:
    """Read a URL (http/https, SSRF-hardened) or a local path.

    Raises SourceError on failure. URL fetches route through tools/ssrf.py:
    DNS-resolve + reject private/loopback/link-local/ULA, re-resolve per
    redirect, 80/443 only, size cap, timeouts. file:// is refused outright —
    pass the local path directly instead.
    """
    if re.match(r"^https?://", locator):
        try:
            status, _headers, body = ssrf.safe_fetch(locator, max_bytes=MAX_BYTES)
        except ssrf.SSRFError as e:
            raise SourceError(f"fetch refused/failed for {locator}: {e.reason}")
        if status >= 400:
            raise SourceError(f"fetch failed for {locator}: HTTP {status}")
        return body
    if re.match(r"^file://", locator):
        raise SourceError(f"file:// is not fetchable — pass the local path directly: {locator}")
    p = pathlib.Path(locator)
    if not p.exists():
        raise SourceError(f"locator not found: {locator}")
    data = p.read_bytes()
    if len(data) > MAX_BYTES:
        raise SourceError(f"payload over {MAX_BYTES} bytes refused: {locator}")
    return data


def slugify(text: str, fallback: str = "item") -> str:
    """Deterministic, filesystem-safe slug across macOS/Linux/Windows."""
    text = unicodedata.normalize("NFKD", text or "")
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    text = re.sub(r"-{2,}", "-", text)[:60].strip("-")
    return text or fallback


def item_file_name(item: dict, taken: set) -> str:
    """Naming law: <slug>-<8 hex of origin>[-n].md — stable, collision-safe."""
    origin = item.get("source_url") or item.get("title") or "item"
    digest = hashlib.sha256(origin.encode("utf-8")).hexdigest()[:8]
    base = f"{slugify(item.get('title') or origin)}-{digest}"
    name, n = f"{base}.md", 2
    while name in taken:
        name, n = f"{base}-{n}.md", n + 1
    taken.add(name)
    return name


def render_markdown(item: dict, fetched_at: str) -> str:
    """Front-matter (machine) + body (human). The manifest maps the file; this maps the origin."""
    lines = ["---"]
    for key in ("title", "source_url", "published"):
        if item.get(key):
            lines.append(f"{key}: {json.dumps(str(item[key]), ensure_ascii=False)}")
    lines.append(f"fetched_at: {fetched_at}")
    lines.append("---")
    lines.append("")
    lines.append(f"# {item.get('title') or 'Untitled'}")
    lines.append("")
    body = (item.get("text") or "").strip() or "(no body text in the source item)"
    lines.append(body)
    lines.append("")
    return "\n".join(lines)


def source_dir(locator: str, out: pathlib.Path, limit: int | None) -> list[dict]:
    root = pathlib.Path(locator)
    if not root.is_dir():
        raise SourceError(f"--source dir expects a directory: {locator}")
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.name != SOURCES_RECEIPT)
    items: list[dict] = []
    for p in (files[:limit] if limit else files):
        dest = out / p.relative_to(root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(p.read_bytes())
        items.append({"file": dest.relative_to(out).as_posix(), "origin": str(p),
                      "kind": "copy", "title": p.name})
    return items


def _item_from_mapping(d: dict) -> dict:
    pick = lambda *names: next((d[n] for n in names if d.get(n)), None)  # noqa: E731
    return {
        "title": pick("title", "name", "headline"),
        "source_url": pick("url", "link", "permalink", "web_url", "canonical_url"),
        "published": pick("published", "published_at", "date", "pubDate", "updated"),
        "text": pick("text", "content", "body", "summary", "description", "excerpt", "markdown"),
    }


def source_json(locator: str, out: pathlib.Path, limit: int | None, fetched_at: str) -> list[dict]:
    try:
        payload = json.loads(read_locator(locator).decode("utf-8"))
    except json.JSONDecodeError as e:
        raise SourceError(f"--source json: not valid JSON ({e})")
    if isinstance(payload, dict):
        raw = payload.get("items") or payload.get("posts") or payload.get("data") or []
    elif isinstance(payload, list):
        raw = payload
    else:
        raise SourceError("--source json: payload must be a list or an object with items/posts/data")
    if not isinstance(raw, list):
        raise SourceError("--source json: items must be a list")
    items: list[dict] = []
    for d in (raw[:limit] if limit else raw):
        if not isinstance(d, dict):
            continue
        item = _item_from_mapping(d)
        if not (item["title"] or item["text"]):
            continue
        name = item_file_name(item, {i["file"] for i in items})
        (out / name).write_text(render_markdown(item, fetched_at), encoding="utf-8")
        items.append({"file": name, "origin": item.get("source_url") or locator,
                      "kind": "json", "title": item.get("title")})
    return items


def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def source_rss(locator: str, out: pathlib.Path, limit: int | None, fetched_at: str) -> list[dict]:
    data = read_locator(locator)
    # Stdlib-only by design (no defusedxml dependency). Two guards make xml.etree
    # safe here: the payload is size-capped in read_locator, and any DTD/entity
    # declaration is refused outright — that closes XXE and billion-laughs.
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise SourceError("--source rss: XML carrying a DTD/entity declaration is refused "
                          "(XXE / entity-expansion defence); re-publish the feed without a DTD")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise SourceError(f"--source rss: not parseable XML ({e})")
    entries = [el for el in root.iter() if _strip_ns(el.tag) in ("item", "entry")]
    if not entries:
        raise SourceError("--source rss: no <item> or <entry> elements found (RSS 2.0 / Atom expected)")
    items: list[dict] = []
    for el in (entries[:limit] if limit else entries):
        fields: dict = {}
        for child in el:
            fields.setdefault(_strip_ns(child.tag), child)

        def txt(*names, _fields=fields):  # default-arg binding: no loop-variable capture
            for n in names:
                node = _fields.get(n)
                if node is None:
                    continue
                if node.get("href"):
                    return node.get("href")
                if node.get("url"):
                    return node.get("url")
                if node.text and node.text.strip():
                    return node.text.strip()
            return None

        summary = txt("summary", "description", "content")
        item = {
            "title": txt("title"),
            "source_url": txt("link", "guid", "id"),
            "published": txt("pubDate", "published", "updated", "date"),
            "text": re.sub(r"\s+", " ", summary) if summary else None,
        }
        if not (item["title"] or item["text"]):
            continue
        name = item_file_name(item, {i["file"] for i in items})
        (out / name).write_text(render_markdown(item, fetched_at), encoding="utf-8")
        items.append({"file": name, "origin": item.get("source_url") or locator,
                      "kind": "rss", "title": item.get("title")})
    return items


def cmd_fetch(args) -> int:
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fetched_at = args.now or _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()
    items: list[dict] = []
    try:
        if args.source == "dir":
            items = source_dir(args.from_, out, args.limit)
        elif args.source == "file":
            src = pathlib.Path(args.from_)
            if not src.is_file():
                raise SourceError(f"--source file expects a file: {args.from_}")
            dest = out / src.name
            dest.write_bytes(src.read_bytes())
            items = [{"file": dest.name, "origin": str(src), "kind": "file", "title": src.name}]
        elif args.source == "json":
            items = source_json(args.from_, out, args.limit, fetched_at)
        elif args.source == "rss":
            items = source_rss(args.from_, out, args.limit, fetched_at)
        else:
            print(f"ERROR: unknown --source {args.source}")
            return 2
    except SourceError as e:  # every source problem is a clean exit 2, never a crash
        print(f"ERROR: {e}")
        return 2

    if not items and args.source != "dir":
        print("ERROR: the source yielded zero usable items — nothing written; "
              "check the locator and the payload shape")
        return 2

    for it in items:
        f = out / it["file"]
        it["bytes"] = f.stat().st_size
        it["sha256"] = hashlib.sha256(f.read_bytes()).hexdigest()

    receipt = {
        "tool": "ingest-source", "version": VERSION, "source": args.source,
        "from": args.from_, "out": str(out), "fetched_at": fetched_at,
        "item_count": len(items),
        "naming_law": "<slug>-<8 hex of origin>[-n].md",
        "arm": "run: python3 ingest.py init <out> --bluf <bluf-file> --visibility public|unlisted|private",
        "items": items,
    }
    (out / SOURCES_RECEIPT).write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")

    print(f"OK fetch: {args.source} <- {args.from_}")
    print(f"   {len(items)} item(s) materialised in {out} | receipt {SOURCES_RECEIPT}")
    for it in items[:10]:
        print(f"   - {it['file']}  ({it['bytes']} bytes, sha256 {it['sha256'][:12]}…)")
    if len(items) > 10:
        print(f"   … {len(items) - 10} more")
    print("   next: python3 ingest.py init <out> --bluf <bluf-file> --visibility public")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="ingest-source",
        description="Materialize a source (dir|file|json|rss) into an artifact directory, then arm it with ingest.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("fetch", help="materialize a source into an artifact directory")
    p.add_argument("--source", required=True, choices=["dir", "file", "json", "rss"])
    p.add_argument("--from", dest="from_", required=True,
                   help="URL or local path (file:// and plain paths work offline)")
    p.add_argument("--out", required=True, help="output artifact directory (then: ingest.py init <out>)")
    p.add_argument("--limit", type=int, default=None, help="cap the item count")
    p.add_argument("--now", default=None, help="ISO timestamp for reproducible output (tests/CI)")
    p.set_defaults(fn=cmd_fetch)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
