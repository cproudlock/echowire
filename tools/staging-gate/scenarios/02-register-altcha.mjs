// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'registration is behind ALTCHA and works with a solved challenge';

export async function run(ctx) {
	ctx.flushCache();
	const body = {
		username: ctx.randomName('nocap'),
		password: `Gate-pass-${Math.random().toString(36).slice(2)}A1!`,
		global_name: 'No Captcha',
		date_of_birth: '1990-01-01',
		consent: true,
	};
	const bare = await ctx.call('POST', '/auth/register', null, body);
	check(
		bare.status === 400 && bare.json?.altcha_challenge,
		`register without a captcha was not challenged (HTTP ${bare.status})`,
	);

	const user = await ctx.register('gate');
	checkStatus(await ctx.call('GET', '/users/@me', user.token), 200, 'GET /users/@me with the registration token');
	ctx.state.userA = user;
	return `registered ${user.username}`;
}
