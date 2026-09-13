// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: pure helpers for forum post lists and sidebar thread nesting, kept free of stores so
// the sorting, filtering and "N New" rules can be unit tested.

import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';

// Matches the wire values of default_sort_order.
export const ForumSortOrder = {
	LATEST_ACTIVITY: 0,
	CREATION_DATE: 1,
} as const;
export type ForumSortOrder = (typeof ForumSortOrder)[keyof typeof ForumSortOrder];

// Matches the wire values of default_forum_layout (0 means the forum has not chosen one).
export const ForumLayout = {
	NOT_SET: 0,
	LIST: 1,
	GALLERY: 2,
} as const;
export type ForumLayout = (typeof ForumLayout)[keyof typeof ForumLayout];

export interface ForumPostLike {
	readonly id: string;
	readonly name?: string;
	readonly ownerId: string | null;
	readonly parentId: string | null;
	readonly lastMessageId: string | null;
	readonly pinned: boolean;
	readonly appliedTags: ReadonlyArray<string>;
	readonly threadMetadata: {readonly archived: boolean; readonly locked: boolean} | null;
}

export function resolveForumSortOrder(value: number | null | undefined): ForumSortOrder {
	return value === ForumSortOrder.CREATION_DATE ? ForumSortOrder.CREATION_DATE : ForumSortOrder.LATEST_ACTIVITY;
}

export function resolveForumLayout(value: number | null | undefined): Exclude<ForumLayout, 0> {
	return value === ForumLayout.GALLERY ? ForumLayout.GALLERY : ForumLayout.LIST;
}

export function getForumPostCreatedAt(post: Pick<ForumPostLike, 'id'>): number {
	return SnowflakeUtils.extractTimestamp(post.id);
}

export function getForumPostLastActivityAt(post: Pick<ForumPostLike, 'id' | 'lastMessageId'>): number {
	const created = getForumPostCreatedAt(post);
	if (!post.lastMessageId) return created;
	return Math.max(created, SnowflakeUtils.extractTimestamp(post.lastMessageId));
}

// Pinned posts first, then newest by the chosen order. Ties fall back to id so the order is stable.
export function sortForumPosts<T extends ForumPostLike>(posts: ReadonlyArray<T>, order: ForumSortOrder): Array<T> {
	const key =
		order === ForumSortOrder.CREATION_DATE ? getForumPostCreatedAt : (post: T) => getForumPostLastActivityAt(post);
	return [...posts].sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		const diff = key(b) - key(a);
		if (diff !== 0) return diff;
		return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
	});
}

export interface ForumPostFilter {
	readonly archived: boolean;
	readonly query?: string;
	readonly tagIds?: ReadonlySet<string>;
}

// Selected tags NARROW the list: a post must carry every selected tag.
export function postHasAllTags(post: Pick<ForumPostLike, 'appliedTags'>, tagIds: ReadonlySet<string>): boolean {
	for (const tagId of tagIds) {
		if (!post.appliedTags.includes(tagId)) return false;
	}
	return true;
}

export function filterForumPosts<T extends ForumPostLike>(posts: ReadonlyArray<T>, filter: ForumPostFilter): Array<T> {
	const query = filter.query?.trim().toLowerCase() ?? '';
	return posts.filter((post) => {
		const archived = post.threadMetadata?.archived === true;
		if (archived !== filter.archived) return false;
		if (query && !(post.name ?? '').toLowerCase().includes(query)) return false;
		if (filter.tagIds && filter.tagIds.size > 0 && !postHasAllTags(post, filter.tagIds)) return false;
		return true;
	});
}

// Posts created since the user last viewed the forum, excluding their own and archived posts.
// A forum that has never been viewed on this device reports 0 rather than every post.
export function countNewForumPosts(
	posts: ReadonlyArray<ForumPostLike>,
	options: {lastViewedAt: number | null | undefined; currentUserId: string | null},
): number {
	const {lastViewedAt, currentUserId} = options;
	if (lastViewedAt == null) return 0;
	let count = 0;
	for (const post of posts) {
		if (post.threadMetadata?.archived) continue;
		if (currentUserId != null && post.ownerId === currentUserId) continue;
		if (getForumPostCreatedAt(post) > lastViewedAt) count++;
	}
	return count;
}

export interface SidebarThreadOptions {
	readonly parentId: string;
	readonly currentUserId: string | null;
	readonly selectedChannelId: string | null;
	readonly isMember: (threadId: string) => boolean;
}

// Threads shown nested under a channel in the sidebar: active threads the user belongs to (joined,
// or created by them) plus whichever thread is open. Most recent activity first.
export function selectSidebarThreads<T extends ForumPostLike>(
	threads: ReadonlyArray<T>,
	options: SidebarThreadOptions,
): Array<T> {
	const {parentId, currentUserId, selectedChannelId, isMember} = options;
	const visible = threads.filter((thread) => {
		if (thread.parentId !== parentId) return false;
		const selected = selectedChannelId != null && thread.id === selectedChannelId;
		if (selected) return true;
		if (thread.threadMetadata?.archived) return false;
		return isMember(thread.id) || (currentUserId != null && thread.ownerId === currentUserId);
	});
	return visible.sort((a, b) => getForumPostLastActivityAt(b) - getForumPostLastActivityAt(a));
}
