// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, MessageID} from '@app/api/BrandedTypes';
import type {ChannelRow} from '@app/api/database/types/ChannelTypes';
import type {Channel} from '@app/api/models/Channel';

export abstract class IChannelDataRepository {
	abstract findUnique(channelId: ChannelID): Promise<Channel | null>;

	abstract upsert(data: ChannelRow): Promise<Channel>;

	abstract updateLastMessageId(channelId: ChannelID, messageId: MessageID): Promise<void>;

	// Echowire: targeted writes for thread state; see ThreadPatchableColumn in ChannelDataRepository.
	abstract patchThreadFields(
		channelId: ChannelID,
		fields: Partial<
			Pick<
				ChannelRow,
				| 'name'
				| 'applied_tags'
				| 'thread_auto_archive_duration'
				| 'thread_invitable'
				| 'thread_archived'
				| 'thread_archive_timestamp'
				| 'thread_locked'
				| 'thread_pinned'
				| 'thread_member_count'
				| 'thread_message_count'
			>
		>,
	): Promise<void>;

	abstract adjustThreadMessageCount(channelId: ChannelID, delta: number): Promise<void>;

	abstract delete(channelId: ChannelID, guildId?: GuildID): Promise<void>;

	abstract listGuildChannels(guildId: GuildID): Promise<Array<Channel>>;

	abstract listChannels(channelIds: Array<ChannelID>): Promise<Array<Channel>>;

	abstract countGuildChannels(guildId: GuildID): Promise<number>;
}
