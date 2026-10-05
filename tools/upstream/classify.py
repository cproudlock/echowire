#!/usr/bin/env python3
"""Classify upstream commits as auto-mergeable or needing human review.

Measured on 2026-10-04 against a 74-commit backlog: 58% of upstream commits touch
nothing this fork has deliberately changed, and merging those needs no judgement.
This finds them so a human only looks at the rest.

THE DESIGN RULE: nothing here is hand-maintained. Every clause derives from the tree
or from the commit's own diff, so it cannot go stale as divergences are added or
retired. An earlier hand-written list of 18 path patterns misclassified four commits
because the real divergence surface is 263 files.

A commit needs human review if ANY of:

  1. it touches a file carrying an "Echowire:" marker  (the fork's own convention for
     marking a deliberate divergence, so this set maintains itself)
  2. it touches a translation catalog or the errors i18n tree  (the brand lives in
     msgids, so upstream string changes conflict across 34 locales)
  3. its diff mentions a term this fork renames  (Plutonium -> Reverb, Neko -> Pickles,
     or the upstream brand). Markers alone are NOT sufficient: upstream's Plutonium
     pages carry no marker yet conflict on every rename.

Exit status is 0 on success, 2 if the derived divergence set looks implausible - a
check that silently measures nothing is worse than no check, so it fails closed.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

MARKER = "Echowire:"
# Clause 2: paths where the brand or fork copy lives in data rather than code.
CATALOG_RE = re.compile(
    r"(^|/)messages\.po$|/locales/|^packages/errors/src/i18n/|^fluxer_marketing/"
)
# Clause 3: terms this fork renames. A diff mentioning one will conflict on the rename
# wherever it appears, with or without a marker.
RENAMED_RE = re.compile(r"Plutonium|\bNeko\b|Fluxer")
# Below this, the marker sweep has clearly failed (wrong cwd, bad pathspec) rather than
# the fork having genuinely few divergences. 263 files carried markers when measured.
MIN_PLAUSIBLE_MARKERS = 50


def git(*args: str) -> str:
    out = subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        print(f"git {' '.join(args)} failed: {out.stderr.strip()}", file=sys.stderr)
        sys.exit(2)
    return out.stdout


def marked_files() -> set[str]:
    """Files carrying the fork's divergence marker. Derived, never listed."""
    text = git("grep", "-l", MARKER, "--", ":!AGENTS.md", ":!docs/")
    files = {line for line in text.splitlines() if line}
    if len(files) < MIN_PLAUSIBLE_MARKERS:
        print(
            f"refusing: only {len(files)} files carry an '{MARKER}' marker, expected at "
            f"least {MIN_PLAUSIBLE_MARKERS}. The sweep has probably failed rather than "
            f"the fork having stopped diverging. Run from the repo root.",
            file=sys.stderr,
        )
        sys.exit(2)
    return files


def classify(sha: str, marked: set[str]) -> tuple[str, str]:
    """Return (verdict, reason). verdict is 'auto' or 'review'."""
    files = [f for f in git("show", "--name-only", "--format=", sha).splitlines() if f]
    for f in files:
        if f in marked:
            return "review", f"marker:{f}"
        if CATALOG_RE.search(f):
            return "review", f"catalog:{f}"
    if RENAMED_RE.search(git("show", sha)):
        return "review", "renamed-term"
    return "auto", ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="echowire", help="fork ref (default: echowire)")
    ap.add_argument("--upstream", default="upstream/main")
    ap.add_argument(
        "--prefix",
        action="store_true",
        help="print only the sha of the longest auto-mergeable prefix, or nothing",
    )
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    marked = marked_files()
    shas = [
        s
        for s in git(
            "rev-list", "--reverse", "--no-merges", f"{args.base}..{args.upstream}"
        ).splitlines()
        if s
    ]

    rows = []
    prefix_end: str | None = None
    prefix_len = 0
    blocking: tuple[str, str, str] | None = None
    for sha in shas:
        verdict, reason = classify(sha, marked)
        subject = git("log", "-1", "--format=%s", sha).strip()
        rows.append(
            {"sha": sha[:9], "verdict": verdict, "reason": reason, "subject": subject}
        )
        if verdict == "auto" and blocking is None:
            prefix_end = sha
            prefix_len += 1
        elif blocking is None:
            blocking = (sha[:9], reason, subject)

    # --prefix is what the runner consumes. Stopping at the FIRST review commit rather
    # than skipping past it is deliberate: it keeps ancestry truthful and makes
    # prerequisites arrive as ancestors. A blocked queue is the signal, not a bug.
    if args.prefix:
        if prefix_end:
            print(prefix_end)
        return 0

    if args.json:
        print(
            json.dumps(
                {
                    "marked_files": len(marked),
                    "behind": len(shas),
                    "auto_prefix_len": prefix_len,
                    "auto_prefix_end": prefix_end,
                    "blocking": blocking,
                    "commits": rows,
                },
                indent=2,
            )
        )
        return 0

    auto = sum(1 for r in rows if r["verdict"] == "auto")
    print(f"divergence markers: {len(marked)} files")
    print(f"behind {args.upstream}: {len(shas)}")
    print(f"  auto-mergeable anywhere in the range: {auto}")
    print(f"  needing review:                       {len(shas) - auto}")
    print()
    print(f"mergeable prefix (contiguous from the base): {prefix_len} commits")
    if prefix_end:
        print(f"  merge target: {prefix_end[:9]}")
    if blocking:
        print(f"  blocked by:   {blocking[0]}  {blocking[1]}")
        print(f"                {blocking[2][:72]}")
    print()
    for r in rows:
        mark = "auto  " if r["verdict"] == "auto" else "REVIEW"
        print(f"  {r['sha']}  {mark}  {r['reason'][:34]:<34}  {r['subject'][:58]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
