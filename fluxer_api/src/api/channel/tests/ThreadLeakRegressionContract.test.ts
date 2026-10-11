// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: port of the September thread visibility contract test. The api and the gateway each decide
// who may see a thread, in TypeScript and in Erlang. Upstream now runs both through one shared table,
// packages/constants/src/ThreadPermissionCases.json (guild_thread_permissions.erl reads it directly), so the
// old byte-identical-copies check is gone. This test keeps the other half: the cases that stop a private
// thread from leaking must exist in that table.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const API_SIDE = join(REPO_ROOT, 'packages/constants/src/ThreadPermissionCases.json');

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
