// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	ChannelID,
	GuildID,
	InviteCode,
	MessageID,
	RoleID,
	UserID,
	WebhookID,
	WebhookToken,
} from '../../BrandedTypes';

type Nullish<T> = T | null;

export interface PermissionOverwrite {
	type: number;
	allow_: Nullish<bigint>;
	deny_: Nullish<bigint>;
}

// Echowire: forum channel tag (available_tags) + default reaction shapes.
export interface ForumTag {
	id: string;
	name: string;
	emoji_name: Nullish<string>;
}
export interface DefaultReactionEmoji {
	emoji_id: Nullish<string>;
	emoji_name: Nullish<string>;
}

// Echowire: spread into any non-thread / non-forum ChannelRow literal to satisfy the full-row-upsert
// DSL (it requires every CHANNEL_COLUMNS key present). Covers both the thread_* fields and the forum
// fields (available_tags/applied_tags/default_reaction_emoji/default_sort_order) so the common
// channel-create sites stay terse; forum/thread sites override the relevant keys.
export const NULL_THREAD_FIELDS = {
	thread_archived: null,
	thread_auto_archive_duration: null,
	thread_archive_timestamp: null,
	thread_locked: null,
	thread_invitable: null,
	thread_create_timestamp: null,
	thread_member_count: null,
	thread_message_count: null,
	available_tags: null,
	applied_tags: null,
	default_reaction_emoji: null,
	default_sort_order: null,
} satisfies Pick<
	ChannelRow,
	| 'thread_archived'
	| 'thread_auto_archive_duration'
	| 'thread_archive_timestamp'
	| 'thread_locked'
	| 'thread_invitable'
	| 'thread_create_timestamp'
	| 'thread_member_count'
	| 'thread_message_count'
	| 'available_tags'
	| 'applied_tags'
	| 'default_reaction_emoji'
	| 'default_sort_order'
>;

export interface ChannelRow {
	channel_id: ChannelID;
	guild_id: Nullish<GuildID>;
	type: number;
	name: Nullish<string>;
	topic: Nullish<string>;
	icon_hash: Nullish<string>;
	url: Nullish<string>;
	parent_id: Nullish<ChannelID>;
	position: Nullish<number>;
	owner_id: Nullish<UserID>;
	recipient_ids: Nullish<Set<UserID>>;
	nsfw: Nullish<boolean>;
	content_warning_level?: Nullish<number>;
	content_warning_text?: Nullish<string>;
	rate_limit_per_user: Nullish<number>;
	bitrate: Nullish<number>;
	user_limit: Nullish<number>;
	voice_connection_limit: Nullish<number>;
	rtc_region: Nullish<string>;
	last_message_id: Nullish<MessageID>;
	last_pin_timestamp: Nullish<Date>;
	permission_overwrites: Nullish<Map<RoleID | UserID, PermissionOverwrite>>;
	nicks: Nullish<Map<string, string>>;
	// Echowire: thread fields (flat, like other Date/scalar columns so they round-trip through the KV layer).
	// Present only when `type` is a thread; owner_id (above) is the thread creator. NON-optional Nullish so
	// the full-row-upsert DSL (which requires every CHANNEL_COLUMNS key present) is satisfied at all sites.
	thread_archived: Nullish<boolean>;
	thread_auto_archive_duration: Nullish<number>;
	thread_archive_timestamp: Nullish<Date>;
	thread_locked: Nullish<boolean>;
	thread_invitable: Nullish<boolean>;
	thread_create_timestamp: Nullish<Date>;
	thread_member_count: Nullish<number>;
	thread_message_count: Nullish<number>;
	// Echowire forum fields. available_tags/default_reaction_emoji/default_sort_order are set on
	// GUILD_FORUM channels; applied_tags is set on threads (forum posts). NON-optional Nullish so the
	// full-row-upsert DSL is satisfied at every construction site.
	available_tags: Nullish<Array<ForumTag>>;
	applied_tags: Nullish<Array<string>>;
	default_reaction_emoji: Nullish<DefaultReactionEmoji>;
	default_sort_order: Nullish<number>;
	soft_deleted: boolean;
	indexed_at: Nullish<Date>;
	version: number;
}

export interface InviteRow {
	code: InviteCode;
	type: number;
	guild_id: Nullish<GuildID>;
	channel_id: Nullish<ChannelID>;
	inviter_id: Nullish<UserID>;
	created_at: Date;
	uses: number;
	max_uses: number;
	max_age: number;
	temporary: Nullish<boolean>;
	version: number;
}

export interface WebhookRow {
	webhook_id: WebhookID;
	webhook_token: WebhookToken;
	type: number;
	guild_id: Nullish<GuildID>;
	channel_id: Nullish<ChannelID>;
	creator_id: Nullish<UserID>;
	name: string;
	avatar_hash: Nullish<string>;
	version: number;
}

export interface PrivateChannelRow {
	user_id: UserID;
	channel_id: ChannelID;
	is_gdm: boolean;
	channel_type?: Nullish<number>;
	channel_name?: Nullish<string>;
	channel_icon_hash?: Nullish<string>;
	channel_owner_id?: Nullish<UserID>;
	channel_recipient_ids?: Nullish<Set<UserID>>;
	channel_last_message_id?: Nullish<MessageID>;
	channel_last_pin_timestamp?: Nullish<Date>;
	channel_nicks?: Nullish<Map<string, string>>;
	channel_rate_limit_per_user?: Nullish<number>;
	channel_nsfw?: Nullish<boolean>;
	channel_version?: Nullish<number>;
	snapshot_at?: Nullish<Date>;
}

export interface DmStateRow {
	hi_user_id: UserID;
	lo_user_id: UserID;
	channel_id: ChannelID;
}

export interface ReadStateRow {
	user_id: UserID;
	channel_id: ChannelID;
	message_id: Nullish<MessageID>;
	mention_count: number;
	last_pin_timestamp: Nullish<Date>;
}

export const CHANNEL_COLUMNS = [
	'channel_id',
	'guild_id',
	'type',
	'name',
	'topic',
	'icon_hash',
	'url',
	'parent_id',
	'position',
	'owner_id',
	'recipient_ids',
	'nsfw',
	'content_warning_level',
	'content_warning_text',
	'rate_limit_per_user',
	'bitrate',
	'user_limit',
	'voice_connection_limit',
	'rtc_region',
	'last_message_id',
	'last_pin_timestamp',
	'permission_overwrites',
	'nicks',
	'thread_archived',
	'thread_auto_archive_duration',
	'thread_archive_timestamp',
	'thread_locked',
	'thread_invitable',
	'thread_create_timestamp',
	'thread_member_count',
	'thread_message_count',
	'available_tags',
	'applied_tags',
	'default_reaction_emoji',
	'default_sort_order',
	'soft_deleted',
	'indexed_at',
	'version',
] as const satisfies ReadonlyArray<keyof ChannelRow>;

export interface ChannelsByGuildRow {
	guild_id: GuildID;
	channel_id: ChannelID;
}

export const CHANNELS_BY_GUILD_COLUMNS = ['guild_id', 'channel_id'] as const satisfies ReadonlyArray<
	keyof ChannelsByGuildRow
>;
export const INVITE_COLUMNS = [
	'code',
	'type',
	'guild_id',
	'channel_id',
	'inviter_id',
	'created_at',
	'uses',
	'max_uses',
	'max_age',
	'temporary',
	'version',
] as const satisfies ReadonlyArray<keyof InviteRow>;
export const WEBHOOK_COLUMNS = [
	'webhook_id',
	'webhook_token',
	'type',
	'guild_id',
	'channel_id',
	'creator_id',
	'name',
	'avatar_hash',
	'version',
] as const satisfies ReadonlyArray<keyof WebhookRow>;
export const READ_STATE_COLUMNS = [
	'user_id',
	'channel_id',
	'message_id',
	'mention_count',
	'last_pin_timestamp',
] as const satisfies ReadonlyArray<keyof ReadStateRow>;
export const PRIVATE_CHANNEL_COLUMNS = [
	'user_id',
	'channel_id',
	'is_gdm',
	'channel_type',
	'channel_name',
	'channel_icon_hash',
	'channel_owner_id',
	'channel_recipient_ids',
	'channel_last_message_id',
	'channel_last_pin_timestamp',
	'channel_nicks',
	'channel_rate_limit_per_user',
	'channel_nsfw',
	'channel_version',
	'snapshot_at',
] as const satisfies ReadonlyArray<keyof PrivateChannelRow>;
export const DM_STATE_COLUMNS = ['hi_user_id', 'lo_user_id', 'channel_id'] as const satisfies ReadonlyArray<
	keyof DmStateRow
>;
