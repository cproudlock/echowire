// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'marketing and docs pages answer through the edge (200 with a title, /partners is 404)';

// The marketing and docs services have no API traffic behind them, so nothing else in the gate touches them:
// a marketing or docs container that is up but answering 500 passed every other check. These are the public
// pages tools/brand-smoke.sh also looks at after a deploy.
const OK_PAGES = ['/help', '/download', '/press', '/reverb', '/docs/'];
const GONE_PAGES = ['/partners'];

function titleOf(html) {
	const match = html.replace(/\s+/g, ' ').match(/<title>([^<]*)<\/title>/i);
	return match ? match[1].trim() : '';
}

export async function run(ctx) {
	const problems = [];
	for (const page of OK_PAGES) {
		const res = await ctx.http('GET', page).catch((error) => ({status: 0, text: String(error)}));
		if (res.status !== 200) {
			problems.push(`${page}: HTTP ${res.status}`);
			continue;
		}
		if (titleOf(res.text) === '') problems.push(`${page}: 200 but no <title>`);
	}
	for (const page of GONE_PAGES) {
		const res = await ctx.http('GET', page).catch((error) => ({status: 0, text: String(error)}));
		if (res.status !== 404) problems.push(`${page}: HTTP ${res.status}, expected 404`);
	}
	check(problems.length === 0, `public pages wrong: ${problems.join('; ')}`);
	// /docs redirects to /docs/: a 301 here is the contract, a 200 or 404 means the route changed.
	const bare = await ctx.http('GET', '/docs');
	checkStatus(bare, [301, 302, 307, 308], 'GET /docs (should redirect to /docs/)');
	return `${OK_PAGES.length} pages 200 with a title, ${GONE_PAGES.join(', ')} 404, /docs redirects`;
}
