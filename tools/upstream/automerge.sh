#!/usr/bin/env bash
# Merge the upstream commits that need no human judgement, gate them, push them, and
# report what is left. Designed to run daily; see tools/upstream/classify.py for how
# "needs no judgement" is derived.
#
#   tools/upstream/automerge.sh              # report only, changes nothing
#   APPLY=1 tools/upstream/automerge.sh      # merge, gate, push
#
# WHY A PREFIX, AND WHY IT STOPS: it merges UP TO a chosen upstream sha so the commits
# in between arrive as ancestors, and it stops at the first commit needing review
# rather than skipping past it. Skipping would mean cherry-picking, which on 2026-10-04
# froze the backlog counter at 77 while 44 PRs landed, and destroyed the merge base so
# every one of them would conflict again at the next real merge. A blocked queue is the
# signal to a human, not a fault.
#
# The value is highest run DAILY. Auto and review commits are interleaved, so a large
# backlog has blockers near the head and this will do little; a single day's upstream
# output usually starts with a clean run.
set -uo pipefail
APPLY=${APPLY:-0}
BASE=${BASE:-echowire}
UPSTREAM=${UPSTREAM:-upstream/main}
cd "$(git rev-parse --show-toplevel)" || exit 1
export PATH=/home/camp/.local/node/bin:$HOME/.cargo/bin:$PATH
say() { echo "== $*"; }

git fetch -q upstream || { say "ABORT: cannot fetch upstream"; exit 1; }

CUR=$(git rev-parse --abbrev-ref HEAD)
[ "$CUR" = "$BASE" ] || { say "ABORT: on '$CUR', expected '$BASE'"; exit 1; }
[ -z "$(git status --porcelain)" ] || { say "ABORT: working tree is dirty"; exit 1; }
git rev-parse --verify -q MERGE_HEAD >/dev/null && { say "ABORT: a merge is already in progress"; exit 1; }
[ -z "$(git stash list)" ] || say "WARNING: stash is not empty; never stash mid-merge"

BEHIND=$(git rev-list --count "$BASE..$UPSTREAM")
say "behind $UPSTREAM: $BEHIND"
[ "$BEHIND" -eq 0 ] && { say "nothing to do"; exit 0; }

TARGET=$(python3 tools/upstream/classify.py --base "$BASE" --upstream "$UPSTREAM" --prefix) || exit 2
if [ -z "$TARGET" ]; then
  say "mergeable prefix is empty: the next commit needs human review"
  python3 tools/upstream/classify.py --base "$BASE" --upstream "$UPSTREAM" | sed -n '1,9p'
  exit 0
fi
N=$(git rev-list --count "$BASE..$TARGET")
say "mergeable prefix: $N commits, up to $(git log -1 --format=%h "$TARGET")"
git log --oneline "$BASE..$TARGET" | sed 's/^/     /'

if [ "$APPLY" != 1 ]; then say "report only; set APPLY=1 to merge"; exit 0; fi

say "merging (no fast-forward so the merge is recorded)"
if ! git merge --no-ff --no-edit "$TARGET"; then
  say "ABORT: merge conflicted. A commit the classifier called clean still conflicts,"
  say "which means a divergence exists that carries no marker. Resolve by hand, then"
  say "add an 'Echowire:' marker to whatever diverged so this cannot recur."
  git merge --abort
  exit 1
fi

# Scope the gate to what the merge actually touched. Running everything every time is
# 25-40 minutes; most merges touch neither Rust nor Erlang.
CHANGED=$(git diff --name-only "ORIG_HEAD..HEAD")
has() { echo "$CHANGED" | grep -qE "$1"; }
say "gating (scoped to the diff)"
FAILED=""
run() { local n=$1; shift; printf '   %-26s ' "$n"; if "$@" >/tmp/am-$n.log 2>&1; then echo ok; else echo FAILED; FAILED="$FAILED $n"; fi; }

run typecheck pnpm typecheck
run biome pnpm exec biome ci .
run eslint pnpm exec eslint . --max-warnings 0
run knip pnpm knip
run test pnpm test
if has '\.rs$|Cargo\.(toml|lock)$|deny\.toml'; then
  run cargo-deny cargo deny --locked check -D warnings
  run cargo-fmt cargo fmt --all -- --check
  run desktop-native tools/ci/check-desktop-native-workspaces.sh fmt
  run cargo-clippy cargo clippy --workspace --exclude fluxer-media-proxy --all-targets --all-features --locked -- -D warnings
  run cargo-test cargo test --workspace --exclude fluxer-media-proxy --locked
else
  say "   (no Rust changes: cargo gates skipped)"
fi
if has '^fluxer_gateway/'; then
  run gateway-fmt cargo run -p fluxer-ci -- ci --step gateway_fmt
  run gateway-compile cargo run -p fluxer-ci -- ci --step gateway_compile
else
  say "   (no gateway changes: erlang gates skipped)"
fi
if has '^deploy/self-hosting/'; then
  run deploy-env bash -c 'cd packages/config && pnpm exec vitest run src/__tests__/DeployEnvCoverage.test.ts'
fi
if has '^fluxer_docs/'; then
  run docs-verify pnpm --filter fluxer_docs verify
fi

if [ -n "$FAILED" ]; then
  say "GATE FAILED:$FAILED"
  say "the merge is committed locally and NOT pushed. Logs in /tmp/am-*.log."
  say "Fix forward or 'git reset --hard ORIG_HEAD' to undo."
  exit 1
fi

say "gate green; pushing"
git push -q origin "$BASE" && git push -q gitea "$BASE" && say "pushed to origin and gitea"
say "now behind $UPSTREAM: $(git rev-list --count "$BASE..$UPSTREAM")"
say "next blocker:"
python3 tools/upstream/classify.py --base "$BASE" --upstream "$UPSTREAM" | sed -n '/blocked by/,+1p'
say "read the CI result: gh run list -R cproudlock/echowire --workflow Tests --branch $BASE --limit 1"
