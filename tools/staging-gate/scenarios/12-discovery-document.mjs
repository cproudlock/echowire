// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'discovery document points the clients at this instance and has the keys they rely on';

// The self-host stack serves the API on the same origin as the web app, so api, api_client and api_public must
// all be <origin>/api. A wrong api_public (a Fluxer-hosted or mistyped address) sends every client that reads it
// to the wrong place while the stack itself looks perfectly healthy.
export async function run(ctx) {
	const res = await ctx.http('GET', '/.well-known/fluxer');
	checkStatus(res, 200, 'GET /.well-known/fluxer');
	const doc = res.json;
	check(doc && typeof doc === 'object', 'the discovery document is not JSON');
	const expected = `${new URL(ctx.base).origin}/api`;
	const endpoints = doc.endpoints ?? {};
	for (const key of ['api', 'api_client', 'api_public']) {
		check(
			endpoints[key] === expected,
			`discovery endpoints.${key} is ${JSON.stringify(endpoints[key])}, expected ${expected}`,
		);
	}
	check(
		doc.age_policy && typeof doc.age_policy === 'object' && !Array.isArray(doc.age_policy),
		`discovery age_policy is ${JSON.stringify(doc.age_policy)}, expected an object`,
	);
	check(Array.isArray(doc.age_policy.geos), 'discovery age_policy.geos is not an array');
	check(
		Array.isArray(doc.voice_origins),
		`discovery voice_origins is ${JSON.stringify(doc.voice_origins)}, expected an array`,
	);
	check(
		doc.captcha && typeof doc.captcha === 'object',
		`discovery captcha is ${JSON.stringify(doc.captcha)}, expected an object`,
	);
	return `api, api_client and api_public are ${expected}; age_policy and voice_origins have the expected shape`;
}
