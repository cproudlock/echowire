// SPDX-License-Identifier: AGPL-3.0-or-later

// Run the staging gate scenarios in order against a base URL and print one PASS/FAIL line each.
//   run-scenarios.mjs --base URL --scenarios DIR [--extra-dir DIR --changed-from REF --worktree PATH]
//     [--stage-dir DIR] [--only NAME[,NAME]] [--min-scenarios N] [--timeout MS] [--results FILE]
// Exits 1 on any FAIL, on a core scenario that skipped, or when fewer than --min-scenarios ran
// (an empty directory must never be a pass).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createContext, SkipError} from './lib/ctx.mjs';

function parseArgs(argv) {
	const out = {scenarios: []};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--scenarios') out.scenarios.push(argv[++i]);
		else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
	}
	return out;
}

function globToRegExp(glob) {
	const source = glob
		.split('**')
		.map((part) =>
			part
				.split('*')
				.map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
				.join('[^/]*'),
		)
		.join('.*');
	return new RegExp(`^${source}$`);
}

async function listModules(dir) {
	if (!dir || !fs.existsSync(dir)) return [];
	const files = fs
		.readdirSync(dir)
		.filter((f) => /^[0-9a-z][^/]*\.mjs$/.test(f))
		.sort();
	const modules = [];
	for (const file of files) {
		const mod = await import(pathToFileURL(path.resolve(dir, file)).href);
		modules.push({file: file.replace(/\.mjs$/, ''), mod});
	}
	return modules;
}

function changedFiles(worktree, ref) {
	const out = execFileSync('git', ['-C', worktree, 'diff', '--name-only', `${ref}...HEAD`], {encoding: 'utf8'});
	return out.split('\n').filter(Boolean);
}

async function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (${label})`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function pad(text, width) {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.base || args.scenarios.length === 0) {
		console.error('usage: run-scenarios.mjs --base URL --scenarios DIR [options]');
		process.exit(2);
	}
	const timeoutMs = Number(args.timeout ?? 120000);
	const minimum = Number(args['min-scenarios'] ?? 1);
	const only = args.only ? args.only.split(',') : null;

	let core = [];
	for (const dir of args.scenarios) core = core.concat(await listModules(dir));
	if (only) core = core.filter((s) => only.some((o) => s.file.includes(o)));

	let extras = [];
	let extraNote = 'extras: not selected (no --changed-from)';
	if (args['extra-dir'] && args['changed-from'] && args.worktree) {
		const changed = changedFiles(args.worktree, args['changed-from']);
		const all = await listModules(args['extra-dir']);
		extras = all.filter((s) => (s.mod.when ?? []).some((g) => changed.some((f) => globToRegExp(g).test(f))));
		extraNote = `extras: ${extras.length} of ${all.length} selected by ${changed.length} changed files`;
	}

	const ctx = createContext({base: args.base, stageDir: args['stage-dir'], worktree: args.worktree});
	const rows = [];
	const queue = [...core.map((s) => ({...s, extra: false})), ...extras.map((s) => ({...s, extra: true}))];
	// the log scan reads everything the other scenarios caused, so it always runs last
	queue.sort((a, b) => Number(a.file.startsWith('99-')) - Number(b.file.startsWith('99-')));

	for (const item of queue) {
		const started = Date.now();
		const row = {name: item.mod.name ?? item.file, file: item.file, extra: item.extra};
		try {
			const detail = await withTimeout(Promise.resolve(item.mod.run(ctx)), timeoutMs, item.file);
			row.status = 'PASS';
			row.detail = typeof detail === 'string' ? detail : '';
		} catch (error) {
			if (error instanceof SkipError && item.extra) {
				row.status = 'SKIP';
				row.detail = error.message;
			} else {
				row.status = 'FAIL';
				row.detail =
					error instanceof SkipError ? `core scenario cannot skip: ${error.message}` : String(error?.message ?? error);
			}
		}
		row.ms = Date.now() - started;
		rows.push(row);
		console.log(
			`${pad(row.status, 5)} ${pad(row.file, 28)} ${pad(`${row.ms}ms`, 8)} ${row.detail.split('\n')[0].slice(0, 150)}`,
		);
	}

	const counts = {PASS: 0, FAIL: 0, SKIP: 0};
	for (const row of rows) counts[row.status]++;
	const ran = counts.PASS + counts.FAIL;
	let ok = counts.FAIL === 0;
	if (ran < minimum) {
		console.log(`FAIL only ${ran} scenarios ran, at least ${minimum} are required (empty or wrong directory?)`);
		ok = false;
	}
	console.log(`scenarios: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip; ${extraNote}`);
	if (args.results) {
		const summary = {base: args.base, finished: new Date().toISOString(), minimum, counts, extraNote, scenarios: rows};
		fs.writeFileSync(args.results, `${JSON.stringify(summary, null, '\t')}\n`);
	}
	process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`FAIL runner crashed: ${error?.stack ?? error}`);
		process.exit(1);
	});
}
