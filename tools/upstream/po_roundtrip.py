#!/usr/bin/env python3
"""Round-trip test for the .po parser in resolve_po.py.

The failure that would matter most is silently losing or mangling entries, which in a
34-locale merge would delete translations with nothing to notice it. So this parses
every real catalog, re-serialises, re-parses, and asserts the (msgctxt, msgid) ->
translation mapping is identical both times. It also checks the entry count against an
independent grep, so a parser that quietly swallowed half the file cannot pass.
"""
import glob
import re
import subprocess
import sys
import pathlib

sys.path.insert(0, "tools/upstream")
import resolve_po as R  # noqa: E402

fail = 0
files = sorted(glob.glob("fluxer_app/src/features/i18n/locales/*/messages.po"))
if not files:
    print("no catalogs found; run from the repo root")
    sys.exit(2)

print(f"catalogs: {len(files)}")
for path in files:
    text = pathlib.Path(path).read_text(encoding="utf-8")
    hdr, entries, n = R.parse(text)

    # independent count: msgid lines at column 0 that are not the header's empty msgid
    raw = len(re.findall(r"^msgid ", text, re.M))
    expect = raw - 1  # minus the header entry
    loc = path.split("/")[-2]

    if abs(n - expect) > 0:
        print(f"  FAIL {loc}: parsed {n} entries, grep says {expect}")
        fail += 1
        continue

    # re-serialise and re-parse
    body = "\n\n".join(["\n".join(hdr)] + [e.text() for e in entries.values()]) + "\n"
    _, again, n2 = R.parse(body)
    if n2 != n:
        print(f"  FAIL {loc}: re-parse produced {n2} entries, expected {n}")
        fail += 1
        continue

    lost = set(entries) - set(again)
    if lost:
        print(f"  FAIL {loc}: {len(lost)} entries lost on round-trip, e.g. {list(lost)[:2]}")
        fail += 1
        continue

    changed = [
        k for k in entries
        if entries[k].translation() != again[k].translation()
    ]
    if changed:
        print(f"  FAIL {loc}: {len(changed)} translations changed on round-trip")
        print(f"        e.g. {changed[0]}")
        fail += 1
        continue

    print(f"  ok   {loc:<7} {n} entries, round-trip identical")

print()
print("FAILED" if fail else "all catalogs round-trip without losing or altering an entry")
sys.exit(1 if fail else 0)
