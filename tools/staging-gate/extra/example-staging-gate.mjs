// SPDX-License-Identifier: AGPL-3.0-or-later

import {checkStatus} from '../lib/ctx.mjs';

// Per-sync extra scenarios: list the changed paths that should trigger the check. The runner only
// loads extras when gate.sh gets --changed-from REF, and runs the ones whose globs match a changed file.
export const when = ['tools/staging-gate/**'];

export const name = 'example extra: runs when the staging gate itself changed';

export async function run(ctx) {
	checkStatus(await ctx.http('GET', '/_health'), 200, 'edge /_health');
	return 'edge healthy';
}
