// SPDX-License-Identifier: AGPL-3.0-or-later

import {check} from '../lib/ctx.mjs';

export const name = 'gateway accepts a session and sends READY';

export async function run(ctx) {
	check(ctx.state.userA?.token, 'no logged-in user from scenario 03');
	await ctx.gatewayReady(ctx.state.userA.token);
	return 'READY received';
}
