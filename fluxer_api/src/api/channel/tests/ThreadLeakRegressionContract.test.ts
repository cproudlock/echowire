// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: port of the September thread visibility contract test. The api and the gateway each
// decide who may see a thread, in TypeScript and in Erlang. Upstream shares one case table between
// them: packages/constants/src/ThreadPermissionCases.json is run through ThreadPermissionUtils by
// ThreadPermissionUtils.test.ts, and fluxer_gateway/test/thread_permission_cases.json is run
// through guild_thread_permissions.erl by its eunit section. Those are two separate files, so
// nothing stops one from changing without the other. This test closes that gap: the copies must be
// byte-identical, and the cases that guard against a private thread leaking must exist in them.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const API_SIDE = join(REPO_ROOT, 'packages/constants/src/ThreadPermissionCases.json');
const GATEWAY_SIDE = join(REPO_ROOT, 'fluxer_gateway/test/thread_permission_cases.json');

interface Case {
	name: string;
	fn: string;
	expect: unknown;
}

const cases = JSON.parse(readFileSync(API_SIDE, 'utf8')) as Array<Case>;

function expectation(name: string): unknown {
	const found = cases.find((entry) => entry.name === name);
	if (!found) throw new Error(`thread permission case table lost the leak guard: ${name}`);
	return found.expect;
}

describe('thread visibility contract between the api and the gateway', () => {
	it('keeps one case table for both implementations', () => {
		expect(readFileSync(GATEWAY_SIDE, 'utf8')).toBe(readFileSync(API_SIDE, 'utf8'));
	});

	it('keeps the cases that stop a private thread from leaking', () => {
		const hidden = 'MISSING_ACCESS';
		expect(expectation('private thread hidden from non-members')).toBe(hidden);
		expect(expectation('private thread hidden from timed out moderators')).toBe(hidden);
		expect(expectation('private thread member without parent view')).toBe(hidden);
		expect(expectation('public thread without parent view')).toBe(hidden);
		expect(expectation('announcement thread hidden without parent view')).toBe(hidden);
		expect(expectation('add a target without parent view')).toBe(hidden);
		expect(expectation('join without parent view')).toBe(hidden);
		expect(expectation('create without parent view')).toBe(hidden);
	});

	it('still lets the members and moderators the leak guards exempt through', () => {
		expect(expectation('private thread visible to members')).toBeNull();
		expect(expectation('private thread visible to moderators')).toBeNull();
		expect(expectation('private thread visible to administrators')).toBeNull();
	});
});
