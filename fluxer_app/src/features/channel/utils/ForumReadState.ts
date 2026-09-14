// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: store-aware forum read helpers shared by the sidebar, the channel context menu and the
// forum view. The pure rules live in ForumPostUtils.

import {Endpoints} from '@app/features/app/constants/Endpoints';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ForumViewPreferences from '@app/features/channel/state/ForumViewPreferences';
import {countNewForumPosts, getForumNewestActivityId} from '@app/features/channel/utils/ForumPostUtils';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as ReadStateCommands from '@app/features/read_state/commands/ReadStateCommands';
import ReadStates from '@app/features/read_state/state/ReadStates';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';

const logger = new Logger('ForumReadState');

export function getForumPosts(forum: Channel): Array<Channel> {
	if (!forum.guildId) return [];
	return Channels.getGuildChannels(forum.guildId).filter(
		(channel) => channel.parentId === forum.id && THREAD_CHANNEL_TYPES.has(channel.type),
	);
}

// The last-visit marker: the later of the server read state for the forum (acked with the newest
// post activity when viewed) and the local record of the last view on this device.
export function getForumLastViewedAt(forum: Channel): number | null {
	const serverAckId = ReadStates.getIfExists(forum.id)?.ackMessageId ?? null;
	const serverAt = serverAckId ? SnowflakeUtils.extractTimestamp(serverAckId) : null;
	const localAt = ForumViewPreferences.getLastViewedAt(forum.id);
	if (serverAt == null) return localAt;
	if (localAt == null) return serverAt;
	return Math.max(serverAt, localAt);
}

export function getForumNewPostCount(forum: Channel): number {
	return countNewForumPosts(getForumPosts(forum), {lastViewedAt: getForumLastViewedAt(forum)});
}

// Records a visit: locally at once, and on the server by acking the forum with its newest activity.
export function markForumViewed(forum: Channel): void {
	ForumViewPreferences.markViewed(forum.id);
	const newestActivityId = getForumNewestActivityId(getForumPosts(forum));
	if (!newestActivityId) return;
	void http.post(Endpoints.CHANNEL_MESSAGE_ACK(forum.id, newestActivityId), {body: {}}).catch((error) => {
		logger.warn(`Failed to ack forum ${forum.id}:`, error);
	});
}

export function forumHasUnreadPosts(forum: Channel): boolean {
	return getForumNewPostCount(forum) > 0 || getForumPosts(forum).some((post) => ReadStates.hasUnread(post.id));
}

// Clears the "N New" count and acks every post in the forum that has unread messages.
export function markForumRead(forum: Channel): void {
	markForumViewed(forum);
	const unreadPostIds = getForumPosts(forum)
		.filter((post) => ReadStates.hasUnread(post.id))
		.map((post) => post.id);
	if (unreadPostIds.length > 0) {
		void ReadStateCommands.bulkAckChannels(unreadPostIds);
	}
}
