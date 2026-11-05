#!/usr/bin/env python3
"""scan-secrets — refuse secrets in source (GEST U5, the "no secrets" receipt).

A stdlib-only scanner that walks the tree and flags high-signal secret shapes:
cloud access keys, VCS/CI tokens, API keys (sk-*), Slack tokens, PEM private
keys, and a narrow quoted password/api-key assignment. Conservative by design:
every pattern requires a distinctive prefix + a long high-entropy body, so
documentation prose and example fingerprints do not false-positive.

Exit: 0 clean; 1 one or more hits (each printed as `<path>:<line>: <pattern>`).

Usage:
  python3 tools/scan-secrets.py            # scan the repo root
  python3 tools/scan-secrets.py --root DIR # scan an arbitrary tree (tests)
  python3 tools/scan-secrets.py --json     # machine-readable output

Skipped: VCS/build/dependency dirs (.git, node_modules, .next, dist, build,
__pycache__, .venv, venv), build output (api/lib/packages.generated.js), binary
file extensions, and the scanner's own file (its patterns are regex source, not
secrets — but a secret pasted into the scanner is the scanner's own business).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

# (label, compiled pattern). Keep the set high-signal: prefix + long body.
PATTERNS = [
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bghp_[0-9A-Za-z]{36}\b")),
    ("github_fine_grained_token", re.compile(r"\bgithub_pat_[0-9A-Za-z_]{22,}\b")),
    ("openai_anthropic_key", re.compile(r"\bsk-[0-9A-Za-z_-]{20,}\b")),
    ("stripe_key", re.compile(r"\bsk_(live|test)_[0-9A-Za-z]{20,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("private_key_pem", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("quoted_secret", re.compile(r"(?:password|passwd|api[_-]?key|client[_-]?secret)\s*[:=]\s*['\"][^'\" \t\n]{12,}['\"]", re.IGNORECASE)),
]

SKIP_DIRS = {
    ".git", "node_modules", ".next", "dist", "build", ".cache",
    "__pycache__", ".venv", "venv", ".pytest_cache",
}

SKIP_FILES = {
    "packages.generated.js",  # build output — regenerated every deploy
}

BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov",
    ".zip", ".gz", ".tar", ".tgz", ".pdf", ".wasm", ".exe", ".dll",
    ".so", ".dylib", ".bin", ".sqlite", ".db",
}


def scan_file(path: pathlib.Path, results: list) -> None:
    if path.name in SKIP_FILES:
        return
    if path.suffix.lower() in BINARY_EXT:
        return
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return
    for lineno, line in enumerate(text.splitlines(), 1):
        for label, pat in PATTERNS:
            if pat.search(line):
                results.append({"path": str(path), "line": lineno, "pattern": label})


def scan(root: pathlib.Path, skip_self: pathlib.Path | None = None) -> list:
    results: list = []
    if not root.is_dir():
        return results
    for entry in sorted(root.rglob("*")):
        if not entry.is_file():
            continue
        if skip_self is not None and entry.resolve() == skip_self.resolve():
            continue
        rel_parts = entry.relative_to(root).parts
        if any(p in SKIP_DIRS for p in rel_parts):
            continue
        scan_file(entry, results)
    return results


def main(argv) -> int:
    ap = argparse.ArgumentParser(prog="scan-secrets", description="Refuse secrets in source")
    ap.add_argument("--root", default=None, help="tree to scan (default: repo root)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    self_path = pathlib.Path(__file__).resolve()
    root = pathlib.Path(args.root).resolve() if args.root else self_path.parent.parent

    hits = scan(root, skip_self=self_path)
    if args.json:
        print(json.dumps({"root": str(root), "hits": hits}, indent=2))
    else:
        for h in hits:
            print("%s:%d: %s" % (h["path"], h["line"], h["pattern"]))
        print("%d secret(s) found in %s" % (len(hits), root))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
