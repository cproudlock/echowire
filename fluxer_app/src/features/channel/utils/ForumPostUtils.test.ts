// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ForumPostLike,
	ForumLayout,
	ForumSortOrder,
	countNewForumPosts,
	filterForumPosts,
	resolveForumLayout,
	resolveForumSortOrder,
	selectSidebarThreads,
	sortForumPosts,
} from '@app/features/channel/utils/ForumPostUtils';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';
import {describe, expect, it} from 'vitest';

const T0 = Date.UTC(2026, 8, 1);
const MINUTE = 60_000;

function idAt(ms: number): string {
	return SnowflakeUtils.fromTimestamp(ms);
}

function post(overrides: Partial<ForumPostLike> & {createdAt: number; lastActivityAt?: number}): ForumPostLike {
	const {createdAt, lastActivityAt, ...rest} = overrides;
	return {
		id: idAt(createdAt),
		name: 'post',
		ownerId: 'u1',
		parentId: 'forum',
		lastMessageId: lastActivityAt != null ? idAt(lastActivityAt) : null,
		pinned: false,
		appliedTags: [],
		threadMetadata: {archived: false, locked: false},
		...rest,
	};
}

describe('resolveForumSortOrder and resolveForumLayout', () => {
	it('defaults to latest activity and list', () => {
		expect(resolveForumSortOrder(null)).toBe(ForumSortOrder.LATEST_ACTIVITY);
		expect(resolveForumSortOrder(1)).toBe(ForumSortOrder.CREATION_DATE);
		expect(resolveForumLayout(undefined)).toBe(ForumLayout.LIST);
		expect(resolveForumLayout(0)).toBe(ForumLayout.LIST);
		expect(resolveForumLayout(2)).toBe(ForumLayout.GALLERY);
	});
});

describe('sortForumPosts', () => {
	const old = post({name: 'old but busy', createdAt: T0, lastActivityAt: T0 + 50 * MINUTE});
	const recent = post({name: 'recent but quiet', createdAt: T0 + 10 * MINUTE});
	const pinned = post({name: 'pinned', createdAt: T0 - 60 * MINUTE, pinned: true});

	it('orders by last activity by default, pinned first', () => {
		const sorted = sortForumPosts([recent, old, pinned], ForumSortOrder.LATEST_ACTIVITY);
		expect(sorted.map((p) => p.name)).toEqual(['pinned', 'old but busy', 'recent but quiet']);
	});

	it('orders by creation date when asked, pinned first', () => {
		const sorted = sortForumPosts([old, pinned, recent], ForumSortOrder.CREATION_DATE);
		expect(sorted.map((p) => p.name)).toEqual(['pinned', 'recent but quiet', 'old but busy']);
	});
});

describe('filterForumPosts', () => {
	const both = post({name: 'Datto variables', createdAt: T0, appliedTags: ['help', 'datto']});
	const helpOnly = post({name: 'Moving tenants', createdAt: T0 + MINUTE, appliedTags: ['help']});
	const archived = post({
		name: 'Old help',
		createdAt: T0 + 2 * MINUTE,
		appliedTags: ['help', 'datto'],
		threadMetadata: {archived: true, locked: false},
	});

	it('narrows with every selected tag (AND)', () => {
		const result = filterForumPosts([both, helpOnly, archived], {archived: false, tagIds: new Set(['help', 'datto'])});
		expect(result.map((p) => p.name)).toEqual(['Datto variables']);
	});

	it('matches the title case-insensitively and separates archived posts', () => {
		expect(filterForumPosts([both, helpOnly, archived], {archived: false, query: 'TENANT'}).map((p) => p.name)).toEqual([
			'Moving tenants',
		]);
		expect(filterForumPosts([both, helpOnly, archived], {archived: true}).map((p) => p.name)).toEqual(['Old help']);
	});
});

describe('countNewForumPosts', () => {
	const seenAt = T0 + 5 * MINUTE;
	const before = post({createdAt: T0, ownerId: 'u2'});
	const after = post({createdAt: T0 + 10 * MINUTE, ownerId: 'u2'});
	const mine = post({createdAt: T0 + 11 * MINUTE, ownerId: 'me'});
	const archivedAfter = post({createdAt: T0 + 12 * MINUTE, ownerId: 'u2', threadMetadata: {archived: true, locked: false}});

	it('counts other people\'s active posts created after the last view', () => {
		expect(countNewForumPosts([before, after, mine, archivedAfter], {lastViewedAt: seenAt, currentUserId: 'me'})).toBe(
			1,
		);
	});

	it('reports nothing for a forum never viewed', () => {
		expect(countNewForumPosts([after], {lastViewedAt: null, currentUserId: 'me'})).toBe(0);
	});
});

describe('selectSidebarThreads', () => {
	const joined = post({name: 'joined', createdAt: T0, lastActivityAt: T0 + 30 * MINUTE});
	const owned = post({name: 'owned', createdAt: T0 + MINUTE, ownerId: 'me'});
	const stranger = post({name: 'stranger', createdAt: T0 + 2 * MINUTE, ownerId: 'u9'});
	const archivedJoined = post({
		name: 'archived joined',
		createdAt: T0 + 3 * MINUTE,
		threadMetadata: {archived: true, locked: false},
	});
	const otherParent = post({name: 'other parent', createdAt: T0 + 4 * MINUTE, parentId: 'elsewhere', ownerId: 'me'});
	const members = new Set([joined.id, archivedJoined.id]);

	it('nests joined and owned active threads under their parent, newest activity first', () => {
		const result = selectSidebarThreads([joined, owned, stranger, archivedJoined, otherParent], {
			parentId: 'forum',
			currentUserId: 'me',
			selectedChannelId: null,
			isMember: (id) => members.has(id),
		});
		expect(result.map((t) => t.name)).toEqual(['joined', 'owned']);
	});

	it('always includes the open thread, even when archived or not joined', () => {
		const result = selectSidebarThreads([stranger, archivedJoined], {
			parentId: 'forum',
			currentUserId: 'me',
			selectedChannelId: stranger.id,
			isMember: () => false,
		});
		expect(result.map((t) => t.name)).toEqual(['stranger']);
	});
});
