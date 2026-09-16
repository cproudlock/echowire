// SPDX-License-Identifier: AGPL-3.0-or-later

import {CONTENT_WARNING_TEXT_MAX_LENGTH} from '@fluxer/constants/src/GuildConstants';
import {MAX_GROUP_DM_OTHER_RECIPIENTS, MAX_GROUP_DM_RECIPIENTS} from '@fluxer/constants/src/LimitConstants';
import {type UserPartial, UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {ChannelOverwriteTypeSchema, ChannelTypeSchema} from '@fluxer/schema/src/primitives/ChannelValidators';
import {ContentWarningLevelSchema} from '@fluxer/schema/src/primitives/GuildValidators';
import {PermissionStringType} from '@fluxer/schema/src/primitives/PermissionValidators';
import {createStringType, Int32Type, SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const ChannelOverwriteResponse = z.object({
	id: SnowflakeStringType.describe('The unique identifier for the role or user this overwrite applies to'),
	type: ChannelOverwriteTypeSchema.describe('The type of entity the overwrite applies to'),
	allow: PermissionStringType.describe('The bitwise value of allowed permissions'),
	deny: PermissionStringType.describe('The bitwise value of denied permissions'),
});

export type ChannelOverwriteResponse = z.infer<typeof ChannelOverwriteResponse>;

export const RtcRegionResponse = z.object({
	id: z.string().describe('The unique identifier for this RTC region'),
	name: z.string().describe('The display name of the RTC region'),
	emoji: z.string().describe('The emoji associated with this RTC region'),
	ping_endpoint: z.string().nullable().describe('The URL to ping for latency measurement'),
});

export type RtcRegionResponse = z.infer<typeof RtcRegionResponse>;

export const ChannelSlowmodeStateResponse = z.object({
	rate_limit_per_user: Int32Type.describe('The configured slowmode interval in seconds (0 if disabled)'),
	retry_after_ms: Int32Type.describe(
		'Milliseconds the current user must wait before sending the next message (0 if allowed now)',
	),
	next_send_allowed_at: z.iso
		.datetime()
		.nullable()
		.describe('Absolute timestamp at which the current user is next allowed to send a message, or null if allowed now'),
	can_bypass: z.boolean().describe('Whether the current user has permission to bypass slowmode'),
});

export type ChannelSlowmodeStateResponse = z.infer<typeof ChannelSlowmodeStateResponse>;

export const CallEligibilityResponse = z.object({
	ringable: z.boolean().describe('Whether the current user can ring this call'),
	silent: z.boolean().describe('Whether the call should be joined silently'),
});

export type CallEligibilityResponse = z.infer<typeof CallEligibilityResponse>;

export const VoiceDebugLoggingStatusResponse = z.object({
	active: z.boolean().describe('Whether clients in this channel should currently send voice diagnostics'),
	session_id: z.string().nullable().describe('Current debug logging session id, if active'),
	activated_by_user_id: SnowflakeStringType.nullable().describe('Staff user that activated the session, if active'),
	started_at_ms: z.number().int().nonnegative().nullable().describe('Session start Unix timestamp in milliseconds'),
	expires_at_ms: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe('Session expiration Unix timestamp in milliseconds'),
	poll_interval_ms: Int32Type.describe('Recommended client polling interval in milliseconds'),
	upload_interval_ms: Int32Type.describe('Recommended client telemetry batch upload interval in milliseconds'),
});

export type VoiceDebugLoggingStatusResponse = z.infer<typeof VoiceDebugLoggingStatusResponse>;

export const VoiceDebugLoggingEventsResponse = z.object({
	accepted: z.boolean().describe('Whether the telemetry batch was accepted for storage'),
	active: z.boolean().describe('Whether the server still considers this logging session active'),
	stored_event_count: Int32Type.describe('Number of events written to diagnostics storage'),
});

export type VoiceDebugLoggingEventsResponse = z.infer<typeof VoiceDebugLoggingEventsResponse>;

export const VoicePresenceHeartbeatResponse = z.object({
	ok: z.boolean().describe('Whether the heartbeat was accepted'),
	heartbeat_interval_ms: Int32Type.describe('Recommended client heartbeat interval in milliseconds'),
	heartbeat_ttl_ms: Int32Type.describe('Server-side heartbeat expiration window in milliseconds'),
	expires_at_ms: z.number().int().nonnegative().describe('Unix timestamp in milliseconds when this heartbeat expires'),
});

export type VoicePresenceHeartbeatResponse = z.infer<typeof VoicePresenceHeartbeatResponse>;

export const VoicePresenceHeartbeatEndResponse = z.object({
	ok: z.boolean().describe('Whether the heartbeat was ended'),
});

export type VoicePresenceHeartbeatEndResponse = z.infer<typeof VoicePresenceHeartbeatEndResponse>;

// Echowire: a tag definition for a forum channel's available_tags.
export const ForumTagResponse = z.object({
	id: SnowflakeStringType.describe('The unique identifier for this tag'),
	name: z.string().describe('The name of the tag'),
	emoji_name: z.string().nullable().describe('The emoji associated with this tag, or null'),
});

export type ForumTagResponse = z.infer<typeof ForumTagResponse>;

// Echowire: a compact view of a thread's starter message, returned on thread list endpoints so a
// forum can render post cards without fetching each post's first message.
export const ThreadStarterMessagePreviewResponse = z.object({
	message_id: SnowflakeStringType.describe('The ID of the starter message'),
	author: z
		.object({
			id: SnowflakeStringType.describe('The ID of the author'),
			username: z.string().describe('The username of the author'),
			global_name: z.string().nullable().describe('The display name of the author, if set'),
			avatar: z.string().nullable().describe('The avatar hash of the author'),
		})
		.nullable()
		.describe('The author of the starter message, or null for a system or deleted author'),
	content: z.string().describe('The starter message content, truncated to 200 characters'),
	first_attachment: z
		.object({
			id: SnowflakeStringType.describe('The ID of the attachment'),
			filename: z.string().describe('The file name of the attachment'),
			url: z.string().describe('The URL of the attachment'),
			proxy_url: z.string().nullable().describe('The proxied URL of the attachment, if any'),
			content_type: z.string().nullable().describe('The MIME type of the attachment'),
			width: Int32Type.nullable().describe('The width in pixels, for images and videos'),
			height: Int32Type.nullable().describe('The height in pixels, for images and videos'),
		})
		.nullable()
		.describe('The first attachment of the starter message, usable as a post thumbnail'),
});

export type ThreadStarterMessagePreviewResponse = z.infer<typeof ThreadStarterMessagePreviewResponse>;

export const ChannelResponse = z.object({
	id: SnowflakeStringType.describe('The unique identifier (snowflake) for this channel'),
	guild_id: SnowflakeStringType.optional().describe('The ID of the guild this channel belongs to'),
	name: z.string().optional().describe('The name of the channel'),
	topic: z.string().nullish().describe('The topic of the channel'),
	url: z.url().nullish().describe('The URL associated with the channel'),
	icon: z.string().nullish().describe('The icon hash of the channel (for group DMs)'),
	owner_id: SnowflakeStringType.nullish().describe('The ID of the owner of the channel (for group DMs)'),
	type: ChannelTypeSchema.describe('The type of the channel'),
	position: Int32Type.optional().describe('The sorting position of the channel'),
	parent_id: SnowflakeStringType.nullish().describe('The ID of the parent category for this channel'),
	bitrate: Int32Type.nullish().describe('The bitrate of the voice channel in bits per second'),
	user_limit: Int32Type.nullish().describe('The maximum number of users allowed in the voice channel'),
	voice_connection_limit: Int32Type.nullish().describe(
		'The maximum active voice connections allowed per user in the voice channel',
	),
	rtc_region: z.string().nullish().describe('The voice region ID for the voice channel'),
	last_message_id: SnowflakeStringType.nullish().describe('The ID of the last message sent in this channel'),
	last_pin_timestamp: z.iso
		.datetime()
		.nullish()
		.describe('The ISO 8601 timestamp of when the last pinned message was pinned'),
	permission_overwrites: z
		.array(ChannelOverwriteResponse)
		.optional()
		.describe('The permission overwrites for this channel'),
	recipients: z
		.array(z.lazy(() => UserPartialResponse))
		.max(MAX_GROUP_DM_OTHER_RECIPIENTS)
		.optional()
		.describe('The recipients of the DM channel'),
	nsfw: z
		.boolean()
		.optional()
		.describe('Whether the channel is marked as NSFW (effective value, walking channel → category → guild)'),
	nsfw_override: z
		.boolean()
		.nullish()
		.describe(
			'Per-channel adult-content override; null means inherit from parent category and then guild. Categories use this same field as their own override.',
		),
	content_warning_level: ContentWarningLevelSchema.optional().describe(
		'Channel-level content warning override (0=inherit, 1=force-warn)',
	),
	content_warning_text: z
		.string()
		.max(CONTENT_WARNING_TEXT_MAX_LENGTH)
		.nullish()
		.describe('Custom channel content warning text (max 200 characters); null inherits from parent or guild'),
	rate_limit_per_user: Int32Type.optional().describe('The slowmode rate limit in seconds'),
	nicks: z
		.record(z.string(), createStringType(1, 32))
		.optional()
		.describe('Custom nicknames for users in this channel (for group DMs)'),
	// Echowire: thread fields. Present only when `type` is a thread; `owner_id` above doubles as the thread creator.
	thread_metadata: z
		.object({
			archived: z.boolean().describe('Whether the thread is archived'),
			auto_archive_duration: Int32Type.describe(
				'Minutes of inactivity before auto-archiving (60, 1440, 4320, or 10080)',
			),
			archive_timestamp: z.iso.datetime().nullish().describe('ISO 8601 timestamp of the last archive state change'),
			locked: z.boolean().optional().describe('Whether the thread is locked (only moderators can unarchive)'),
			invitable: z.boolean().optional().describe('Whether non-moderators can add others to a private thread'),
			create_timestamp: z.iso.datetime().nullish().describe('ISO 8601 timestamp of thread creation'),
		})
		.nullish()
		.describe('Thread metadata; present only for thread channels'),
	member_count: Int32Type.optional().describe('Approximate count of members in the thread (threads only)'),
	message_count: Int32Type.optional().describe('Approximate count of messages in the thread (threads only)'),
	pinned: z.boolean().optional().describe('Whether this forum post / thread is pinned to the top'),
	starter_message_preview: ThreadStarterMessagePreviewResponse.nullish().describe(
		'Preview of the starter message; present on thread list endpoints only',
	),
	// Echowire forum fields. available_tags/default_reaction_emoji/default_sort_order: forum channels.
	// applied_tags: forum posts (threads).
	available_tags: z
		.array(ForumTagResponse)
		.max(20)
		.optional()
		.describe('Tags that can be applied to posts in a forum channel (max 20)'),
	applied_tags: z
		.array(SnowflakeStringType)
		.max(5)
		.optional()
		.describe('Tag IDs applied to a forum post / thread (max 5)'),
	default_reaction_emoji: z
		.object({
			emoji_id: SnowflakeStringType.nullable().describe('Custom emoji ID, or null for a unicode emoji'),
			emoji_name: z.string().nullable().describe('Unicode emoji, or null for a custom emoji'),
		})
		.nullish()
		.describe('The default reaction shown on forum posts'),
	default_sort_order: Int32Type.nullish().describe('Default sort for forum posts (0 = latest activity, 1 = creation)'),
	default_auto_archive_duration: Int32Type.nullish().describe('Default inactivity (minutes) new forum posts inherit'),
	require_tag: z.boolean().optional().describe('Whether a forum post must have at least one tag'),
	default_forum_layout: Int32Type.nullish().describe('Default forum layout (0 = not set, 1 = list, 2 = gallery)'),
	default_thread_rate_limit_per_user: Int32Type.nullish().describe('Slowmode in seconds that new forum posts inherit'),
});

export type ChannelResponse = z.infer<typeof ChannelResponse>;

export const ChannelNicknameOverrides = z
	.record(
		z.string().describe('User ID'),
		z.union([createStringType(0, 32), z.null()]).describe('Nickname or null to clear'),
	)
	.describe('User nickname overrides (user ID to nickname mapping)');

export type ChannelNicknameOverrides = z.infer<typeof ChannelNicknameOverrides>;

const ChannelPartialRecipientResponse = z.object({
	username: z.string().describe('The username of the recipient'),
});

export const ChannelPartialResponse = z.object({
	id: SnowflakeStringType.describe('The unique identifier (snowflake) for this channel'),
	name: z.string().nullish().describe('The name of the channel'),
	type: ChannelTypeSchema.describe('The type of the channel'),
	recipients: z
		.array(ChannelPartialRecipientResponse)
		.max(MAX_GROUP_DM_RECIPIENTS)
		.optional()
		.describe('The recipients of the DM channel'),
});

export type ChannelPartialResponse = z.infer<typeof ChannelPartialResponse>;

export interface ChannelOverwrite {
	readonly id: string;
	readonly type: number;
	readonly allow: string;
	readonly deny: string;
}

export interface Channel {
	readonly id: string;
	readonly guild_id?: string;
	readonly name?: string;
	readonly topic?: string | null;
	readonly url?: string | null;
	readonly icon?: string | null;
	readonly owner_id?: string | null;
	readonly type: number;
	readonly position?: number;
	readonly parent_id?: string | null;
	readonly bitrate?: number | null;
	readonly user_limit?: number | null;
	readonly voice_connection_limit?: number | null;
	readonly rtc_region?: string | null;
	readonly last_message_id?: string | null;
	readonly last_pin_timestamp?: string | null;
	readonly permission_overwrites?: ReadonlyArray<ChannelOverwrite>;
	readonly recipients?: ReadonlyArray<UserPartial>;
	readonly nsfw?: boolean;
	readonly nsfw_override?: boolean | null;
	readonly content_warning_level?: number;
	readonly content_warning_text?: string | null;
	readonly rate_limit_per_user?: number;
	readonly nicks?: Readonly<Record<string, string>>;
	// Echowire: thread fields (present only for thread channels).
	readonly thread_metadata?: {
		readonly archived: boolean;
		readonly auto_archive_duration: number;
		readonly archive_timestamp?: string | null;
		readonly locked?: boolean;
		readonly invitable?: boolean;
		readonly create_timestamp?: string | null;
	} | null;
	readonly member_count?: number;
	readonly message_count?: number;
	readonly pinned?: boolean;
	readonly starter_message_preview?: ThreadStarterMessagePreviewResponse | null;
	// Echowire forum fields.
	readonly available_tags?: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly emoji_name: string | null;
	}>;
	readonly applied_tags?: ReadonlyArray<string>;
	readonly default_reaction_emoji?: {
		readonly emoji_id: string | null;
		readonly emoji_name: string | null;
	} | null;
	readonly default_sort_order?: number | null;
	readonly default_auto_archive_duration?: number | null;
	readonly require_tag?: boolean;
	readonly default_forum_layout?: number | null;
	readonly default_thread_rate_limit_per_user?: number | null;
}

export const ChannelListResponse = z.array(ChannelResponse);

// Echowire: thread membership. The generator resolves response schemas by
// registered name, so the fork's thread routes need named schemas rather than
// inline z.array(...) literals.
export const ThreadMemberResponse = z.object({
	// Echowire: the thread id is additive here, so this response matches ThreadMemberSelfResponse
	// and an entry stays meaningful once it is out of the list it came from.
	id: SnowflakeStringType.describe('The ID of the thread'),
	user_id: z.string().describe('ID of the member'),
	join_timestamp: z.string().describe('When the member joined the thread'),
	flags: z.number().describe('Thread member flags'),
});
export type ThreadMemberResponse = z.infer<typeof ThreadMemberResponse>;

export const ThreadMemberListResponse = z.array(ThreadMemberResponse);
export type ThreadMemberListResponse = z.infer<typeof ThreadMemberListResponse>;

// Echowire: the caller's own membership in a thread, keyed by thread id.
export const ThreadMemberSelfResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the thread'),
	user_id: SnowflakeStringType.describe('The ID of the member (the caller)'),
	join_timestamp: z.string().describe('When the caller joined the thread'),
	flags: z.number().describe('Thread member flags'),
});
export type ThreadMemberSelfResponse = z.infer<typeof ThreadMemberSelfResponse>;

export const GuildActiveThreadsResponse = z.object({
	threads: z.array(ChannelResponse).describe('Active threads in the guild that the caller can view'),
	members: z.array(ThreadMemberSelfResponse).describe("The caller's memberships among the returned threads"),
});
export type GuildActiveThreadsResponse = z.infer<typeof GuildActiveThreadsResponse>;
export const RtcRegionListResponse = z.array(RtcRegionResponse);
