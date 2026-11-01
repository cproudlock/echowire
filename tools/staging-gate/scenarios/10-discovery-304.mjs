// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'discovery document answers a conditional request with 304';

export async function run(ctx) {
	const first = await ctx.http('GET', '/.well-known/fluxer');
	checkStatus(first, 200, 'GET /.well-known/fluxer');
	const etag = first.headers.get('etag');
	const modified = first.headers.get('last-modified');
	check(etag || modified, 'the discovery document carries neither an ETag nor a Last-Modified validator');
	const headers = etag ? {'if-none-match': etag} : {'if-modified-since': modified};
	const second = await ctx.http('GET', '/.well-known/fluxer', {headers});
	checkStatus(second, 304, 'conditional GET /.well-known/fluxer');
	return `304 for ${etag ? 'If-None-Match' : 'If-Modified-Since'}`;
}
