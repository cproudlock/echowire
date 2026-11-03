// SPDX-License-Identifier: AGPL-3.0-or-later

import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {check} from '../lib/ctx.mjs';

export const name = 'brand smoke: the public surfaces do not name the upstream product';

// tools/brand-smoke.sh is the same script the deploy runs against production afterwards. Running it here, against
// the staging stack, catches an upstream string that a sync brought in BEFORE the deploy. The expected product name
// is GATE_PRODUCT_NAME (default echowire).
export function run(ctx) {
	const script = path.join(ctx.worktree ?? '.', 'tools', 'brand-smoke.sh');
	const product = process.env.GATE_PRODUCT_NAME ?? 'echowire';
	let out = '';
	try {
		out = execFileSync('bash', [script, ctx.base, product], {
			encoding: 'utf8',
			timeout: 120000,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
		const failing = text.split('\n').filter((line) => line.startsWith('FAIL'));
		check(
			false,
			`brand-smoke failed (${failing.length} problem(s)): ${failing.slice(0, 3).join(' | ') || String(error.message).slice(0, 160)}`,
		);
	}
	const last = out.trim().split('\n').pop() ?? '';
	check(/clean on/.test(last), `brand-smoke did not report clean: ${last}`);
	return last;
}
