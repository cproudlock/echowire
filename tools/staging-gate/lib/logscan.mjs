// SPDX-License-Identifier: AGPL-3.0-or-later

// Find error lines in container logs, minus a short allowlist of known harmless noise.
//
// Two severities (2026-11-03, after the fire-drill):
//   FATAL class (FATAL, CRITICAL, PANIC, panicked, Traceback, unhandled rejection, level 60): always a failure.
//   ERROR class (ERROR, level 50): a failure only if it KEEPS HAPPENING. A startup race such as the worker
//   asking a snowflake shard that is not up yet logs one error and recovers; that must not fail a gate, but it must
//   not be hidden either (no allowlist): scenario 99 reads the logs, waits ~15 s, reads only what was logged since,
//   and fails if error lines are still arriving or one message repeats.
import fs from 'node:fs';

const FATAL_PATTERNS = [
	/\b(FATAL|CRITICAL|PANIC)\b/,
	/\bpanicked\b/,
	/Traceback \(most recent call last\)/,
	/UnhandledPromiseRejection/,
	/"level":\s*60\b/,
	/"level":\s*"fatal"/i,
];
const ERROR_PATTERNS = [/\bERROR\b/, /"level":\s*50\b/, /"level":\s*"error"/i];
const REPEAT_LIMIT = 3;

export function loadAllowlist(file) {
	if (!file || !fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
		.map((line) => new RegExp(line));
}

export function redact(line) {
	return line.replace(/[A-Za-z0-9+/_=-]{32,}/g, '<redacted>').slice(0, 240);
}

// Every non-allowlisted error-looking line, either severity (the strict, original behaviour).
export function scanLines(lines, allow) {
	const hits = [];
	for (const line of lines) {
		if (!FATAL_PATTERNS.some((re) => re.test(line)) && !ERROR_PATTERNS.some((re) => re.test(line))) continue;
		if (allow.some((re) => re.test(line))) continue;
		hits.push(redact(line));
	}
	return hits;
}

// Split the error-looking lines by severity. FATAL wins when a line matches both.
export function classifyLines(lines, allow) {
	const fatal = [];
	const error = [];
	for (const line of lines) {
		const isFatal = FATAL_PATTERNS.some((re) => re.test(line));
		const isError = ERROR_PATTERNS.some((re) => re.test(line));
		if (!isFatal && !isError) continue;
		if (allow.some((re) => re.test(line))) continue;
		(isFatal ? fatal : error).push(redact(line));
	}
	return {fatal, error};
}

// A key for "the same message": timestamps and long numbers removed, so a retry loop counts as one message.
export function messageKey(line) {
	return line
		.replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '')
		.replace(/\d{5,}/g, 'N')
		.trim();
}

// Decide from the first full scan and (optionally) the scan of what was logged since. `later` null means no
// second look is available: any error line fails (strict).
export function decideScan(first, later) {
	if (first.fatal.length > 0)
		return {ok: false, reason: `fatal-class lines (${first.fatal.length}): ${first.fatal[0]}`, transient: []};
	if (first.error.length === 0 && (later === null || (later.fatal.length === 0 && later.error.length === 0))) {
		return {ok: true, reason: 'no error lines', transient: []};
	}
	if (later === null)
		return {ok: false, reason: `error lines (${first.error.length}): ${first.error[0]}`, transient: []};
	if (later.fatal.length > 0)
		return {ok: false, reason: `fatal-class lines logged during the re-scan: ${later.fatal[0]}`, transient: []};
	if (later.error.length > 0) {
		return {
			ok: false,
			reason: `error lines are still being logged (${later.error.length} in the re-scan window): ${later.error[0]}`,
			transient: [],
		};
	}
	const counts = new Map();
	for (const line of first.error) counts.set(messageKey(line), (counts.get(messageKey(line)) ?? 0) + 1);
	for (const [key, n] of counts) {
		if (n >= REPEAT_LIMIT)
			return {ok: false, reason: `one error repeated ${n} times: ${key.slice(0, 200)}`, transient: []};
	}
	return {
		ok: true,
		reason: `${first.error.length} transient error line(s), none after the re-scan`,
		transient: first.error,
	};
}
