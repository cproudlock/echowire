// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {check} from '../lib/ctx.mjs';
import {loadAllowlist, scanLines} from '../lib/logscan.mjs';

export const name = 'no error lines in the service logs (allowlist: allowlist-logs.txt)';

const SERVICES = ['api', 'worker', 'gateway', 'users', 'messages', 'media-proxy', 'admin', 'snowflakes', 'push'];
const here = path.dirname(fileURLToPath(import.meta.url));

export function run(ctx) {
	const allow = loadAllowlist(path.join(here, '..', 'allowlist-logs.txt'));
	const problems = [];
	let total = 0;
	for (const service of SERVICES) {
		const logs = ctx.compose(['logs', '--no-color', '--no-log-prefix', service]);
		const lines = logs.split('\n');
		total += lines.length;
		const hits = scanLines(lines, allow);
		if (hits.length > 0) problems.push(`${service} (${hits.length}): ${hits[0]}`);
	}
	check(total > 100, `only ${total} log lines read: the logs did not load`);
	check(problems.length === 0, `error lines in logs: ${problems.join(' | ')}`);
	return `${total} log lines from ${SERVICES.length} services, no unexpected errors`;
}
