// SPDX-License-Identifier: AGPL-3.0-or-later

import {checkStatus} from '../../lib/ctx.mjs';

export const name = 'control scenario (must PASS against the stub server)';

export async function run(ctx) {
	checkStatus(await ctx.http('GET', '/_health'), 200, 'stub /_health');
	return 'stub answered';
}
