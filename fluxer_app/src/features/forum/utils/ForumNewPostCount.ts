// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the pure rule behind the "N New" pill beside a forum in the channel list. It counts
// open posts started by someone else after the forum was last acked, which is the same test
// upstream's ForumReadState.isNewPost applies per card, summed.

import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';

export interface NewPostCandidate {
	readonly id: string;
	readonly ownerId: string | null;
	readonly archived: boolean;
}

export function countNewForumPosts(
	posts: ReadonlyArray<NewPostCandidate>,
	ackMessageId: string,
	currentUserId: string | null,
): number {
	let count = 0;
	for (const post of posts) {
		if (post.archived) continue;
		if (post.ownerId != null && post.ownerId === currentUserId) continue;
		if (SnowflakeUtils.compare(post.id, ackMessageId) > 0) count++;
	}
	return count;
}
