// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {noteText} from '@app/features/theme/fonts/ScriptFontLoader';
import UserPinnedDM from '@app/features/user/state/UserPinnedDM';
import Users from '@app/features/user/state/Users';
import {
	ChannelTypes,
	GUILD_TEXT_BASED_CHANNEL_TYPES,
	Permissions,
	THREAD_CHANNEL_TYPES,
} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_CHANNEL_CONNECTION_LIMIT_DEFAULT} from '@fluxer/constants/src/LimitConstants';
import type {ChannelOverwrite, Channel as WireChannel} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {UserPartial} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';

export class ChannelOverwriteRecord {
	readonly id: string;
	readonly type: number;
	readonly allow: bigint;
	readonly deny: bigint;

	constructor(overwrite: ChannelOverwrite) {
		this.id = overwrite.id;
		this.type = overwrite.type;
		this.allow = BigInt(overwrite.allow);
		this.deny = BigInt(overwrite.deny);
	}

	withUpdates(overwrite: Partial<ChannelOverwrite>): ChannelOverwriteRecord {
		return new ChannelOverwriteRecord({
			id: this.id,
			type: overwrite.type ?? this.type,
			allow: overwrite.allow ?? this.allow.toString(),
			deny: overwrite.deny ?? this.deny.toString(),
		});
	}

	equals(other: ChannelOverwriteRecord): boolean {
		return this.id === other.id && this.type === other.type && this.allow === other.allow && this.deny === other.deny;
	}

	toJSON(): ChannelOverwrite {
		return {
			id: this.id,
			type: this.type,
			allow: this.allow.toString(),
			deny: this.deny.toString(),
		};
	}
}

interface ChannelRecordOptions {
	instanceId?: string;
}

function getRecipientPartials(recipientIds: ReadonlyArray<string>): Array<UserPartial> {
	return recipientIds
		.map((id) => Users?.getUser(id)?.toJSON())
		.filter((user): user is UserPartial => user !== undefined);
}

export class Channel {
	readonly instanceId: string;
	readonly id: string;
	readonly guildId?: string;
	readonly name?: string;
	readonly topic: string | null;
	readonly url: string | null;
	readonly icon: string | null;
	readonly ownerId: string | null;
	readonly type: number;
	readonly position?: number;
	readonly parentId: string | null;
	readonly bitrate: number | null;
	readonly userLimit: number | null;
	readonly voiceConnectionLimit: number | null;
	readonly rtcRegion: string | null;
	readonly lastMessageId: string | null;
	readonly lastPinTimestamp: Date | null;
	readonly permissionOverwrites: Readonly<Record<string, ChannelOverwriteRecord>>;
	readonly recipientIds: ReadonlyArray<string>;
	readonly nsfw: boolean;
	readonly nsfwOverride: boolean | null;
	readonly contentWarningLevel: number;
	readonly contentWarningText: string | null;
	readonly rateLimitPerUser: number;
	readonly nicks: Readonly<Record<string, string>>;
	// Echowire: thread state (non-null only for thread channels).
	readonly threadMetadata: {
		readonly archived: boolean;
		readonly autoArchiveDuration: number;
		readonly archiveTimestamp: Date | null;
		readonly locked: boolean;
		readonly invitable: boolean;
	} | null;
	readonly memberCount: number | null;
	readonly messageCount: number | null;
	// Echowire forum fields. availableTags/defaultReactionEmoji/defaultSortOrder: forum channels.
	// appliedTags: forum posts (threads).
	readonly availableTags: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly emojiName: string | null;
	}>;
	readonly appliedTags: ReadonlyArray<string>;
	readonly defaultReactionEmoji: {readonly emojiId: string | null; readonly emojiName: string | null} | null;
	readonly defaultSortOrder: number | null;
	readonly forumDefaultAutoArchiveDuration: number | null;
	readonly forumRequireTag: boolean;
	readonly pinned: boolean;

	constructor(channel: WireChannel, options?: ChannelRecordOptions) {
		this.instanceId = options?.instanceId ?? RuntimeConfig.localInstanceDomain;
		this.id = channel.id;
		this.guildId = channel.guild_id;
		this.name = channel.name;
		noteText(this.name);
		this.topic = channel.topic ?? null;
		this.url = channel.url ?? null;
		this.icon = channel.icon ?? null;
		this.ownerId = channel.owner_id ?? null;
		this.type = channel.type;
		this.position = channel.position;
		this.parentId = channel.parent_id ?? null;
		this.bitrate = channel.bitrate ?? null;
		this.userLimit = channel.user_limit ?? null;
		this.voiceConnectionLimit =
			channel.voice_connection_limit ??
			(this.type === ChannelTypes.GUILD_VOICE ? VOICE_CHANNEL_CONNECTION_LIMIT_DEFAULT : null);
		this.rtcRegion = channel.rtc_region ?? null;
		this.lastMessageId = channel.last_message_id ?? null;
		this.lastPinTimestamp = channel.last_pin_timestamp ? new Date(channel.last_pin_timestamp) : null;
		this.nsfw = channel.nsfw ?? false;
		this.nsfwOverride = channel.nsfw_override ?? null;
		this.contentWarningLevel = channel.content_warning_level ?? 0;
		this.contentWarningText = channel.content_warning_text ?? null;
		this.rateLimitPerUser = channel.rate_limit_per_user ?? 0;
		this.nicks = channel.nicks ?? {};
		this.threadMetadata = channel.thread_metadata
			? {
					archived: channel.thread_metadata.archived,
					autoArchiveDuration: channel.thread_metadata.auto_archive_duration,
					archiveTimestamp: channel.thread_metadata.archive_timestamp
						? new Date(channel.thread_metadata.archive_timestamp)
						: null,
					locked: channel.thread_metadata.locked ?? false,
					invitable: channel.thread_metadata.invitable ?? false,
				}
			: null;
		this.memberCount = channel.member_count ?? null;
		this.messageCount = channel.message_count ?? null;
		this.availableTags = (channel.available_tags ?? []).map((tag) => ({
			id: tag.id,
			name: tag.name,
			emojiName: tag.emoji_name,
		}));
		this.appliedTags = channel.applied_tags ?? [];
		this.defaultReactionEmoji = channel.default_reaction_emoji
			? {emojiId: channel.default_reaction_emoji.emoji_id, emojiName: channel.default_reaction_emoji.emoji_name}
			: null;
		this.defaultSortOrder = channel.default_sort_order ?? null;
		this.forumDefaultAutoArchiveDuration = channel.default_auto_archive_duration ?? null;
		this.forumRequireTag = channel.require_tag ?? false;
		this.pinned = channel.pinned ?? false;
		if ((this.type === ChannelTypes.DM || this.type === ChannelTypes.GROUP_DM) && channel.recipients) {
			Users?.cacheUsers(Array.from(channel.recipients));
		}
		if (this.type === ChannelTypes.DM_PERSONAL_NOTES) {
			this.recipientIds = channel.recipients?.map((user) => user.id) ?? [channel.id];
		} else if ((this.type === ChannelTypes.DM || this.type === ChannelTypes.GROUP_DM) && channel.recipients) {
			this.recipientIds = channel.recipients.map((user) => user.id);
		} else {
			this.recipientIds = [];
		}
		this.permissionOverwrites =
			!this.isPrivate() && channel.permission_overwrites
				? channel.permission_overwrites.reduce(
						(acc, overwrite) => {
							acc[overwrite.id] = new ChannelOverwriteRecord(overwrite);
							return acc;
						},
						{} as Record<string, ChannelOverwriteRecord>,
					)
				: {};
	}

	get isPinned(): boolean {
		return UserPinnedDM.pinnedDMs.includes(this.id);
	}

	isPrivate(): boolean {
		return (
			this.type === ChannelTypes.DM ||
			this.type === ChannelTypes.GROUP_DM ||
			this.type === ChannelTypes.DM_PERSONAL_NOTES
		);
	}

	isDM(): boolean {
		return this.type === ChannelTypes.DM;
	}

	isThread(): boolean {
		return THREAD_CHANNEL_TYPES.has(this.type);
	}

	isForum(): boolean {
		return this.type === ChannelTypes.GUILD_FORUM;
	}

	isGroupDM(): boolean {
		return this.type === ChannelTypes.GROUP_DM;
	}

	isPersonalNotes(): boolean {
		return this.type === ChannelTypes.DM_PERSONAL_NOTES;
	}

	isGuildText(): boolean {
		return this.type === ChannelTypes.GUILD_TEXT;
	}

	isGuildVoice(): boolean {
		return this.type === ChannelTypes.GUILD_VOICE;
	}

	isGuildCategory(): boolean {
		return this.type === ChannelTypes.GUILD_CATEGORY;
	}

	isVoice(): boolean {
		return this.type === ChannelTypes.GUILD_VOICE;
	}

	isText(): boolean {
		return GUILD_TEXT_BASED_CHANNEL_TYPES.has(this.type);
	}

	isMature(): boolean {
		return this.nsfw;
	}

	isRoleRequired(): boolean {
		if (
			this.guildId == null ||
			(this.type !== ChannelTypes.GUILD_TEXT &&
				this.type !== ChannelTypes.GUILD_VOICE &&
				this.type !== ChannelTypes.GUILD_LINK)
		) {
			return false;
		}
		const flag = this.type === ChannelTypes.GUILD_VOICE ? Permissions.CONNECT : Permissions.VIEW_CHANNEL;
		const overwrite = this.permissionOverwrites[this.guildId];
		return overwrite != null && (overwrite.deny & flag) === flag;
	}

	getRecipientId(): string | undefined {
		if (this.type !== ChannelTypes.DM) return undefined;
		return this.recipientIds[0];
	}

	get createdAt(): Date {
		return new Date(SnowflakeUtils.extractTimestamp(this.id));
	}

	withUpdates(updates: Partial<WireChannel>): Channel {
		let newRecipients: Array<UserPartial> = [];
		if (
			updates.type === ChannelTypes.DM_PERSONAL_NOTES ||
			(this.type === ChannelTypes.DM_PERSONAL_NOTES && updates.type === undefined)
		) {
			if (updates.recipients) {
				newRecipients = Array.from(updates.recipients);
				Users?.cacheUsers(newRecipients);
			}
		} else if ((this.type === ChannelTypes.DM || this.type === ChannelTypes.GROUP_DM) && updates.recipients) {
			newRecipients = Array.from(updates.recipients);
			Users?.cacheUsers(newRecipients);
		} else if (this.type === ChannelTypes.DM || this.type === ChannelTypes.GROUP_DM) {
			newRecipients = getRecipientPartials(this.recipientIds);
		}
		return new Channel(
			{
				id: this.id,
				guild_id: updates.guild_id ?? this.guildId,
				name: updates.name ?? this.name,
				topic: updates.topic !== undefined ? updates.topic : this.topic,
				url: updates.url !== undefined ? updates.url : this.url,
				icon: updates.icon !== undefined ? updates.icon : this.icon,
				owner_id: updates.owner_id !== undefined ? updates.owner_id : this.ownerId,
				type: updates.type ?? this.type,
				position: updates.position ?? this.position,
				parent_id: updates.parent_id !== undefined ? updates.parent_id : this.parentId,
				bitrate: updates.bitrate !== undefined ? updates.bitrate : this.bitrate,
				user_limit: updates.user_limit !== undefined ? updates.user_limit : this.userLimit,
				voice_connection_limit:
					updates.voice_connection_limit !== undefined ? updates.voice_connection_limit : this.voiceConnectionLimit,
				rtc_region: updates.rtc_region !== undefined ? updates.rtc_region : this.rtcRegion,
				last_message_id: updates.last_message_id !== undefined ? updates.last_message_id : this.lastMessageId,
				last_pin_timestamp: updates.last_pin_timestamp ?? this.lastPinTimestamp?.toISOString() ?? undefined,
				permission_overwrites: !this.isPrivate()
					? (updates.permission_overwrites ?? Object.values(this.permissionOverwrites).map((o) => o.toJSON()))
					: undefined,
				recipients: newRecipients.length > 0 ? newRecipients : undefined,
				nsfw: updates.nsfw ?? this.nsfw,
				nsfw_override: updates.nsfw_override !== undefined ? updates.nsfw_override : this.nsfwOverride,
				content_warning_level:
					updates.content_warning_level !== undefined ? updates.content_warning_level : this.contentWarningLevel,
				content_warning_text:
					updates.content_warning_text !== undefined ? updates.content_warning_text : this.contentWarningText,
				rate_limit_per_user: updates.rate_limit_per_user ?? this.rateLimitPerUser,
				nicks: updates.nicks ?? this.nicks,
				// Echowire: preserve/merge thread state so THREAD_UPDATE events don't wipe it.
				thread_metadata:
					updates.thread_metadata !== undefined
						? updates.thread_metadata
						: this.threadMetadata
							? {
									archived: this.threadMetadata.archived,
									auto_archive_duration: this.threadMetadata.autoArchiveDuration,
									archive_timestamp: this.threadMetadata.archiveTimestamp?.toISOString() ?? null,
									locked: this.threadMetadata.locked,
									invitable: this.threadMetadata.invitable,
								}
							: null,
				member_count: updates.member_count ?? this.memberCount ?? undefined,
				message_count: updates.message_count ?? this.messageCount ?? undefined,
				pinned: updates.pinned !== undefined ? updates.pinned : this.pinned,
				// Echowire: preserve/merge forum state so partial channel updates don't wipe tags etc.
				available_tags:
					updates.available_tags !== undefined
						? updates.available_tags
						: this.availableTags.length > 0
							? this.availableTags.map((tag) => ({id: tag.id, name: tag.name, emoji_name: tag.emojiName}))
							: undefined,
				applied_tags:
					updates.applied_tags !== undefined
						? updates.applied_tags
						: this.appliedTags.length > 0
							? [...this.appliedTags]
							: undefined,
				default_reaction_emoji:
					updates.default_reaction_emoji !== undefined
						? updates.default_reaction_emoji
						: this.defaultReactionEmoji
							? {emoji_id: this.defaultReactionEmoji.emojiId, emoji_name: this.defaultReactionEmoji.emojiName}
							: null,
				default_sort_order:
					updates.default_sort_order !== undefined ? updates.default_sort_order : (this.defaultSortOrder ?? null),
				default_auto_archive_duration:
					updates.default_auto_archive_duration !== undefined
						? updates.default_auto_archive_duration
						: (this.forumDefaultAutoArchiveDuration ?? null),
				require_tag: updates.require_tag !== undefined ? updates.require_tag : this.forumRequireTag,
			},
			{instanceId: this.instanceId},
		);
	}

	withOverwrite(overwrite: ChannelOverwriteRecord): Channel {
		if (this.isPrivate()) {
			return this;
		}
		return new Channel(
			{
				...this.toJSON(),
				permission_overwrites: Object.values({
					...this.permissionOverwrites,
					[overwrite.id]: overwrite,
				}).map((o) => o.toJSON()),
			},
			{instanceId: this.instanceId},
		);
	}

	equals(other: Channel): boolean {
		if (this === other) return true;
		if (this.instanceId !== other.instanceId) return false;
		if (this.id !== other.id) return false;
		if (this.guildId !== other.guildId) return false;
		if (this.name !== other.name) return false;
		if (this.topic !== other.topic) return false;
		if (this.url !== other.url) return false;
		if (this.icon !== other.icon) return false;
		if (this.ownerId !== other.ownerId) return false;
		if (this.type !== other.type) return false;
		if (this.position !== other.position) return false;
		if (this.parentId !== other.parentId) return false;
		if (this.bitrate !== other.bitrate) return false;
		if (this.userLimit !== other.userLimit) return false;
		if (this.voiceConnectionLimit !== other.voiceConnectionLimit) return false;
		if (this.rtcRegion !== other.rtcRegion) return false;
		if (this.lastMessageId !== other.lastMessageId) return false;
		if (this.lastPinTimestamp?.getTime() !== other.lastPinTimestamp?.getTime()) return false;
		if (this.nsfw !== other.nsfw) return false;
		if (this.nsfwOverride !== other.nsfwOverride) return false;
		if (this.contentWarningLevel !== other.contentWarningLevel) return false;
		if (this.contentWarningText !== other.contentWarningText) return false;
		if (this.rateLimitPerUser !== other.rateLimitPerUser) return false;
		if (this.recipientIds.length !== other.recipientIds.length) return false;
		for (let i = 0; i < this.recipientIds.length; i++) {
			if (this.recipientIds[i] !== other.recipientIds[i]) return false;
		}
		const thisOverwrites = Object.keys(this.permissionOverwrites);
		const otherOverwrites = Object.keys(other.permissionOverwrites);
		if (thisOverwrites.length !== otherOverwrites.length) return false;
		for (const key of thisOverwrites) {
			if (!this.permissionOverwrites[key].equals(other.permissionOverwrites[key])) {
				return false;
			}
		}
		// Echowire: thread state must be part of identity equality, otherwise an
		// archive/unarchive (which changes only thread_metadata) is treated as "equal"
		// and the store skips the update — the UI then needs a hard refresh to reflect it.
		if (this.threadMetadata?.archived !== other.threadMetadata?.archived) return false;
		if (this.threadMetadata?.locked !== other.threadMetadata?.locked) return false;
		if (this.threadMetadata?.autoArchiveDuration !== other.threadMetadata?.autoArchiveDuration) return false;
		if (this.threadMetadata?.invitable !== other.threadMetadata?.invitable) return false;
		if (this.threadMetadata?.archiveTimestamp?.getTime() !== other.threadMetadata?.archiveTimestamp?.getTime()) {
			return false;
		}
		if (this.memberCount !== other.memberCount) return false;
		if (this.messageCount !== other.messageCount) return false;
		if (this.pinned !== other.pinned) return false;
		if (this.forumDefaultAutoArchiveDuration !== other.forumDefaultAutoArchiveDuration) return false;
		if (this.forumRequireTag !== other.forumRequireTag) return false;
		// Echowire: forum tag/sort/reaction state — same live-update reasoning as thread state above.
		if (this.defaultSortOrder !== other.defaultSortOrder) return false;
		if (this.defaultReactionEmoji?.emojiId !== other.defaultReactionEmoji?.emojiId) return false;
		if (this.defaultReactionEmoji?.emojiName !== other.defaultReactionEmoji?.emojiName) return false;
		if (this.appliedTags.length !== other.appliedTags.length) return false;
		for (let i = 0; i < this.appliedTags.length; i++) {
			if (this.appliedTags[i] !== other.appliedTags[i]) return false;
		}
		if (this.availableTags.length !== other.availableTags.length) return false;
		for (let i = 0; i < this.availableTags.length; i++) {
			if (this.availableTags[i].id !== other.availableTags[i].id) return false;
			if (this.availableTags[i].name !== other.availableTags[i].name) return false;
			if (this.availableTags[i].emojiName !== other.availableTags[i].emojiName) return false;
		}
		return true;
	}

	toJSON(): WireChannel {
		return {
			id: this.id,
			guild_id: this.guildId,
			name: this.name,
			topic: this.topic,
			url: this.url,
			icon: this.icon,
			owner_id: this.ownerId,
			type: this.type,
			position: this.position,
			parent_id: this.parentId,
			bitrate: this.bitrate,
			user_limit: this.userLimit,
			voice_connection_limit: this.voiceConnectionLimit,
			rtc_region: this.rtcRegion,
			last_message_id: this.lastMessageId,
			last_pin_timestamp: this.lastPinTimestamp?.toISOString() ?? undefined,
			permission_overwrites: Object.values(this.permissionOverwrites).map((o) => o.toJSON()),
			recipients:
				this.type === ChannelTypes.DM || this.type === ChannelTypes.GROUP_DM
					? getRecipientPartials(this.recipientIds)
					: undefined,
			nsfw: this.nsfw,
			nsfw_override: this.nsfwOverride,
			content_warning_level: this.contentWarningLevel,
			content_warning_text: this.contentWarningText,
			rate_limit_per_user: this.rateLimitPerUser,
			nicks: this.nicks,
			available_tags:
				this.availableTags.length > 0
					? this.availableTags.map((tag) => ({id: tag.id, name: tag.name, emoji_name: tag.emojiName}))
					: undefined,
			applied_tags: this.appliedTags.length > 0 ? [...this.appliedTags] : undefined,
			default_reaction_emoji: this.defaultReactionEmoji
				? {emoji_id: this.defaultReactionEmoji.emojiId, emoji_name: this.defaultReactionEmoji.emojiName}
				: null,
			default_sort_order: this.defaultSortOrder,
			default_auto_archive_duration: this.forumDefaultAutoArchiveDuration,
			require_tag: this.forumRequireTag ? true : undefined,
			pinned: this.pinned ? true : undefined,
		};
	}
}
