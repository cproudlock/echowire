// SPDX-License-Identifier: AGPL-3.0-or-later

import {countNewForumPosts} from '@app/features/forum/utils/ForumNewPostCount';
import {describe, expect, it} from 'vitest';

describe('countNewForumPosts', () => {
	const post = (id: string, ownerId: string | null = 'other', archived = false) => ({id, ownerId, archived});

	it('counts open posts newer than the ack from other people', () => {
		expect(countNewForumPosts([post('200'), post('300'), post('100')], '150', 'me')).toBe(2);
	});

	it('skips the viewer own posts', () => {
		expect(countNewForumPosts([post('200', 'me'), post('300')], '150', 'me')).toBe(1);
	});

	it('skips closed posts', () => {
		expect(countNewForumPosts([post('200', 'other', true), post('300')], '150', 'me')).toBe(1);
	});

	it('counts posts with no known owner', () => {
		expect(countNewForumPosts([post('200', null)], '150', 'me')).toBe(1);
	});

	it('is zero for an empty forum or an ack at the newest post', () => {
		expect(countNewForumPosts([], '150', 'me')).toBe(0);
		expect(countNewForumPosts([post('150')], '150', 'me')).toBe(0);
	});

	it('compares ids numerically, not as strings', () => {
		expect(countNewForumPosts([post('1000')], '999', 'me')).toBe(1);
	});
});
