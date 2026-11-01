// SPDX-License-Identifier: AGPL-3.0-or-later

import net from 'node:net';
import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'web app index and every asset it references load through the app proxy';

const ASSET_REF = /(?:\/|\.\/)?assets\/[A-Za-z0-9._~@%+-]+\.[A-Za-z0-9]+/g;
const MAX_ASSETS = 4000;

function normalise(ref, from) {
	const clean = ref.replace(/^\.\//, '');
	if (clean.startsWith('/')) return clean;
	if (clean.startsWith('assets/')) return `/${clean}`;
	return new URL(clean, `http://x${from}`).pathname;
}

// Raw request: Node's fetch and URL would normalise `..` away before it reaches the proxy.
function rawStatus(host, port, requestPath) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, host, () => {
			socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
		});
		let data = '';
		socket.on('data', (chunk) => {
			data += chunk.toString('latin1');
		});
		socket.on('end', () => resolve(Number(data.split(' ')[1])));
		socket.on('error', reject);
		socket.setTimeout(10000, () => {
			socket.destroy();
			reject(new Error('raw request timed out'));
		});
	});
}

export async function run(ctx) {
	const index = await ctx.http('GET', '/');
	checkStatus(index, 200, 'GET /');
	check(/<div id="root"|<div id="app"|<script/i.test(index.text), 'the index page does not look like the web app');
	const seen = new Set();
	const queue = [];
	const add = (ref, from) => {
		const p = normalise(ref, from);
		if (!seen.has(p) && seen.size < MAX_ASSETS) {
			seen.add(p);
			queue.push(p);
		}
	};
	for (const m of index.text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
		if (m[1].startsWith('/') && !m[1].startsWith('//')) add(m[1], '/');
	}
	for (const m of index.text.matchAll(ASSET_REF)) add(m[0], '/');

	const failures = [];
	let fetched = 0;
	while (queue.length > 0) {
		const batch = queue.splice(0, 16);
		await Promise.all(
			batch.map(async (p) => {
				const res = await ctx
					.http('GET', p)
					.catch((error) => ({status: 0, text: String(error), buffer: Buffer.alloc(0), headers: new Headers()}));
				fetched++;
				if (res.status !== 200) {
					failures.push(`${res.status} ${p}`);
					return;
				}
				const type = res.headers.get('content-type') ?? '';
				if (/javascript|css/.test(type) || /\.(js|css)$/.test(p)) {
					for (const m of res.text.matchAll(ASSET_REF)) add(m[0], p);
				}
			}),
		);
	}
	check(
		failures.length === 0,
		`${failures.length} of ${fetched} assets did not load: ${failures.slice(0, 5).join('; ')}`,
	);
	check(fetched >= 20, `only ${fetched} assets found: the crawl probably missed the app`);

	for (const p of ['/manifest.json', '/favicon.ico', '/robots.txt', '/.well-known/fluxer']) {
		let res = await ctx.http('GET', p);
		for (let hop = 0; hop < 3 && [301, 302, 307, 308].includes(res.status); hop++) {
			res = await ctx.http('GET', new URL(res.headers.get('location') ?? '/', ctx.base).href);
		}
		checkStatus(res, 200, `GET ${p}`);
	}

	const url = new URL(ctx.base);
	for (const bad of ['/assets/../../etc/passwd', '/assets/%2e%2e/%2e%2e/etc/passwd']) {
		const status = await rawStatus(url.hostname, Number(url.port || 80), bad);
		check(status !== 200 && status !== 0, `path traversal ${bad} answered ${status}`);
	}
	return `${fetched} assets all 200, root files 200, traversal refused`;
}
