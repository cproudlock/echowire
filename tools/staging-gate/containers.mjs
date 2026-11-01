// SPDX-License-Identifier: AGPL-3.0-or-later

// Compare the services a compose file declares with the containers that are running.
//   containers.mjs --ps ps.json --config compose-config.json [--json out.json] [--quiet]
// ps.json is `docker compose ps -a --format json` (one object per line, or an array); the config is
// `docker compose config --format json`. Exit 0 only when every declared service is accounted for:
// running (and healthy when it has a healthcheck), or a one-shot (restart: "no") that exited 0.
import fs from 'node:fs';

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--quiet') out.quiet = true;
		else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
	}
	return out;
}

function readPs(file) {
	const text = fs.readFileSync(file, 'utf8').trim();
	if (!text) return [];
	if (text.startsWith('[')) return JSON.parse(text);
	return text
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function evaluate(ps, config) {
	const services = config.services ?? {};
	const rows = [];
	for (const [name, def] of Object.entries(services)) {
		const oneShot = def.restart === 'no';
		const hasHealthcheck = Boolean(def.healthcheck) && def.healthcheck.disable !== true;
		const found = ps.filter((c) => c.Service === name);
		if (found.length === 0) {
			rows.push({service: name, ok: false, state: 'missing', detail: 'no container'});
			continue;
		}
		const bad = [];
		for (const c of found) {
			const state = c.State ?? '';
			const health = c.Health ?? '';
			if (oneShot) {
				if (state === 'exited' && Number(c.ExitCode) === 0) continue;
				bad.push(`${state}${state === 'exited' ? ` exit ${c.ExitCode}` : ''}`);
			} else if (state !== 'running') {
				bad.push(state || 'unknown');
			} else if (hasHealthcheck && health !== 'healthy') {
				bad.push(health || 'no health yet');
			} else if (!hasHealthcheck && health === 'unhealthy') {
				bad.push('unhealthy');
			}
		}
		rows.push({
			service: name,
			ok: bad.length === 0,
			state: bad.length === 0 ? (oneShot ? 'completed' : 'up') : bad.join(','),
			detail: oneShot ? 'one-shot' : hasHealthcheck ? 'healthcheck' : 'no healthcheck',
		});
	}
	const expected = Object.keys(services).length;
	const okCount = rows.filter((r) => r.ok).length;
	return {expected, ok: okCount, problems: rows.filter((r) => !r.ok), rows};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = parseArgs(process.argv.slice(2));
	if (!args.ps || !args.config) {
		console.error('usage: containers.mjs --ps FILE --config FILE [--json FILE] [--quiet]');
		process.exit(2);
	}
	const result = evaluate(readPs(args.ps), JSON.parse(fs.readFileSync(args.config, 'utf8')));
	if (result.expected === 0) {
		console.error('containers: the compose config declares no services');
		process.exit(1);
	}
	if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(result, null, '\t')}\n`);
	if (!args.quiet) {
		console.log(`containers: ${result.ok}/${result.expected} services up`);
		for (const r of result.problems) console.log(`  NOT OK  ${r.service}: ${r.state} (${r.detail})`);
	}
	process.exit(result.ok === result.expected ? 0 : 1);
}
