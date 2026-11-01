// SPDX-License-Identifier: AGPL-3.0-or-later

// Helpers handed to every scenario: HTTP with a timeout, ALTCHA solving, throwaway accounts, and the
// staging database. The scenarios only ever talk to the staging stack at ctx.base.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export class GateError extends Error {}
export class SkipError extends Error {}

export function check(condition, message) {
	if (!condition) throw new GateError(message);
}

export function checkStatus(res, expected, label) {
	const want = Array.isArray(expected) ? expected : [expected];
	if (!want.includes(res.status)) {
		throw new GateError(`${label}: HTTP ${res.status}, wanted ${want.join(' or ')}: ${res.text.slice(0, 200)}`);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadAltcha(dirs) {
	for (const dir of dirs) {
		const root = path.join(dir, 'node_modules', 'altcha-lib', 'dist', 'esm', 'v2');
		if (fs.existsSync(path.join(root, 'index.js'))) {
			const lib = await import(pathToFileURL(path.join(root, 'index.js')).href);
			const pbkdf2 = await import(pathToFileURL(path.join(root, 'algorithms', 'pbkdf2.js')).href);
			return {solveChallenge: lib.solveChallenge, deriveKey: pbkdf2.deriveKey};
		}
	}
	throw new GateError(`altcha-lib not found under: ${dirs.join(', ')} (run pnpm install, or set GATE_DEPS_DIR)`);
}

export function createContext({base, stageDir, worktree}) {
	const api = `${base}/api/v1`;
	const depsDirs = [
		process.env.GATE_DEPS_DIR,
		worktree && path.join(worktree, 'fluxer_api'),
		worktree,
		'/home/camp/dev/ew-sync1027/fluxer_api',
	].filter(Boolean);
	let altcha;

	const ctx = {
		base,
		api,
		stageDir,
		worktree,
		state: {},
		sleep,

		async http(method, urlPath, {headers = {}, body, redirect = 'manual', timeoutMs = 30000} = {}) {
			const init = {method, headers: {...headers}, redirect, signal: AbortSignal.timeout(timeoutMs)};
			if (body instanceof FormData || Buffer.isBuffer(body)) {
				init.body = body;
			} else if (body !== undefined) {
				init.body = JSON.stringify(body);
				init.headers['content-type'] = 'application/json';
			}
			const url = urlPath.startsWith('http') ? urlPath : `${base}${urlPath}`;
			const res = await fetch(url, init);
			const buffer = Buffer.from(await res.arrayBuffer());
			const text = buffer.toString('utf8');
			let json = null;
			try {
				json = JSON.parse(text);
			} catch {}
			return {status: res.status, headers: res.headers, buffer, text, json};
		},

		call(method, apiPath, token, body, extraHeaders = {}) {
			const headers = {'x-fluxer-features': 'channel_threads', ...extraHeaders};
			if (token) headers.authorization = token;
			return ctx.http(method, `/api/v1${apiPath}`, {headers, body});
		},

		async solveAltcha(challenge) {
			altcha ??= await loadAltcha(depsDirs);
			const solution = await altcha.solveChallenge({challenge, deriveKey: altcha.deriveKey, timeout: 0});
			const payload = {challenge: {parameters: challenge.parameters, signature: challenge.signature}, solution};
			return Buffer.from(JSON.stringify(payload)).toString('base64');
		},

		async withCaptcha(apiPath, body) {
			const first = await ctx.call('POST', apiPath, null, body);
			if (first.status !== 400 || !first.json?.altcha_challenge) return first;
			const token = await ctx.solveAltcha(first.json.altcha_challenge);
			return ctx.call('POST', apiPath, null, body, {'x-captcha-token': token, 'x-captcha-type': 'altcha'});
		},

		compose(args, input) {
			return execFileSync('docker', ['compose', ...args], {
				cwd: stageDir,
				input,
				encoding: 'utf8',
				timeout: 180000,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		},

		psql(sql) {
			return execFileSync(
				'docker',
				['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'fluxer', '-d', 'fluxer', '-At', '-F', '|'],
				{cwd: stageDir, input: sql, encoding: 'utf8', timeout: 60000},
			).trim();
		},

		flushCache() {
			ctx.compose(['exec', '-T', 'valkey', 'valkey-cli', 'FLUSHALL']);
		},

		randomName(prefix) {
			return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
		},

		async register(prefix) {
			ctx.flushCache();
			const username = ctx.randomName(prefix);
			const password = `Gate-pass-${Math.random().toString(36).slice(2)}A1!`;
			const res = await ctx.withCaptcha('/auth/register', {
				username,
				password,
				global_name: username,
				date_of_birth: '1990-01-01',
				consent: true,
			});
			checkStatus(res, 200, `register ${username}`);
			check(res.json?.token, `register ${username}: no token in the response`);
			return {username, password, email: `${username}@example.com`, token: res.json.token, userId: res.json.user_id};
		},

		// Staging has email off, so a new account stays "unclaimed" (it cannot create a guild). The only way to
		// give it an email is the database. This shortcut is staging-only and is asserted to touch one row.
		claim(user) {
			const sql = `update fluxer_kv set row_data = row_data || '{"email":"${user.email}","email_verified":true}'::jsonb where table_name='users' and row_data->>'username'='${user.username}'`;
			const out = ctx.psql(sql);
			check(out === 'UPDATE 1', `claim ${user.username}: expected UPDATE 1, got "${out}"`);
			ctx.flushCache();
		},

		async newClaimedUser(prefix) {
			const user = await ctx.register(prefix);
			ctx.claim(user);
			await sleep(1500);
			return user;
		},

		gatewayReady(token, timeoutMs = 20000) {
			return new Promise((resolve, reject) => {
				const wsUrl = `${base.replace(/^http/, 'ws')}/gateway?v=1&encoding=json`;
				const ws = new WebSocket(wsUrl);
				let seq = null;
				let beat;
				const done = (error) => {
					clearTimeout(timer);
					clearInterval(beat);
					try {
						ws.close();
					} catch {}
					if (error) reject(error);
					else resolve();
				};
				const timer = setTimeout(() => done(new GateError('gateway: no READY within the timeout')), timeoutMs);
				ws.onerror = () => done(new GateError('gateway: websocket error'));
				ws.onmessage = (event) => {
					const msg = JSON.parse(event.data);
					if (msg.s != null) seq = msg.s;
					if (msg.op === 10) {
						ws.send(
							JSON.stringify({
								op: 2,
								d: {token, properties: {os: 'linux', browser: 'gate', device: 'gate'}, intents: 0, flags: 0},
							}),
						);
						beat = setInterval(() => ws.send(JSON.stringify({op: 1, d: seq})), msg.d.heartbeat_interval);
					}
					if (msg.t === 'READY') done();
					if (msg.op === 9) done(new GateError('gateway: invalid session'));
				};
			});
		},
	};
	return ctx;
}
