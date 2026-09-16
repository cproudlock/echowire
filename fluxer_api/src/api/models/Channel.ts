// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, MessageID, RoleID, UserID} from '@app/api/BrandedTypes';
import type {
	ChannelRow,
	DefaultReactionEmoji,
	ForumTag,
	PermissionOverwrite,
} from '@app/api/database/types/ChannelTypes';
import {ChannelPermissionOverwrite} from '@app/api/models/ChannelPermissionOverwrite';
import {type ChannelType, ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_CHANNEL_CONNECTION_LIMIT_DEFAULT} from '@fluxer/constants/src/LimitConstants';

export interface ThreadMetadata {
	readonly archived: boolean;
	readonly autoArchiveDuration: number;
	readonly archiveTimestamp: Date | null;
	readonly locked: boolean;
	readonly invitable: boolean;
	readonly createTimestamp: Date | null;
}

export class Channel {
	readonly id: ChannelID;
	readonly guildId: GuildID | null;
	readonly type: ChannelType;
	readonly name: string | null;
	readonly topic: string | null;
	readonly iconHash: string | null;
	readonly url: string | null;
	readonly parentId: ChannelID | null;
	readonly position: number;
	readonly ownerId: UserID | null;
	readonly recipientIds: Set<UserID>;
	readonly isNsfw: boolean;
	readonly nsfwOverride: boolean | null;
	readonly contentWarningLevel: number;
	readonly contentWarningText: string | null;
	readonly rateLimitPerUser: number;
	readonly bitrate: number | null;
	readonly userLimit: number | null;
	readonly voiceConnectionLimit: number | null;
	readonly rtcRegion: string | null;
	readonly lastMessageId: MessageID | null;
	readonly lastPinTimestamp: Date | null;
	readonly permissionOverwrites: Map<RoleID | UserID, ChannelPermissionOverwrite>;
	readonly nicknames: Map<string, string>;
	// Echowire: thread state (non-null only for thread channels).
	readonly threadMetadata: ThreadMetadata | null;
	readonly memberCount: number | null;
	readonly messageCount: number | null;
	readonly recentParticipantIds: Array<string> | null;
	// Echowire forum fields: tags live on the forum channel; appliedTags on its threads (posts).
	readonly availableTags: Array<ForumTag> | null;
	readonly appliedTags: Array<string> | null;
	readonly defaultReactionEmoji: DefaultReactionEmoji | null;
	readonly defaultSortOrder: number | null;
	readonly forumDefaultAutoArchiveDuration: number | null;
	readonly forumRequireTag: boolean;
	readonly defaultForumLayout: number | null;
	readonly defaultThreadRateLimitPerUser: number | null;
	readonly pinned: boolean;
	readonly isSoftDeleted: boolean;
	readonly indexedAt: Date | null;
	readonly version: number;

	constructor(row: ChannelRow) {
		this.id = row.channel_id;
		this.guildId = row.guild_id ?? null;
		this.type = row.type as ChannelType;
		this.name = row.name ?? null;
		this.topic = row.topic ?? null;
		this.iconHash = row.icon_hash ?? null;
		this.url = row.url ?? null;
		this.parentId = row.parent_id ?? null;
		this.position = row.position ?? 0;
		this.ownerId = row.owner_id ?? null;
		this.recipientIds = row.recipient_ids ?? new Set();
		this.isNsfw = row.nsfw ?? false;
		this.nsfwOverride = row.nsfw ?? null;
		this.contentWarningLevel = row.content_warning_level ?? 0;
		this.contentWarningText = row.content_warning_text ?? null;
		this.rateLimitPerUser = row.rate_limit_per_user ?? 0;
		this.bitrate = row.bitrate ?? 0;
		this.userLimit = row.user_limit ?? 0;
		this.voiceConnectionLimit =
			row.voice_connection_limit ??
			(this.type === ChannelTypes.GUILD_VOICE ? VOICE_CHANNEL_CONNECTION_LIMIT_DEFAULT : null);
		this.rtcRegion = row.rtc_region ?? null;
		this.lastMessageId = row.last_message_id ?? null;
		this.lastPinTimestamp = row.last_pin_timestamp ?? null;
		this.permissionOverwrites = new Map();
		if (row.permission_overwrites) {
			for (const [id, overwrite] of row.permission_overwrites) {
				this.permissionOverwrites.set(id, new ChannelPermissionOverwrite(overwrite));
			}
		}
		this.nicknames = row.nicks ?? new Map();
		this.threadMetadata = THREAD_CHANNEL_TYPES.has(this.type)
			? {
					archived: row.thread_archived ?? false,
					autoArchiveDuration: row.thread_auto_archive_duration ?? 1440,
					archiveTimestamp: row.thread_archive_timestamp ?? null,
					locked: row.thread_locked ?? false,
					invitable: row.thread_invitable ?? false,
					createTimestamp: row.thread_create_timestamp ?? null,
				}
			: null;
		this.memberCount = this.threadMetadata ? (row.thread_member_count ?? 0) : null;
		this.messageCount = this.threadMetadata ? (row.thread_message_count ?? 0) : null;
		this.recentParticipantIds = this.threadMetadata ? (row.thread_recent_participant_ids ?? []) : null;
		this.availableTags = this.type === ChannelTypes.GUILD_FORUM ? (row.available_tags ?? []) : null;
		this.appliedTags = this.threadMetadata ? (row.applied_tags ?? []) : null;
		this.defaultReactionEmoji = this.type === ChannelTypes.GUILD_FORUM ? (row.default_reaction_emoji ?? null) : null;
		this.defaultSortOrder = this.type === ChannelTypes.GUILD_FORUM ? (row.default_sort_order ?? null) : null;
		this.forumDefaultAutoArchiveDuration =
			this.type === ChannelTypes.GUILD_FORUM ? (row.forum_default_auto_archive_duration ?? null) : null;
		this.forumRequireTag = this.type === ChannelTypes.GUILD_FORUM ? (row.forum_require_tag ?? false) : false;
		this.defaultForumLayout = this.type === ChannelTypes.GUILD_FORUM ? (row.default_forum_layout ?? null) : null;
		this.defaultThreadRateLimitPerUser =
			this.type === ChannelTypes.GUILD_FORUM ? (row.default_thread_rate_limit_per_user ?? null) : null;
		this.pinned = this.threadMetadata ? (row.thread_pinned ?? false) : false;
		this.isSoftDeleted = row.soft_deleted;
		this.indexedAt = row.indexed_at ?? null;
		this.version = row.version;
	}

	toRow(): ChannelRow {
		const permOverwritesMap: Map<UserID | RoleID, PermissionOverwrite> | null =
			this.permissionOverwrites.size > 0
				? new Map(
						Array.from(this.permissionOverwrites.entries()).map(([id, overwrite]) => [
							id,
							overwrite.toPermissionOverwrite(),
						]),
					)
				: null;
		return {
			channel_id: this.id,
			guild_id: this.guildId,
			type: this.type,
			name: this.name,
			topic: this.topic,
			icon_hash: this.iconHash,
			url: this.url,
			parent_id: this.parentId,
			position: this.position,
			owner_id: this.ownerId,
			recipient_ids: this.recipientIds.size > 0 ? this.recipientIds : null,
			nsfw: this.nsfwOverride,
			content_warning_level: this.contentWarningLevel,
			content_warning_text: this.contentWarningText,
			rate_limit_per_user: this.rateLimitPerUser,
			bitrate: this.bitrate,
			user_limit: this.userLimit,
			voice_connection_limit: this.voiceConnectionLimit,
			rtc_region: this.rtcRegion,
			last_message_id: this.lastMessageId,
			last_pin_timestamp: this.lastPinTimestamp,
			permission_overwrites: permOverwritesMap,
			nicks: this.nicknames.size > 0 ? this.nicknames : null,
			thread_archived: this.threadMetadata?.archived ?? null,
			thread_auto_archive_duration: this.threadMetadata?.autoArchiveDuration ?? null,
			thread_archive_timestamp: this.threadMetadata?.archiveTimestamp ?? null,
			thread_locked: this.threadMetadata?.locked ?? null,
			thread_invitable: this.threadMetadata?.invitable ?? null,
			thread_create_timestamp: this.threadMetadata?.createTimestamp ?? null,
			thread_member_count: this.memberCount ?? null,
			thread_message_count: this.messageCount ?? null,
			thread_recent_participant_ids: this.recentParticipantIds ?? null,
			thread_pinned: this.threadMetadata ? this.pinned : null,
			available_tags: this.availableTags ?? null,
			applied_tags: this.appliedTags ?? null,
			default_reaction_emoji: this.defaultReactionEmoji ?? null,
			default_sort_order: this.defaultSortOrder ?? null,
			forum_default_auto_archive_duration: this.forumDefaultAutoArchiveDuration ?? null,
			forum_require_tag: this.type === ChannelTypes.GUILD_FORUM ? this.forumRequireTag : null,
			default_forum_layout: this.defaultForumLayout ?? null,
			default_thread_rate_limit_per_user: this.defaultThreadRateLimitPerUser ?? null,
			soft_deleted: this.isSoftDeleted,
			indexed_at: this.indexedAt,
			version: this.version,
		};
	}
}
