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
	_selftest_body "$tmp"
	rc=$?
	[ -n "$ST_STUB_PID" ] && kill "$ST_STUB_PID" 2>/dev/null
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

	if [ "$bad" = 0 ]; then
		log "SELFTEST_PASS (${ok} checks)"
		return 0
	fi
	log "SELFTEST_FAIL (${bad} wrong verdicts, ${ok} right)"
	return 1
}
