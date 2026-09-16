// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: pure helpers for the forum split view, the OP badge, moderated tags and "Add to Post".
// Kept free of stores and React so the rules can be unit tested.

export const ForumPaneMode = {
	// The forum's post list fills the channel body; no post is open.
	LIST: 'list',
	// The list stays on the left with the open post beside it.
	SPLIT: 'split',
	// The open post fills the body; the list is hidden.
	FULL: 'full',
} as const;
export type ForumPaneMode = (typeof ForumPaneMode)[keyof typeof ForumPaneMode];

export interface ForumPaneChannelLike {
	readonly id: string;
	readonly parentId: string | null;
	readonly isThread: () => boolean;
	readonly isForum: () => boolean;
}

export interface ForumPaneStateInput<T extends ForumPaneChannelLike> {
	// The channel the user navigated to, which is either the forum or one of its posts.
	readonly selected: T | null | undefined;
	// Resolves a channel id, used to find the post's parent forum.
	readonly getChannel: (id: string) => T | null | undefined;
	// The per-forum "Open in Full View" preference.
	readonly fullView?: boolean;
	// Narrow viewports show one pane at a time, so an open post takes the whole body.
	readonly narrow?: boolean;
}

export interface ForumPaneState<T extends ForumPaneChannelLike> {
	readonly mode: ForumPaneMode;
	// The forum whose list backs the view, whether or not a post is open.
	readonly forum: T | null;
	// The open post, or null in list mode.
	readonly post: T | null;
}

// Resolves what the forum body should render. A forum selection is the list; a post selection is
// the post beside its forum's list, or alone when the user asked for full view or the viewport is
// narrow. Anything else (a post whose parent is missing, a non-forum channel) is not a forum view.
export function resolveForumPaneState<T extends ForumPaneChannelLike>(
	input: ForumPaneStateInput<T>,
): ForumPaneState<T> {
	const {selected, getChannel, fullView = false, narrow = false} = input;
	if (!selected) {
		return {mode: ForumPaneMode.LIST, forum: null, post: null};
	}
	if (selected.isForum()) {
		return {mode: ForumPaneMode.LIST, forum: selected, post: null};
	}
	if (!selected.isThread() || !selected.parentId) {
		return {mode: ForumPaneMode.LIST, forum: null, post: null};
	}
	const parent = getChannel(selected.parentId) ?? null;
	if (!parent || !parent.isForum()) {
		return {mode: ForumPaneMode.LIST, forum: null, post: null};
	}
	return {mode: fullView || narrow ? ForumPaneMode.FULL : ForumPaneMode.SPLIT, forum: parent, post: selected};
}

export interface OriginalPosterInput {
	// The thread or post the message was written in.
	readonly thread: {readonly ownerId: string | null; readonly isThread: () => boolean} | null | undefined;
	readonly authorId: string | null | undefined;
	// System messages and webhook posts never carry the badge.
	readonly system?: boolean;
	readonly webhook?: boolean;
}

// The OP badge marks every message written by whoever started the thread, including the starter.
export function isOriginalPoster(input: OriginalPosterInput): boolean {
	const {thread, authorId, system = false, webhook = false} = input;
	if (system || webhook) return false;
	if (!thread || !thread.isThread()) return false;
	if (!thread.ownerId || !authorId) return false;
	return thread.ownerId === authorId;
}

export interface ModeratedTagLike {
	readonly id: string;
	// null means the server did not report the field, so moderated tags are not supported yet.
	readonly moderated: boolean | null;
}

// A server that supports moderated tags reports the field on every tag, false included.
export function supportsModeratedTags(tags: ReadonlyArray<ModeratedTagLike>): boolean {
	return tags.some((tag) => tag.moderated != null);
}

// Only moderators may apply a moderated tag. Tags a member already has stay selectable so an edit
// cannot silently drop them; the server is the authority either way.
export function canSelectForumTag(
	tag: ModeratedTagLike,
	options: {readonly canManage: boolean; readonly alreadyApplied?: boolean},
): boolean {
	if (tag.moderated !== true) return true;
	return options.canManage || options.alreadyApplied === true;
}

export function selectableForumTags<T extends ModeratedTagLike>(
	tags: ReadonlyArray<T>,
	options: {readonly canManage: boolean; readonly appliedTagIds?: ReadonlySet<string>},
): Array<T> {
	return tags.filter((tag) =>
		canSelectForumTag(tag, {canManage: options.canManage, alreadyApplied: options.appliedTagIds?.has(tag.id)}),
	);
}

export interface AddToPostInput {
	// The post the message was written in.
	readonly post: {readonly ownerId: string | null; readonly isThread: () => boolean} | null | undefined;
	readonly parentIsForum: boolean;
	readonly currentUserId: string | null | undefined;
	// The message carries at least one image attachment.
	readonly hasImageAttachment: boolean;
	// The starter message already carries media, so the card thumbnail would not change.
	readonly postAlreadyHasMedia: boolean;
	// The source message is the starter itself, which the server rejects.
	readonly isStarterMessage: boolean;
	// MANAGE_THREADS (or MANAGE_CHANNELS) on the parent forum.
	readonly canManage: boolean;
}

// "Add to Post" appends a message's image to the post's starter message, where it becomes the card
// thumbnail. Per the forums phase 2 contract the caller must own the post or moderate threads, and
// the source cannot be the starter. Offered only while the post has no media, matching Discord,
// since appending a second attachment changes no card.
export function canAddToPost(input: AddToPostInput): boolean {
	const {post, parentIsForum, currentUserId, hasImageAttachment, postAlreadyHasMedia, isStarterMessage, canManage} =
		input;
	if (!parentIsForum || !hasImageAttachment || postAlreadyHasMedia || isStarterMessage) return false;
	if (!post || !post.isThread()) return false;
	if (canManage) return true;
	if (!currentUserId || !post.ownerId) return false;
	return post.ownerId === currentUserId;
}
