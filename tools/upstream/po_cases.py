#!/usr/bin/env python3
"""Synthetic cases for the .po parser and resolver that the real catalogs do not cover.

The round-trip test proves the parser handles the catalogs as they exist today. These
cover shapes that are absent now and would corrupt silently if they appeared - found by
review rather than by failure, which is why they are pinned here.
"""
import sys

sys.path.insert(0, "tools/upstream")
import resolve_po as R  # noqa: E402

fail = 0


def check(label, got, want):
    global fail
    if got == want:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: got {got!r}, want {want!r}")
        fail += 1


HEADER = 'msgid ""\nmsgstr ""\n"Language: de\\n"\n'

# --- obsolete blocks -------------------------------------------------------------
# Every directive in an obsolete block sits behind "#~". A parser that treats any
# "#"-leading line as a comment never sees the msgid, so each block keys on (None, "")
# and successive blocks overwrite one another in the dict. Silent, and the
# implausible-entry-count guard does not catch it because the live entries still parse.
obsolete = (
    HEADER + "\n"
    'msgid "live one"\nmsgstr "lebendig"\n\n'
    '#~ msgid "dead a"\n#~ msgstr "tot a"\n\n'
    '#~ msgid "dead b"\n#~ msgstr "tot b"\n'
)
hdr, entries, n = R.parse(obsolete)
check("obsolete blocks are skipped, not collapsed onto one key", n, 1)
check("no entry keyed on the empty msgid", sum(1 for k in entries if k == (None, "")), 0)
check("the live entry survives", ("live one" in {k[1] for k in entries}), True)

# --- msgctxt disambiguation ------------------------------------------------------
# Two entries share a msgid and differ only by context. Keying on msgid alone would
# silently drop one translation.
ctxt = (
    HEADER + "\n"
    'msgctxt "verb"\nmsgid "Unlock"\nmsgstr "entsperren"\n\n'
    'msgctxt "noun"\nmsgid "Unlock"\nmsgstr "Entsperrung"\n'
)
_, entries, n = R.parse(ctxt)
check("msgctxt keeps same-msgid entries distinct", n, 2)
check("both contexts present", len({k[0] for k in entries}), 2)

# --- plurals ---------------------------------------------------------------------
plural = (
    HEADER + "\n"
    'msgid "one thread"\nmsgid_plural "{n} threads"\nmsgstr[0] "ein Thread"\nmsgstr[1] "{n} Threads"\n'
)
_, entries, n = R.parse(plural)
check("plural entry parses as one entry", n, 1)
e = next(iter(entries.values()))
check("both plural forms retained", e.translation().count("msgstr["), 2)

# --- multiline strings -----------------------------------------------------------
multi = HEADER + "\n" 'msgid ""\n"a long "\n"source string"\nmsgstr "eine lange Zeichenkette"\n'
_, entries, n = R.parse(multi)
check("multiline msgid is joined", ("a long source string" in {k[1] for k in entries}), True)

print()
print("FAILED" if fail else "all synthetic parser cases pass")
sys.exit(1 if fail else 0)
