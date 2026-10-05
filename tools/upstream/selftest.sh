#!/usr/bin/env bash
# Verify the classifier against commits whose correct verdict is known, and verify it
# fails closed. Deliberately creates no branches and no commits: this repo's .git is
# shared with merge worktrees, so a self-test that mutated refs could disturb work in
# progress. It asserts behaviour instead of injecting faults into history.
#
#   tools/upstream/selftest.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
C=tools/upstream/classify.py
PASS=0; FAIL=0
ok()  { echo "  PASS  $*"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }

verdict_of() {  # $1 = sha ; prints "verdict reason"
  python3 "$C" --base "$1~1" --upstream "$1" --json 2>/dev/null \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
c=d["commits"][0] if d["commits"] else {"verdict":"none","reason":""}
print(c["verdict"], c["reason"])'
}

echo "=== fails closed when the marker sweep cannot work"
# From a subdirectory git grep sees only that subtree, so the derived divergence set
# collapses. That must abort rather than silently classify everything as auto.
if (cd packages && python3 "../../$C" --prefix >/dev/null 2>&1); then
  bad "accepted an implausible marker set (should exit 2)"
else
  ok "aborts when the marker set is implausibly small"
fi

echo
echo "=== known verdicts, if the commits are reachable"
# Chosen because each exercises a different clause. Skipped rather than failed if the
# range has moved on, so this test does not rot into a false failure.
check() {  # sha expected_verdict expected_reason_prefix label
  local sha=$1 want=$2 reason=$3 label=$4
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
    echo "  SKIP  $label ($sha not reachable)"; return
  fi
  read -r v r <<<"$(verdict_of "$sha")"
  if [ "$v" = "$want" ] && [[ "$r" == "$reason"* ]]; then
    ok "$label -> $v ${r:0:40}"
  else
    bad "$label -> $v/$r, expected $want/$reason*"
  fi
}

check db9ec0605 review marker:fluxer_media_proxy "media-proxy chunk limit (marked file)"
check 69d93f9fe review renamed-term               "Plutonium page (renamed term, NO marker)"
check b52a0b5d5 review catalog:                   "paused messaging wording (catalog)"
check 00620715d auto   ""                         "drop node stats logging (clean)"

echo
echo "=== the prefix stops at the first review commit rather than skipping it"
# Build a range whose first commit is known to need review. If the prefix were computed
# by filtering rather than by stopping, it would return a later sha and ancestry would
# be lost - which is exactly the cherry-pick failure this tool exists to prevent.
if git cat-file -e db9ec0605^{commit} 2>/dev/null; then
  P=$(python3 "$C" --base db9ec0605~1 --upstream db9ec0605 --prefix)
  [ -z "$P" ] && ok "prefix empty when the first commit needs review" \
               || bad "prefix returned $P, expected empty"
else
  echo "  SKIP  prefix stop test (commit not reachable)"
fi

echo
echo "=== the derived marker set is plausible from the repo root"
N=$(git grep -l "Echowire:" -- ':!AGENTS.md' ':!docs/' | wc -l)
[ "$N" -ge 50 ] && ok "marker sweep sees $N files" || bad "marker sweep saw only $N files"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
