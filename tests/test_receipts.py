#!/usr/bin/env python3
"""U1 receipts — deterministic-first verify-before-ship battery.

Forces the three failure modes the GEST-ENTERPRISE-UPLEVEL-SPEC U1 gap names,
and proves the reference CLI's exit-code contract:

  (a) tampered artifact           -> `verify` exit 2
  (b) manifest fingerprint != tree -> refusal (exit 2)
  (c) manifest with a missing/phantom file -> flagged (exit 2), never silently accepted

Plus the file-map completeness/accuracy checks that ride the same refusal path:

  (d) unlisted file (present in tree, absent from map) -> exit 2
  (e) size mismatch (listed vs actual bytes)           -> exit 2
  (f) no File map section (required field missing)     -> exit 2

And the control cases that must stay green:

  (0) a clean armed package       -> exit 0
  (1) init -> verify round-trip   -> exit 0
  (2) no manifest                 -> exit 1 (cannot even attempt verification)

Zero dependencies (stdlib unittest + subprocess), deterministic fixtures in a
tempdir, no network. Runs on Python 3.9+.

Run:  python3 tests/test_receipts.py
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "ingest.py"

sys.path.insert(0, str(REPO_ROOT))
import ingest  # noqa: E402 — stdlib-only module; import is side-effect-free


def run_cli(*args):
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True, text=True,
    )


class VerifyBeforeShipReceipts(unittest.TestCase):
    """The three forced-failure receipts + the control cases, end to end."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.pkg = pathlib.Path(self._tmp.name) / "pkg"
        (self.pkg / "sub").mkdir(parents=True)
        (self.pkg / "README.md").write_text("# A report\n\nBody.\n", encoding="utf-8")
        (self.pkg / "data.txt").write_text("alpha\n", encoding="utf-8")
        (self.pkg / "sub" / "note.md").write_text("nested\n", encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    # -- helpers ------------------------------------------------------
    def arm(self):
        r = run_cli("init", str(self.pkg), "--visibility", "public")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    @property
    def manifest(self):
        return self.pkg / "INGEST.md"

    def read_manifest(self):
        return self.manifest.read_text(encoding="utf-8")

    def write_manifest(self, text):
        self.manifest.write_text(text, encoding="utf-8")

    def verify(self):
        return run_cli("verify", str(self.pkg))

    # -- control cases ------------------------------------------------
    def test_clean_package_verifies_exit_0(self):
        self.arm()
        r = self.verify()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("VERIFY PASS", r.stdout)

    def test_init_verify_roundtrip_exit_0(self):
        self.arm()
        # re-init is stable (idempotent gest-id reuse) and still verifies clean
        run_cli("init", str(self.pkg), "--visibility", "public")
        r = self.verify()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_no_manifest_exit_1(self):
        # no manifest at all -> cannot attempt verification
        r = self.verify()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    # -- (a) tampered artifact ----------------------------------------
    def test_tampered_artifact_exit_2(self):
        self.arm()
        (self.pkg / "data.txt").write_text("tampered!\n", encoding="utf-8")
        r = self.verify()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("MISMATCH", r.stdout)

    # -- (b) manifest fingerprint != tree -----------------------------
    def test_manifest_fingerprint_mismatch_exit_2(self):
        self.arm()
        fp = ingest.fingerprint_files(self.pkg)
        # corrupt the manifest's own fingerprint field; the tree is untouched
        bad = self.read_manifest().replace(fp, "0" * 16, 1)
        self.assertNotEqual(bad, self.read_manifest())
        self.write_manifest(bad)
        r = self.verify()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("MISMATCH", r.stdout)

    # -- (c) phantom file (listed, absent from tree) ------------------
    def test_phantom_file_exit_2(self):
        self.arm()
        text = self.read_manifest().replace(
            "## File map\n", "## File map\n- `ghost.txt` — 4 bytes\n", 1)
        self.write_manifest(text)
        r = self.verify()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("PHANTOM", r.stdout)
        self.assertIn("`ghost.txt`", r.stdout)

    # -- (d) unlisted file (present in tree, absent from map) ---------
    def test_unlisted_file_exit_2(self):
        self.arm()
        old_fp = ingest.fingerprint_files(self.pkg)
        # add a file AND update the fingerprint to match it, so the ONLY
        # remaining inconsistency is that the file map omits the new file
        (self.pkg / "extra.txt").write_text("extra\n", encoding="utf-8")
        new_fp = ingest.fingerprint_files(self.pkg)
        self.assertNotEqual(old_fp, new_fp)
        self.write_manifest(self.read_manifest().replace(old_fp, new_fp, 1))
        r = self.verify()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("UNLISTED", r.stdout)
        self.assertIn("`extra.txt`", r.stdout)

    # -- (e) size mismatch (listed vs actual bytes) -------------------
    def test_size_mismatch_exit_2(self):
        self.arm()
        text = re.sub(
            r"(`data\.txt` — )\d+( bytes)", r"\g<1>999\g<2>",
            self.read_manifest(), count=1)
        self.assertNotEqual(text, self.read_manifest())
        self.write_manifest(text)
        r = self.verify()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("SIZE mismatch", r.stdout)

    # -- (f) no File map section --------------------------------------
    def test_missing_file_map_section_exit_2(self):
        self.arm()
        self.write_manifest(self.read_manifest().replace("## File map", "## Files", 1))
        r = self.verify()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("File map", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
