// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'edge, API health and the discovery document';

export async function run(ctx) {
	const edge = await ctx.http('GET', '/_health');
	checkStatus(edge, 200, 'edge /_health');
	const health = await ctx.http('GET', '/api/v1/_health');
	checkStatus(health, 200, 'api /_health');
	const doc = await ctx.http('GET', '/.well-known/fluxer');
	checkStatus(doc, 200, 'discovery document');
	check(doc.json?.endpoints?.api, 'discovery document has no endpoints.api');
	check(doc.json?.endpoints?.gateway, 'discovery document has no endpoints.gateway');
	ctx.state.discovery = doc.json;
	return `captcha provider ${doc.json?.captcha?.provider ?? 'none'}`;
}
