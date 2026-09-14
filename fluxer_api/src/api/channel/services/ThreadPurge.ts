// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: removing a thread removes everything that belongs to it. A thread left behind by a
// deleted parent channel has nothing to resolve its permissions against, so deleting a text or
// forum channel purges its threads first, and a periodic worker sweeps up any orphans that
// predate that rule.

import type {ChannelID, GuildID} from '@app/api/BrandedTypes';
import type {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {Channel} from '@app/api/models/Channel';
import {deleteChannelMessageSearchDocuments} from '@app/api/search/MessageSearchIndexCleanup';
import {ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';

export function canParentThreads(channel: Pick<Channel, 'type'>): boolean {
	return channel.type === ChannelTypes.GUILD_TEXT || channel.type === ChannelTypes.GUILD_FORUM;
}

export function threadsOfParent(channels: ReadonlyArray<Channel>, parentId: ChannelID): Array<Channel> {
	return channels.filter((channel) => THREAD_CHANNEL_TYPES.has(channel.type) && channel.parentId === parentId);
}

export async function purgeThread(params: {
	thread: Channel;
	guildId: GuildID;
	deleteMessages: (channelId: ChannelID) => Promise<void>;
	deleteChannelRow: (channelId: ChannelID, guildId: GuildID) => Promise<void>;
	purgeAttachments?: (thread: Channel) => Promise<void>;
	threadMemberRepository: ThreadMemberRepository;
	gatewayService: IGatewayService;
	source: string;
}): Promise<void> {
	const {thread, guildId} = params;
	if (params.purgeAttachments) {
		await params.purgeAttachments(thread);
	}
	await params.deleteMessages(thread.id);
	await deleteChannelMessageSearchDocuments(thread.id, {context: {source: params.source}});
	await params.threadMemberRepository.removeAllMembers(thread.id);
	// THREAD_DELETE goes out while the thread is still indexed, so the gateway can scope it to the
	// sessions that could see the thread.
	await params.gatewayService.dispatchGuild({
		guildId,
		event: 'THREAD_DELETE',
		data: {
			id: thread.id.toString(),
			guild_id: guildId.toString(),
			parent_id: thread.parentId ? thread.parentId.toString() : null,
			type: thread.type,
		},
	});
	await params.deleteChannelRow(thread.id, guildId);
}
