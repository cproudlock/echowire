// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'claimed account works; login refuses bad credentials and username logins';

// The staging claim writes the email into the user row only, not into the email lookup index, so a real
// login by email cannot succeed here. The registration token is the session; login is checked as a refusal.
export async function run(ctx) {
	const user = ctx.state.userA;
	check(user, 'scenario 02 did not leave a registered user');
	ctx.claim(user);
	await ctx.sleep(1500);
	const me = await ctx.call('GET', '/users/@me', user.token);
	checkStatus(me, 200, 'GET /users/@me after the claim');
	user.id = me.json?.id;
	check(user.id, '/users/@me returned no id');

	const wrong = await ctx.withCaptcha('/auth/login', {
		login: `nobody${Date.now() % 100000}@example.com`,
		password: 'Wrong-pass-1A!',
	});
	checkStatus(wrong, 400, 'login with unknown credentials');
	const byName = await ctx.withCaptcha('/auth/login', {login: user.username, password: user.password});
	checkStatus(byName, 400, 'login by username');
	check(
		JSON.stringify(byName.json).includes('INVALID_EMAIL_FORMAT'),
		'login by username was not refused as INVALID_EMAIL_FORMAT: has the instance left email-identity mode?',
	);
	return `claimed ${user.username}; bad logins refused with 400`;
}
