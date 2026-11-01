// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'admin pages load (login screen reachable, no server error)';

export async function run(ctx) {
	const landing = await ctx.http('GET', '/admin/');
	checkStatus(landing, [200, 301, 302, 303, 307, 308], 'GET /admin/');
	let page = landing;
	let hops = 0;
	while ([301, 302, 303, 307, 308].includes(page.status) && hops < 4) {
		const location = page.headers.get('location');
		check(location, 'admin redirect without a Location header');
		page = await ctx.http('GET', new URL(location, ctx.base).href);
		hops++;
	}
	checkStatus(page, 200, 'admin page after redirects');
	check(/<form|<html/i.test(page.text), 'the admin page is not an HTML page');
	check(!/internal server error|stack trace/i.test(page.text), 'the admin page shows a server error');
	const style = page.text.match(/href=["']([^"']*\.css[^"']*)["']/);
	if (style)
		checkStatus(await ctx.http('GET', new URL(style[1], new URL('/admin/', ctx.base)).href), 200, 'admin stylesheet');
	return `${hops} redirect(s), login page 200`;
}
