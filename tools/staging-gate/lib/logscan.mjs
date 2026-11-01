// SPDX-License-Identifier: AGPL-3.0-or-later

// Find error lines in container logs, minus a short allowlist of known harmless noise.
import fs from 'node:fs';

const ERROR_PATTERNS = [
	/\b(ERROR|FATAL|CRITICAL|PANIC)\b/,
	/\bpanicked\b/,
	/Traceback \(most recent call last\)/,
	/UnhandledPromiseRejection/,
	/"level":\s*(50|60)\b/,
	/"level":\s*"(error|fatal)"/i,
];

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

export function scanLines(lines, allow) {
	const hits = [];
	for (const line of lines) {
		if (!ERROR_PATTERNS.some((re) => re.test(line))) continue;
		if (allow.some((re) => re.test(line))) continue;
		hits.push(redact(line));
	}
	return hits;
}
