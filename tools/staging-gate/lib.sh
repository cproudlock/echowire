#!/usr/bin/env bash
# Shared functions for tools/staging-gate/gate.sh. Sourced, never run directly.
# Every check returns non-zero on failure; nothing here swallows an error.

GATE_HERE="${GATE_HERE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
NODE="${NODE:-$(command -v node || echo /home/camp/.local/node/bin/node)}"
STAGE_LOCK="${STAGE_LOCK:-/root/staging.lock}"
KEY_USERS_FILE="${KEY_USERS_FILE:-/proc/key-users}"
MIN_FREE_KEYS="${MIN_FREE_KEYS:-120}"
MIN_FREE_KEY_BYTES="${MIN_FREE_KEY_BYTES:-8000}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ABORT: $*" >&2; exit 2; }

# Kernel keyring quota: all containers of one host user share it. Out of keys, containers fail to
# start with "disk quota exceeded" and a gate would test a half-started stack. Fail early instead.
check_key_headroom() {
	local uid="${KEY_UID:-$(id -u)}" line
	line=$(grep -E "^[[:space:]]*${uid}:" "$KEY_USERS_FILE" 2>/dev/null | head -1)
	if [ -z "$line" ]; then
		log "key headroom: no entry for uid ${uid} in ${KEY_USERS_FILE}"
		return 1
	fi
	awk -v need_keys="$MIN_FREE_KEYS" -v need_bytes="$MIN_FREE_KEY_BYTES" '{
		split($4, k, "/"); split($5, b, "/");
		free_keys = k[2] - k[1]; free_bytes = b[2] - b[1];
		printf "key headroom: %d keys free (need %d), %d bytes free (need %d)\n", free_keys, need_keys, free_bytes, need_bytes;
		if (free_keys < need_keys || free_bytes < need_bytes) {
			print "key headroom: too low. Raise it on the host: sudo sysctl -w kernel.keys.maxkeys=2000 kernel.keys.maxbytes=200000";
			exit 1
		}
	}' <<<"$line"
}

# One gate at a time: two staging stacks share container names, ports and the key quota.
acquire_stage_lock() {
	exec 9>"$STAGE_LOCK" || return 1
	if ! flock -n 9; then
		log "staging lock ${STAGE_LOCK} is held by another gate run"
		return 1
	fi
	printf '%s pid=%s\n' "$(date -u +%FT%TZ)" "$$" >"$STAGE_LOCK"
}

stage_compose() { (cd "$STAGE_DIR" && docker compose "$@"); }

# run_bounded SECONDS CMD...: run CMD, kill it SECONDS after it starts (then 10 s later with KILL). Exit 124 on timeout.
run_bounded() {
	local secs="$1"
	shift
	timeout --kill-after=10 "$secs" "$@"
}

# Name what is wrong with the stack right now (written to OUT/containers.json too).
describe_unhealthy() {
	local out="$1"
	stage_compose config --format json >"$out/compose-config.json" 2>/dev/null || return 0
	stage_compose ps -a --format json >"$out/ps.json" 2>/dev/null || return 0
	"$NODE" "$GATE_HERE/containers.mjs" --ps "$out/ps.json" --config "$out/compose-config.json" --json "$out/containers.json" --explain
}

# docker compose up -d, but never longer than SECONDS. exec makes timeout signal compose itself, not a wrapper shell.
# On timeout the unhealthy containers are named; the caller fails the gate and the EXIT trap still tears the stack down.
bounded_compose_up() {
	local out="$1" secs="$2" rc
	(cd "$STAGE_DIR" && exec timeout --kill-after=10 "$secs" docker compose up -d) >"$out/up.log" 2>&1
	rc=$?
	if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
		log "compose up did not finish within ${secs}s (GATE_UP_SECONDS); containers that are not healthy:"
		describe_unhealthy "$out"
		return 124
	fi
	return "$rc"
}

# Copy the merged compose into the long-lived stage dir (its .env keeps the secrets) and set the tag.
prepare_stage() {
	local tag="$1" wt="$2" f
	[ -f "$STAGE_DIR/.env" ] || { log "no $STAGE_DIR/.env"; return 1; }
	for f in docker-compose.yml Caddyfile docker-compose.proxy.yml; do
		[ -f "$wt/deploy/self-hosting/$f" ] || { log "missing $wt/deploy/self-hosting/$f"; return 1; }
		[ -f "$STAGE_DIR/$f" ] && cp -p "$STAGE_DIR/$f" "$STAGE_DIR/$f.pre-gate"
		cp "$wt/deploy/self-hosting/$f" "$STAGE_DIR/$f"
	done
	PREV_STAGE_TAG=$(sed -n -E 's/^FLUXER_IMAGE_TAG=(.*)$/\1/p' "$STAGE_DIR/.env" | head -1)
	sed -i -E "s/^FLUXER_IMAGE_TAG=.*/FLUXER_IMAGE_TAG=${tag}/" "$STAGE_DIR/.env"
	grep -q "^FLUXER_IMAGE_TAG=${tag}\$" "$STAGE_DIR/.env" || { log "could not set FLUXER_IMAGE_TAG"; return 1; }
}

# Put the stage .env tag back when the gate gives up before starting anything.
restore_stage_tag() {
	[ -n "${PREV_STAGE_TAG:-}" ] && sed -i -E "s/^FLUXER_IMAGE_TAG=.*/FLUXER_IMAGE_TAG=${PREV_STAGE_TAG}/" "$STAGE_DIR/.env"
}

# Every image the compose names must already be on this box, or compose would try to pull.
check_images() {
	local missing=0 img
	while IFS= read -r img; do
		[ -n "$img" ] || continue
		docker image inspect "$img" >/dev/null 2>&1 || { log "image missing: $img"; missing=1; }
	done < <(stage_compose config --images | sort -u)
	[ "$missing" = 0 ]
}

# Wait until every service of the compose is up, healthy or (one-shot) exited 0. Missing or sick
# containers after the timeout fail the gate; the table of what is wrong is printed either way.
wait_containers() {
	local out="$1" timeout="${2:-420}" waited=0 rc
	stage_compose config --format json >"$out/compose-config.json" || return 1
	while :; do
		stage_compose ps -a --format json >"$out/ps.json" || return 1
		"$NODE" "$GATE_HERE/containers.mjs" --ps "$out/ps.json" --config "$out/compose-config.json" --quiet
		rc=$?
		[ "$rc" = 0 ] && break
		[ "$waited" -ge "$timeout" ] && break
		sleep 5
		waited=$((waited + 5))
	done
	"$NODE" "$GATE_HERE/containers.mjs" --ps "$out/ps.json" --config "$out/compose-config.json" \
		--json "$out/containers.json"
}

# Prove the gate can fail. Each case plants a failure (or a clean control) and asserts the verdict.
# If any planted failure comes back as a pass, the gate cannot be trusted and must not run.
run_selftest() {
	local tmp rc
	tmp=$(mktemp -d)
	ST_STUB_PID=""
	ST_EXTRA_PIDS=""
	_selftest_body "$tmp"
	rc=$?
	[ -n "$ST_STUB_PID" ] && kill "$ST_STUB_PID" 2>/dev/null
	# shellcheck disable=SC2086  # a space separated list of pids
	[ -n "$ST_EXTRA_PIDS" ] && kill $ST_EXTRA_PIDS 2>/dev/null
	rm -rf "$tmp"
	return "$rc"
}

_selftest_body() {
	local tmp="$1" st="$GATE_HERE/selftest" ok=0 bad=0 port stub_pid holder

	t_ok() { log "  PASS  $1"; ok=$((ok + 1)); }
	t_bad() { log "  FAIL  $1"; bad=$((bad + 1)); }
	expect_rc() { # name, want (zero|nonzero), actual rc
		if [ "$2" = zero ] && [ "$3" = 0 ]; then t_ok "$1 (exit 0)"
		elif [ "$2" = nonzero ] && [ "$3" != 0 ]; then t_ok "$1 (exit $3)"
		else t_bad "$1 (wanted $2, got exit $3)"; fi
	}

	log "=== staging gate self-test"
	"$NODE" "$st/stub-server.mjs" >"$tmp/port" 2>"$tmp/stub.err" &
	stub_pid=$!
	ST_STUB_PID="$stub_pid"
	for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$tmp/port" ] && break; sleep 0.3; done
	port=$(cat "$tmp/port")
	[ -n "$port" ] || { log "  FAIL  stub server did not start"; return 1; }

	# runner: dead target, planted failure, control, empty dir, hang, missing minimum
	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:9" --scenarios "$GATE_HERE/scenarios" \
		--only 01-health --min-scenarios 1 --results "$tmp/r1.json" >"$tmp/o1" 2>&1
	expect_rc "real health scenario against a dead port fails" nonzero $?

	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${port}" --scenarios "$st/planted-fail" \
		--min-scenarios 1 --results "$tmp/r2.json" >"$tmp/o2" 2>&1
	expect_rc "planted failing scenario fails the run" nonzero $?
	if grep -q '"status": "FAIL"' "$tmp/r2.json"; then
		t_ok "planted failure is a FAIL row in the results JSON"
	else
		t_bad "planted failure missing from the results JSON"
	fi

	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${port}" --scenarios "$st/planted-pass" \
		--min-scenarios 1 --results "$tmp/r3.json" >"$tmp/o3" 2>&1
	expect_rc "control scenario against the stub passes" zero $?

	mkdir "$tmp/empty"
	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${port}" --scenarios "$tmp/empty" \
		--min-scenarios 1 --results "$tmp/r4.json" >"$tmp/o4" 2>&1
	expect_rc "an empty scenario directory fails (the old silent pass)" nonzero $?

	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${port}" --scenarios "$st/planted-pass" \
		--min-scenarios 5 --results "$tmp/r5.json" >"$tmp/o5" 2>&1
	expect_rc "fewer scenarios than the required minimum fails" nonzero $?

	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${port}" --scenarios "$st/planted-hang" \
		--min-scenarios 1 --timeout 1500 --results "$tmp/r6.json" >"$tmp/o6" 2>&1
	expect_rc "a hanging scenario times out and fails" nonzero $?

	# containers: complete, missing service, unhealthy, one-shot failed
	"$NODE" "$GATE_HERE/containers.mjs" --ps "$st/fixtures/ps-ok.ndjson" --config "$st/fixtures/config.json" --quiet
	expect_rc "complete container set passes" zero $?
	"$NODE" "$GATE_HERE/containers.mjs" --ps "$st/fixtures/ps-missing.ndjson" --config "$st/fixtures/config.json" --quiet
	expect_rc "a missing container fails" nonzero $?
	"$NODE" "$GATE_HERE/containers.mjs" --ps "$st/fixtures/ps-unhealthy.ndjson" --config "$st/fixtures/config.json" --quiet
	expect_rc "an unhealthy container fails" nonzero $?
	"$NODE" "$GATE_HERE/containers.mjs" --ps "$st/fixtures/ps-oneshot-failed.ndjson" --config "$st/fixtures/config.json" --quiet
	expect_rc "a failed one-shot container fails" nonzero $?
	"$NODE" "$GATE_HERE/containers.mjs" --ps "$st/fixtures/ps-blocked.ndjson" --config "$st/fixtures/config.json" --explain >"$tmp/explain" 2>&1
	expect_rc "a stack with a stuck container and a blocked one fails" nonzero $?
	if grep -q "CULPRIT  api (unhealthy" "$tmp/explain"; then t_ok "...the explanation names the unhealthy container as the culprit"; else t_bad "the explanation did not name api as the culprit"; fi
	if grep -q "WAITING  proxy" "$tmp/explain"; then t_ok "...and the container that never started as waiting"; else t_bad "the explanation did not list proxy as waiting"; fi

	# key headroom
	KEY_USERS_FILE="$st/fixtures/key-users-low" KEY_UID=0 check_key_headroom >/dev/null
	expect_rc "low key headroom fails" nonzero $?
	KEY_USERS_FILE="$st/fixtures/key-users-ok" KEY_UID=0 check_key_headroom >/dev/null
	expect_rc "ample key headroom passes" zero $?

	# lock: a held lock refuses a second runner
	( exec 8>"$tmp/lock"; flock -n 8; sleep 4 ) &
	holder=$!
	sleep 0.5
	( STAGE_LOCK="$tmp/lock" acquire_stage_lock >/dev/null 2>&1 )
	expect_rc "a held staging lock refuses a second gate" nonzero $?
	wait "$holder"
	( STAGE_LOCK="$tmp/lock" acquire_stage_lock >/dev/null 2>&1 )
	expect_rc "a free staging lock is taken" zero $?

	# log scan: planted error found, allowlisted noise ignored
	"$NODE" "$GATE_HERE/lib/logscan-check.mjs" "$st/fixtures/log-planted.txt" "$st/fixtures/allow.txt" >/dev/null
	expect_rc "a planted ERROR line in logs is flagged" nonzero $?
	"$NODE" "$GATE_HERE/lib/logscan-check.mjs" "$st/fixtures/log-allowed.txt" "$st/fixtures/allow.txt" >/dev/null
	expect_rc "allowlisted log noise is ignored" zero $?

	# log scan, two-look: a startup race that stops is tolerated, a fatal line, errors that keep arriving and
	# a repeating error are not (fire-drill 2026-11-03)
	"$NODE" "$GATE_HERE/lib/logscan-check.mjs" "$st/fixtures/log-transient-full.txt" "$st/fixtures/allow.txt" --later "$st/fixtures/log-quiet-later.txt" >/dev/null
	expect_rc "a one-off error that stops after the re-scan passes" zero $?
	"$NODE" "$GATE_HERE/lib/logscan-check.mjs" "$st/fixtures/log-transient-full.txt" "$st/fixtures/allow.txt" --later "$st/fixtures/log-error-later.txt" >/dev/null
	expect_rc "an error that persists into the re-scan fails" nonzero $?
	"$NODE" "$GATE_HERE/lib/logscan-check.mjs" "$st/fixtures/log-fatal.txt" "$st/fixtures/allow.txt" --later "$st/fixtures/log-quiet-later.txt" >/dev/null
	expect_rc "a FATAL line fails even when nothing follows it" nonzero $?
	"$NODE" "$GATE_HERE/lib/logscan-check.mjs" "$st/fixtures/log-repeating.txt" "$st/fixtures/allow.txt" --later "$st/fixtures/log-quiet-later.txt" >/dev/null
	expect_rc "one error repeated three times fails" nonzero $?

	# bounded compose up: a command that outlives its bound is killed and reports 124; a quick one passes
	SECONDS=0
	run_bounded 1 sleep 30 >/dev/null 2>&1
	rc=$?
	expect_rc "a command that outlives its bound is killed (124)" nonzero "$rc"
	if [ "$rc" = 124 ]; then t_ok "...with exit 124 after about the bound, not the full run (${SECONDS}s)"; else t_bad "bounded run exit was $rc, wanted 124"; fi
	if [ "$SECONDS" -le 20 ]; then t_ok "...and it returned in ${SECONDS}s"; else t_bad "bounded run took ${SECONDS}s"; fi
	run_bounded 5 true >/dev/null 2>&1
	expect_rc "a quick command inside its bound passes" zero $?

	# discovery and public pages: planted wrong api_public and a 500 on /help must fail, a healthy stub must pass
	"$NODE" "$st/stub-server.mjs" --wrong-api-public >"$tmp/port-wrong" 2>/dev/null &
	ST_EXTRA_PIDS="$ST_EXTRA_PIDS $!"
	"$NODE" "$st/stub-server.mjs" --help-500 >"$tmp/port-help500" 2>/dev/null &
	ST_EXTRA_PIDS="$ST_EXTRA_PIDS $!"
	for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$tmp/port-wrong" ] && [ -s "$tmp/port-help500" ] && break; sleep 0.3; done
	local wrong_port help500_port
	wrong_port=$(cat "$tmp/port-wrong")
	help500_port=$(cat "$tmp/port-help500")
	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${port}" --scenarios "$GATE_HERE/scenarios" \
		--only 12-discovery --min-scenarios 1 --results "$tmp/r12a.json" >"$tmp/o12a" 2>&1
	expect_rc "discovery scenario passes on a healthy document" zero $?
	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${wrong_port}" --scenarios "$GATE_HERE/scenarios" \
		--only 12-discovery --min-scenarios 1 --results "$tmp/r12b.json" >"$tmp/o12b" 2>&1
	expect_rc "a planted wrong api_public fails the discovery scenario" nonzero $?
	if grep -q "api_public" "$tmp/o12b"; then t_ok "...and the failure names api_public"; else t_bad "the failure did not name api_public"; fi
	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${port}" --scenarios "$GATE_HERE/scenarios" \
		--only 13-public --min-scenarios 1 --results "$tmp/r13a.json" >"$tmp/o13a" 2>&1
	expect_rc "public pages scenario passes on healthy pages" zero $?
	"$NODE" "$GATE_HERE/run-scenarios.mjs" --base "http://127.0.0.1:${help500_port}" --scenarios "$GATE_HERE/scenarios" \
		--only 13-public --min-scenarios 1 --results "$tmp/r13b.json" >"$tmp/o13b" 2>&1
	expect_rc "a planted 500 on /help fails the public pages scenario" nonzero $?
	if grep -q "/help" "$tmp/o13b"; then t_ok "...and the failure names /help"; else t_bad "the failure did not name /help"; fi

	if [ "$bad" = 0 ]; then
		log "SELFTEST_PASS (${ok} checks)"
		return 0
	fi
	log "SELFTEST_FAIL (${bad} wrong verdicts, ${ok} right)"
	return 1
}
