#!/usr/bin/env bash
# Staging gate: bring up the self-host stack for an image TAG, run the scenarios, tear it down.
# Exits 0 only when every container is up and every scenario passed. See README.md.
#
#   tools/staging-gate/gate.sh TAG [--worktree PATH] [--changed-from REF] [--results DIR] [--keep]
#   tools/staging-gate/gate.sh --self-test
#
# Exit codes: 0 GATE_PASS, 1 GATE_FAIL (containers or scenarios), 2 could not run (lock, keys,
# images, self-test). The last line printed is always GATE_PASS, GATE_FAIL or an ABORT line.
set -uo pipefail

GATE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$GATE_HERE/lib.sh"

STAGE_DIR="${STAGE_DIR:-/root/stage-19t}"
RESULTS_ROOT="${GATE_RESULTS_DIR:-/root/gate-results}"
BASE_URL="${GATE_BASE_URL:-http://localhost:8080}"
WAIT_SECONDS="${GATE_WAIT_SECONDS:-420}"
TAG=""
WORKTREE=""
CHANGED_FROM=""
KEEP=0
SELFTEST_ONLY=0

while [ $# -gt 0 ]; do
	case "$1" in
		--self-test) SELFTEST_ONLY=1 ;;
		--worktree) WORKTREE="$2"; shift ;;
		--changed-from) CHANGED_FROM="$2"; shift ;;
		--results) RESULTS_ROOT="$2"; shift ;;
		--keep) KEEP=1 ;;
		-h | --help) sed -n 2,12p "$0"; exit 0 ;;
		-*) die "unknown option $1" ;;
		*) TAG="$1" ;;
	esac
	shift
done

if [ "$SELFTEST_ONLY" = 1 ]; then
	run_selftest
	exit $?
fi

[ -n "$TAG" ] || die "usage: gate.sh TAG [--worktree PATH] [--changed-from REF] [--keep]"
[ -n "$WORKTREE" ] || WORKTREE="$(git -C "$GATE_HERE" rev-parse --show-toplevel)"
[ -d "$WORKTREE/deploy/self-hosting" ] || die "no deploy/self-hosting under $WORKTREE"
[ -n "$(ls "$GATE_HERE"/scenarios/*.mjs 2>/dev/null)" ] || die "no scenarios under $GATE_HERE/scenarios"

# The gate must not run unless it has just shown that it can fail.
run_selftest || die "self-test failed: this gate cannot prove it detects failures, so it will not run"

acquire_stage_lock || die "another gate is running"
check_key_headroom || die "not enough kernel keys to start the stack"

OUT="$RESULTS_ROOT/${TAG}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT" || die "cannot create $OUT"
log "gate for tag ${TAG}, worktree $(git -C "$WORKTREE" rev-parse --short HEAD), results in $OUT"

prepare_stage "$TAG" "$WORKTREE" || die "could not prepare $STAGE_DIR"
check_images || { restore_stage_tag; die "images for ${TAG} are not all on this box (build them first)"; }

# shellcheck disable=SC2329  # called through the EXIT trap
teardown() {
	if [ "$KEEP" = 1 ]; then
		log "stack left up (--keep); remove with: cd $STAGE_DIR && docker compose down -v"
		return
	fi
	stage_compose down -v --remove-orphans >"$OUT/down.log" 2>&1
}
trap teardown EXIT

log "clean slate: docker compose down -v"
stage_compose down -v --remove-orphans >"$OUT/down-start.log" 2>&1
log "docker compose up -d"
stage_compose up -d >"$OUT/up.log" 2>&1 || {
	tail -n 15 "$OUT/up.log"
	log "compose up failed"
	CONTAINERS_RC=1
}

CONTAINERS_RC=${CONTAINERS_RC:-0}
if [ "$CONTAINERS_RC" = 0 ]; then
	wait_containers "$OUT" "$WAIT_SECONDS"
	CONTAINERS_RC=$?
fi

SCENARIOS_RC=1
if [ "$CONTAINERS_RC" = 0 ]; then
	log "running scenarios against $BASE_URL"
	extra_args=()
	[ -n "$CHANGED_FROM" ] && extra_args+=(--changed-from "$CHANGED_FROM")
	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "$BASE_URL" --stage-dir "$STAGE_DIR" --worktree "$WORKTREE" \
		--scenarios "$GATE_HERE/scenarios" --extra-dir "$GATE_HERE/extra" --min-scenarios 12 \
		--results "$OUT/scenarios.json" "${extra_args[@]}"
	SCENARIOS_RC=$?
else
	log "containers are not all up: scenarios not run"
fi

if [ "$CONTAINERS_RC" = 0 ] && [ "$SCENARIOS_RC" = 0 ]; then
	VERDICT=GATE_PASS
	RC=0
else
	VERDICT=GATE_FAIL
	RC=1
fi
printf '{"tag":"%s","commit":"%s","verdict":"%s","containers_rc":%s,"scenarios_rc":%s,"finished":"%s"}\n' \
	"$TAG" "$(git -C "$WORKTREE" rev-parse --short HEAD)" "$VERDICT" "$CONTAINERS_RC" "$SCENARIOS_RC" \
	"$(date -u +%FT%TZ)" >"$OUT/gate.json"
log "${VERDICT} tag=${TAG} containers_rc=${CONTAINERS_RC} scenarios_rc=${SCENARIOS_RC} results=${OUT}"
exit "$RC"
