// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	canAddToPost,
	canSelectForumTag,
	ForumPaneMode,
	isOriginalPoster,
	resolveForumPaneState,
	selectableForumTags,
	supportsModeratedTags,
} from '@app/features/channel/utils/ForumPaneUtils';
import {describe, expect, test} from 'vitest';

interface FakeChannel {
	id: string;
	parentId: string | null;
	type: 'forum' | 'thread' | 'text';
	isThread: () => boolean;
	isForum: () => boolean;
}

function channel(id: string, type: FakeChannel['type'], parentId: string | null = null): FakeChannel {
	return {
		id,
		parentId,
		type,
		isThread: () => type === 'thread',
		isForum: () => type === 'forum',
	};
}

function lookup(...channels: Array<FakeChannel>) {
	const byId = new Map(channels.map((c) => [c.id, c]));
	return (id: string) => byId.get(id) ?? null;
}

describe('resolveForumPaneState', () => {
	const forum = channel('forum-1', 'forum');
	const post = channel('post-1', 'thread', 'forum-1');
	const getChannel = lookup(forum, post);

	test('a forum selection shows its list with no post open', () => {
		const state = resolveForumPaneState({selected: forum, getChannel});
		expect(state).toEqual({mode: ForumPaneMode.LIST, forum, post: null});
	});

	test('a post selection keeps the list beside the post', () => {
		const state = resolveForumPaneState({selected: post, getChannel});
		expect(state.mode).toBe(ForumPaneMode.SPLIT);
		expect(state.forum).toBe(forum);
		expect(state.post).toBe(post);
	});

	test('full view hides the list', () => {
		expect(resolveForumPaneState({selected: post, getChannel, fullView: true}).mode).toBe(ForumPaneMode.FULL);
	});

	test('a narrow viewport shows one pane at a time', () => {
		expect(resolveForumPaneState({selected: post, getChannel, narrow: true}).mode).toBe(ForumPaneMode.FULL);
	});

	test('a thread under a text channel is not a forum view', () => {
		const text = channel('text-1', 'text');
		const thread = channel('thread-1', 'thread', 'text-1');
		const state = resolveForumPaneState({selected: thread, getChannel: lookup(text, thread)});
		expect(state).toEqual({mode: ForumPaneMode.LIST, forum: null, post: null});
	});

	test('a post whose parent is missing is not a forum view', () => {
		const orphan = channel('post-2', 'thread', 'gone');
		const state = resolveForumPaneState({selected: orphan, getChannel: lookup(orphan)});
		expect(state.forum).toBeNull();
		expect(state.post).toBeNull();
	});

	test('no selection is the empty list', () => {
		expect(resolveForumPaneState({selected: null, getChannel}).mode).toBe(ForumPaneMode.LIST);
	});
});

describe('isOriginalPoster', () => {
	const post = {ownerId: 'user-1', isThread: () => true};

	test('marks the thread owner', () => {
		expect(isOriginalPoster({thread: post, authorId: 'user-1'})).toBe(true);
	});

	test('does not mark anyone else', () => {
		expect(isOriginalPoster({thread: post, authorId: 'user-2'})).toBe(false);
	});

	test('never marks system or webhook messages', () => {
		expect(isOriginalPoster({thread: post, authorId: 'user-1', system: true})).toBe(false);
		expect(isOriginalPoster({thread: post, authorId: 'user-1', webhook: true})).toBe(false);
	});

	test('does not mark messages outside a thread', () => {
		expect(isOriginalPoster({thread: {ownerId: 'user-1', isThread: () => false}, authorId: 'user-1'})).toBe(false);
		expect(isOriginalPoster({thread: null, authorId: 'user-1'})).toBe(false);
	});

	test('does nothing without an owner or author', () => {
		expect(isOriginalPoster({thread: {ownerId: null, isThread: () => true}, authorId: 'user-1'})).toBe(false);
		expect(isOriginalPoster({thread: post, authorId: null})).toBe(false);
	});
});

describe('moderated tags', () => {
	test('support is detected when the server reports the field', () => {
		expect(supportsModeratedTags([{id: 'a', moderated: false}])).toBe(true);
		expect(supportsModeratedTags([{id: 'a', moderated: true}])).toBe(true);
	});

	test('an older server that omits the field reports no support', () => {
		expect(supportsModeratedTags([{id: 'a', moderated: null}])).toBe(false);
		expect(supportsModeratedTags([])).toBe(false);
	});

	test('a plain tag is selectable by anyone', () => {
		expect(canSelectForumTag({id: 'a', moderated: false}, {canManage: false})).toBe(true);
		expect(canSelectForumTag({id: 'a', moderated: null}, {canManage: false})).toBe(true);
	});

	test('a moderated tag needs manage rights', () => {
		expect(canSelectForumTag({id: 'a', moderated: true}, {canManage: false})).toBe(false);
		expect(canSelectForumTag({id: 'a', moderated: true}, {canManage: true})).toBe(true);
	});

	test('an already applied moderated tag stays selectable so an edit cannot drop it', () => {
		expect(canSelectForumTag({id: 'a', moderated: true}, {canManage: false, alreadyApplied: true})).toBe(true);
	});

	test('the selectable list hides moderated tags from members', () => {
		const tags = [
			{id: 'open', moderated: false},
			{id: 'solved', moderated: true},
		];
		expect(selectableForumTags(tags, {canManage: false}).map((tag) => tag.id)).toEqual(['open']);
		expect(selectableForumTags(tags, {canManage: true}).map((tag) => tag.id)).toEqual(['open', 'solved']);
		expect(selectableForumTags(tags, {canManage: false, appliedTagIds: new Set(['solved'])}).map((t) => t.id)).toEqual([
			'open',
			'solved',
		]);
	});
});

describe('canAddToPost', () => {
	const base = {
		post: {ownerId: 'user-1', isThread: () => true},
		parentIsForum: true,
		currentUserId: 'user-1',
		hasImageAttachment: true,
		postAlreadyHasMedia: false,
		isStarterMessage: false,
		canManage: false,
	};

	test('offered to the post owner on an image reply', () => {
		expect(canAddToPost(base)).toBe(true);
	});

	test('offered to a thread moderator on someone else post', () => {
		expect(canAddToPost({...base, currentUserId: 'user-2', canManage: true})).toBe(true);
	});

	test('hidden from a member who neither owns the post nor moderates', () => {
		expect(canAddToPost({...base, currentUserId: 'user-2'})).toBe(false);
	});

	test('hidden without an image', () => {
		expect(canAddToPost({...base, hasImageAttachment: false})).toBe(false);
	});

	test('hidden when the post already carries media, since no card would change', () => {
		expect(canAddToPost({...base, postAlreadyHasMedia: true})).toBe(false);
	});

	test('hidden on the starter message itself, which the server rejects', () => {
		expect(canAddToPost({...base, isStarterMessage: true})).toBe(false);
		expect(canAddToPost({...base, isStarterMessage: true, canManage: true})).toBe(false);
	});

	test('hidden outside a forum', () => {
		expect(canAddToPost({...base, parentIsForum: false})).toBe(false);
		expect(canAddToPost({...base, parentIsForum: false, canManage: true})).toBe(false);
	});

	test('hidden outside a thread', () => {
		expect(canAddToPost({...base, post: {ownerId: 'user-1', isThread: () => false}})).toBe(false);
	});

	test('an unknown viewer sees nothing without manage rights', () => {
		expect(canAddToPost({...base, currentUserId: null})).toBe(false);
	});
});
