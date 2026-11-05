#!/usr/bin/env python3
"""ingest — the INGEST.md reference CLI (convention tool, stdlib-only).

The file is the SDK: this tool does the work an adopter would otherwise rebuild.
Zero dependencies, no account, no service. Spec: justinsharpe/ingest SPEC.md
(INGEST.md canonical + AGENT-INGEST.md alias, one schema, discovery order).

Commands:
  ingest init <dir>     scan artifact dir -> emit INGEST.md (BLUF, load order,
                        file map, sha256 fingerprint)
  ingest verify <dir>   recompute the fingerprint; compare against the manifest
  ingest validate <dir> validate the manifest against the schema (fingerprint /
                        load order / file map; reject malformed)
  ingest card <dir>     emit the share card (human surface) + the one-liner
                        (machine surface) from the manifest

The manifest carries a `canonical_name` + `alias` note per the two-name spec.
"""
import argparse
import hashlib
import json
import pathlib
import re
import secrets
import shutil
import sys

CANONICAL = "INGEST.md"
ALIAS = "AGENT-INGEST.md"
ID_RE = re.compile(r"^[0-9a-z]{6,14}$")
FP_RE = re.compile(r"^[0-9a-f]{16}$")


def gen_gest_id():
    """base36, ~52 bits of crypto-random — the x.com/i/status law: the ID is
    load-bearing, the owner in the URL is decoration."""
    n = secrets.randbits(52)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


def find_manifest(root: pathlib.Path):
    """Discovery order per spec: INGEST.md first, AGENT-INGEST.md second."""
    for name in (CANONICAL, ALIAS):
        p = root / name
        if p.exists():
            return p
    return None


def fingerprint_files(root: pathlib.Path):
    """sha256 over the artifact set (manifest excluded, both names)."""
    h = hashlib.sha256()
    for f in sorted(p for p in root.rglob("*")
                    if p.is_file() and p.name not in (CANONICAL, ALIAS)):
        h.update(f.read_bytes())
    return h.hexdigest()[:16]


def _section_text(text: str, heading: str) -> str:
    """Raw text of a `## heading` section, up to the next `## ` heading or EOF."""
    m = re.search(re.escape(heading) + r"[^\n]*\n(.*?)(?=\n##\s|\Z)", text, re.S)
    return m.group(1).strip() if m else ""


def _section_items(text: str, heading: str) -> list:
    """List items (numbered or bulleted) under a `## heading` section."""
    items = []
    for line in _section_text(text, heading).split("\n"):
        line = line.strip()
        if re.match(r"^\d+\.\s+", line) or re.match(r"^[-*]\s+", line):
            items.append(line)
    return items


def parse_manifest(text: str) -> dict:
    """Extract the schema fields from a manifest (the markdown projection)."""
    fp = (re.search(r"fingerprint \(sha256[^)]*\):\*?\*?\s*`([0-9a-f]{16})`", text)
          or re.search(r"`([0-9a-f]{16})`", text))
    vis = re.search(r"\*\*Visibility:\*\*\s*([a-z]+)", text)
    return {
        "fingerprint": fp.group(1) if fp else "",
        "load_order": _section_items(text, "## Load order"),
        "file_map": _section_items(text, "## File map"),
        "bluf": _section_text(text, "## BLUF"),
        "visibility": vis.group(1) if vis else "",
    }


def validate_manifest(parsed: dict) -> list:
    """Return the list of schema violations (empty = valid). BLUF is optional;
    fingerprint, load order and file map are required."""
    errors = []
    if not FP_RE.fullmatch(parsed["fingerprint"]):
        errors.append("fingerprint missing or malformed (must be 16 hex chars)")
    if not parsed["load_order"]:
        errors.append("'## Load order' section missing or empty — the one required section")
    if not parsed["file_map"]:
        errors.append("'## File map' section missing or empty — required")
    if parsed["visibility"] and parsed["visibility"] not in ("public", "unlisted", "private"):
        errors.append(f"visibility '{parsed['visibility']}' must be public|unlisted|private")
    return errors


def manifest_text(root, bluf, files, fp, video="", visibility="unlisted", grant_line="", tagline="", gest_id="", owner="", thumbnail=""):
    fm = "\n".join(f"- `{f.relative_to(root).as_posix()}` — {f.stat().st_size:,} bytes" for f in files)
    tagline_block = "\n## Tagline\n\n> " + tagline + "\n" if tagline else ""
    id_block = f"\n> **Gest ID:** `{gest_id}` — the load-bearing reference (owner in the URL is decoration).\n" if gest_id else ""
    owner_block = f"> **Owner:** {owner}\n" if owner else ""
    # U6: the thumbnail rides both surfaces — the human card shows it, the crawler's
    # og:image uses it. It is a metadata line (like Visibility/Owner), an image URL
    # or package-relative path; the card renderer parses it and falls back to the
    # host owl card when absent.
    thumbnail_block = f"\n**Thumbnail:** {thumbnail}\n" if thumbnail else ""
    return f"""# INGEST.md — machine manifest for `{root.name}`

> Convention: justinsharpe/ingest — INGEST.md (canonical) / AGENT-INGEST.md (alias), one schema.
> **Package fingerprint (sha256):** `{fp}` — verify after transfer; if it differs, the tree changed.
{id_block}{owner_block}{grant_line}{thumbnail_block}
## Load order (the one required section)

1. BLUF (below) — the one-paragraph bottom line.
2. The files in the file map, in listed order.
{f"3. The video: `{video}` — the human-facing walkthrough." if video else ""}

## BLUF

{bluf}
{tagline_block}
## File map

{fm}

## The one-liner

**Prompt form:** Read `{CANONICAL}` at the artifact root and execute its load order; it routes everything else.
**CLI form:** `ingest <dir>` — this reference tool reads the manifest.
"""


def cmd_init(args):
    root = pathlib.Path(args.dir)
    if not root.is_dir():
        print(f"ERROR: {args.dir} is not a directory"); return 1
    if args.visibility not in ("public", "unlisted", "private"):
        print("ERROR: --visibility must be public|unlisted|private"); return 1
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.name not in (CANONICAL, ALIAS))
    if not files:
        print(f"ERROR: {root} is empty — nothing to ingest"); return 1
    bluf = pathlib.Path(args.bluf).read_text(encoding="utf-8").strip() if args.bluf else "(BLUF not yet written — write it before sharing.)"
    fp = fingerprint_files(root)
    import hashlib as _h
    # Gest ID: auto-generate unless --gest-id given; reuse if the manifest already has one (stable identity)
    existing = ""
    old = find_manifest(root)
    if old is not None:
        m = re.search(r"\*\*Gest ID:\*\* `([0-9a-z]{6,14})`", old.read_text(encoding="utf-8"))
        if m: existing = m.group(1)
    gest_id = getattr(args, "gest_id", "") or existing or gen_gest_id()
    if not ID_RE.match(gest_id):
        print(f"ERROR: --gest-id must be 6-14 chars of lowercase alphanumerics (got '{gest_id}')"); return 1
    owner = getattr(args, "owner", "")
    grant_line = ""
    if args.visibility == "private":
        grant_hash = _h.sha256(args.grant.encode()).hexdigest()[:16] if args.grant else _h.sha256(fp.encode()).hexdigest()[:16]
        grant_line = f"\n**Visibility:** private — ingestion requires an access grant (sha256 grant hash: `{grant_hash}`).\n"
        if not args.grant:
            grant_line += "> No --grant given: the grant defaults to the fingerprint — ISSUE a real grant before sharing privately.\n"
    else:
        grant_line = f"\n**Visibility:** {args.visibility} — ingestion is {'open to anyone with the reference' if args.visibility == 'public' else 'open to anyone holding the reference (not listed/indexed)'}.\n"
    (root / CANONICAL).write_text(manifest_text(root, bluf, files, fp, args.video, args.visibility, grant_line, getattr(args, "tagline", ""), gest_id, owner, getattr(args, "thumbnail", "")), encoding="utf-8")
    print(f"OK init: {root / CANONICAL}")
    print(f"   {len(files)} files | fingerprint {fp} | visibility {args.visibility}"
          + (f" | grant issued (hash {grant_hash})" if args.visibility == "private" else ""))
    print(f"   gest id: {gest_id}" + (f" | owner: {owner}" if owner else "")
          + (f" | thumbnail: {getattr(args, 'thumbnail', '')}" if getattr(args, "thumbnail", "") else ""))
    return 0


def cmd_verify(args):
    root = pathlib.Path(args.dir)
    m = find_manifest(root)
    if m is None:
        print(f"ERROR: no {CANONICAL} or {ALIAS} in {root}"); return 1
    text = m.read_text(encoding="utf-8")
    import re
    got = re.search(r"fingerprint \(sha256\)\:\*?\*? `([0-9a-f]{16})`", text)
    if not got:
        print("ERROR: manifest carries no fingerprint"); return 1
    fp = fingerprint_files(root)
    ok = fp == got.group(1)
    print(f"{'OK' if ok else 'MISMATCH'}: manifest {got.group(1)} vs recomputed {fp}")
    print(f"   manifest file: {m.name} ({'canonical' if m.name == CANONICAL else 'alias'})")
    return 0 if ok else 2


def cmd_validate(args):
    root = pathlib.Path(args.dir)
    m = find_manifest(root)
    if m is None:
        print(f"ERROR: no {CANONICAL} or {ALIAS} in {root}"); return 1
    text = m.read_text(encoding="utf-8")
    parsed = parse_manifest(text)
    errors = validate_manifest(parsed)
    if errors:
        for e in errors:
            print(f"INVALID: {e}")
        print(f"   manifest file: {m.name}")
        return 2
    print(f"OK: manifest schema valid ({m.name})")
    print(f"   fingerprint {parsed['fingerprint']} | load order {len(parsed['load_order'])} step(s)"
          f" | file map {len(parsed['file_map'])} file(s)")
    return 0


def cmd_pack(args):
    root = pathlib.Path(args.dir)
    m = find_manifest(root)
    if m is None:
        print(f"ERROR: no manifest in {root} — run `ingest init` first"); return 1
    # verify BEFORE packing: never ship a mismatched tree
    import re
    text = m.read_text(encoding="utf-8")
    got = re.search(r"fingerprint \(sha256\)\:\*?\*? `([0-9a-f]{16})`", text)
    fp = fingerprint_files(root)
    if not got or got.group(1) != fp:
        print(f"ERROR: fingerprint mismatch (manifest {got.group(1) if got else '?'} vs recomputed {fp}) — run `ingest init` again"); return 2
    # zip BESIDE the dir (never inside it — no self-inclusion), manifest included
    dest = shutil.make_archive(str(root.resolve()), "zip", root_dir=root.parent, base_dir=root.name)
    # exclude a stale sibling zip from a previous pack? not needed: make_archive names it <dir>.zip
    print(f"OK pack: {dest}")
    print(f"   fingerprint {fp} — recipient runs `ingest verify <dir>` after unzip; exit 0 = intact")
    return 0


def cmd_card(args):
    root = pathlib.Path(args.dir)
    m = find_manifest(root)
    if m is None:
        print(f"ERROR: no manifest in {root} — run `ingest init` first"); return 1
    text = m.read_text(encoding="utf-8")
    import re
    title = root.name
    bluf_m = re.search(r"## BLUF\n\n(.*?)\n\n", text, re.S)
    bluf = (bluf_m.group(1)[:280] + "…") if bluf_m and len(bluf_m.group(1)) > 280 else (bluf_m.group(1) if bluf_m else "(no BLUF)")
    print("┌" + "─" * 62 + "┐")
    print(f"│ {title[:60]:<60} │")
    print("├" + "─" * 62 + "┤")
    for line in bluf.split("\n")[:5]:
        print(f"│ {line[:60]:<60} │")
    print("└" + "─" * 62 + "┘")
    print()
    print("THE ONE-LINER:")
    print(f"  Read {CANONICAL} at the artifact root and execute its load order; it routes everything else.")
    return 0


def main():
    ap = argparse.ArgumentParser(prog="ingest", description="The INGEST.md reference CLI — the file is the SDK")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_init = sub.add_parser("init", help="scan artifact dir -> emit INGEST.md")
    p_init.add_argument("dir"); p_init.add_argument("--bluf", default=""); p_init.add_argument("--video", default="")
    p_init.add_argument("--visibility", default="unlisted", help="public|unlisted|private"); p_init.add_argument("--grant", default="", help="access grant token for private ingestion")
    p_init.add_argument("--tagline", default="", help="the signature one-line thesis — rides the manifest and every share surface")
    p_init.add_argument("--gest-id", default="", help="override the auto-generated base36 gest id (6-14 lowercase alphanumerics)")
    p_init.add_argument("--owner", default="", help="the owner handle — decoration in the URL, identity on the board (e.g. 'justin')")
    p_init.add_argument("--thumbnail", default="", help="the card thumbnail image (URL or package-relative path) — rides the card + og:image (U6)")
    p_init.set_defaults(fn=cmd_init)
    p_verify = sub.add_parser("verify", help="recompute + compare the fingerprint")
    p_verify.add_argument("dir"); p_verify.set_defaults(fn=cmd_verify)
    p_validate = sub.add_parser("validate", help="validate the manifest against the schema")
    p_validate.add_argument("dir"); p_validate.set_defaults(fn=cmd_validate)
    p_card = sub.add_parser("card", help="emit the share card + one-liner")
    p_card.add_argument("dir"); p_card.set_defaults(fn=cmd_card)
    p_pack = sub.add_parser("pack", help="zip the artifact set (manifest excluded from the hash, included in the zip) -> <dir>.zip beside it")
    p_pack.add_argument("dir"); p_pack.set_defaults(fn=cmd_pack)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())