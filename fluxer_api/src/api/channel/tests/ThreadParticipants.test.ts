// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the rolling window of recent thread authors that forum cards render as participant
// avatars. See docs/forums2-contract.md.

import {createUserID} from '@app/api/BrandedTypes';
import {nextRecentParticipants} from '@app/api/channel/services/ThreadParticipants';
import {describe, expect, test} from 'vitest';

const alice = createUserID(1n);
const bob = createUserID(2n);
const carol = createUserID(3n);

describe('nextRecentParticipants', () => {
	test('starts the window with the first author', () => {
		expect(nextRecentParticipants(null, alice)).toEqual(['1']);
		expect(nextRecentParticipants([], alice)).toEqual(['1']);
	});

	test('writes nothing when the author already leads the window', () => {
		expect(nextRecentParticipants(['1', '2'], alice)).toBeNull();
	});

	test('moves a returning author back to the front without duplicating them', () => {
		expect(nextRecentParticipants(['2', '1'], alice)).toEqual(['1', '2']);
		expect(nextRecentParticipants(['2', '3', '1'], alice)).toEqual(['1', '2', '3']);
	});

	test('keeps newest first and drops the oldest past the cap', () => {
		expect(nextRecentParticipants(['2', '3'], alice, 2)).toEqual(['1', '2']);
		expect(nextRecentParticipants(['1', '2', '3'], carol, 2)).toEqual(['3', '1']);
	});

	test('a second author joins the front', () => {
		expect(nextRecentParticipants(['1'], bob)).toEqual(['2', '1']);
	});
});
