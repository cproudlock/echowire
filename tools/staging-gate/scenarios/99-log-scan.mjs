// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {check} from '../lib/ctx.mjs';
import {classifyLines, decideScan, loadAllowlist} from '../lib/logscan.mjs';

export const name = 'no error lines in the service logs (allowlist: allowlist-logs.txt; errors must not keep arriving)';

const SERVICES = ['api', 'worker', 'gateway', 'users', 'messages', 'media-proxy', 'admin', 'snowflakes', 'push'];
const here = path.dirname(fileURLToPath(import.meta.url));
const RESCAN_MS = Number(process.env.GATE_LOG_RESCAN_MS ?? 15000);

function readServices(ctx, since) {
	const lines = {};
	let total = 0;
	for (const service of SERVICES) {
		const args = ['logs', '--no-color', '--no-log-prefix'];
		if (since) args.push('--since', since);
		const text = ctx.compose([...args, service]);
		lines[service] = text.split('\n');
		total += lines[service].length;
	}
	return {lines, total};
}

function classifyAll(lines, allow) {
	const out = {fatal: [], error: []};
	for (const [service, serviceLines] of Object.entries(lines)) {
		const found = classifyLines(serviceLines, allow);
		for (const line of found.fatal) out.fatal.push(`${service}: ${line}`);
		for (const line of found.error) out.error.push(`${service}: ${line}`);
	}
	return out;
}

export async function run(ctx) {
	const allow = loadAllowlist(path.join(here, '..', 'allowlist-logs.txt'));
	const firstLook = new Date().toISOString();
	const {lines, total} = readServices(ctx, null);
	check(total > 100, `only ${total} log lines read: the logs did not load`);
	const first = classifyAll(lines, allow);
	if (first.fatal.length === 0 && first.error.length === 0) {
		return `${total} log lines from ${SERVICES.length} services, no unexpected errors`;
	}
	let later = {fatal: [], error: []};
	if (first.fatal.length === 0) {
		// error-class lines only: a startup race logs once and recovers; a real fault keeps logging.
		await ctx.sleep(RESCAN_MS);
		later = classifyAll(readServices(ctx, firstLook).lines, allow);
	}
	const verdict = decideScan(first, later);
	check(verdict.ok, `error lines in logs: ${verdict.reason}`);
	return `${total} log lines from ${SERVICES.length} services; ${verdict.reason}: ${verdict.transient.slice(0, 3).join(' | ')}`;
}
