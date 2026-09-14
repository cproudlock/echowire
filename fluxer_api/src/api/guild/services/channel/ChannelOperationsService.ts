// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelID,
	createChannelID,
	createMessageID,
	createRoleID,
	createUserID,
	type EmojiID,
	type GuildID,
	type RoleID,
	type StickerID,
	type UserID,
} from '@app/api/BrandedTypes';
import {mapChannelToResponse} from '@app/api/channel/ChannelMappers';
import type {IChannelRepository} from '@app/api/channel/IChannelRepository';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {makeAttachmentCdnUrl} from '@app/api/channel/services/message/MessageHelpers';
import type {MessageSystemService} from '@app/api/channel/services/message/MessageSystemService';
import {
	canAccessPrivateThread,
	canViewThread,
	getThreadParentPermissions,
	hasPermissionBits,
	withPrivateThreadMemberIds,
} from '@app/api/channel/services/ThreadAccess';
import {NULL_THREAD_FIELDS, type PermissionOverwrite} from '@app/api/database/types/ChannelTypes';
import type {GuildAuditLogService} from '@app/api/guild/GuildAuditLogService';
import type {GuildAuditLogChange} from '@app/api/guild/GuildAuditLogTypes';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import {ChannelHelpers, type ChannelReorderOperation} from '@app/api/guild/services/channel/ChannelHelpers';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {Channel} from '@app/api/models/Channel';
import {ChannelPermissionOverwrite} from '@app/api/models/ChannelPermissionOverwrite';
import type {Message} from '@app/api/models/Message';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import {AuditLogActionType} from '@fluxer/constants/src/AuditLogActionType';
import {ALL_PERMISSIONS, ChannelTypes, Permissions, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {ContentWarningLevel, GuildFeatures, resolveVoiceChannelBitrate} from '@fluxer/constants/src/GuildConstants';
import {
	MAX_CHANNELS_PER_CATEGORY,
	MAX_GUILD_CHANNELS,
	VOICE_CHANNEL_CONNECTION_LIMIT_DEFAULT,
} from '@fluxer/constants/src/LimitConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {MaxCategoryChannelsError} from '@fluxer/errors/src/domains/channel/MaxCategoryChannelsError';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {SlowmodeRateLimitError} from '@fluxer/errors/src/domains/core/SlowmodeRateLimitError';
import {MaxGuildChannelsError} from '@fluxer/errors/src/domains/guild/MaxGuildChannelsError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import type {
	ChannelCreateRequest,
	ThreadCreateRequest,
	ThreadUpdateRequest,
} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import type {
	ChannelResponse,
	GuildActiveThreadsResponse,
	ThreadStarterMessagePreviewResponse,
} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {
	computeChannelMoveBlockIds,
	computeGuildChannelReorderPlan,
	type GuildChannelReorderErrorCode,
	sortChannelsForOrdering,
} from '@fluxer/schema/src/domains/channel/GuildChannelOrdering';
import {ChannelNameType} from '@fluxer/schema/src/primitives/ChannelValidators';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import type {IRateLimitService} from '@pkgs/rate_limit/src/IRateLimitService';

const STARTER_PREVIEW_MAX_LENGTH = 200;

export class ChannelOperationsService {
	constructor(
		private readonly channelRepository: IChannelRepository,
		private readonly guildRepository: IGuildRepositoryAggregate,
		private readonly userCacheService: UserCacheService,
		private readonly gatewayService: IGatewayService,
		private readonly cacheService: ICacheService,
		private readonly snowflakeService: ISnowflakeService,
		private readonly guildAuditLogService: GuildAuditLogService,
		private readonly limitConfigService: LimitConfigService,
		private readonly messageSystemService: MessageSystemService,
		private readonly rateLimitService: IRateLimitService,
		private readonly userRepository: IUserRepository,
	) {}

	private readonly threadMemberRepository = new ThreadMemberRepository();

	async createChannel(
		params: {
			userId: UserID;
			guildId: GuildID;
			data: ChannelCreateRequest;
			requestCache: RequestCache;
		},
		auditLogReason?: string | null,
	): Promise<ChannelResponse> {
		await this.ensureGuildHasCapacity(params.guildId);
		const channels = await this.channelRepository.listGuildChannels(params.guildId);
		const parentId = params.data.parent_id ? createChannelID(params.data.parent_id) : null;
		const parentChannel = this.validateParentCategory({
			parentId,
			channelType: params.data.type,
			channels,
		});
		if (parentId) {
			await this.ensureCategoryHasCapacity({guildId: params.guildId, categoryId: parentId});
		}
		const newPosition = ChannelHelpers.getNextGlobalChannelPosition(params.data.type, parentId, channels);
		let permissionOverwrites: Map<RoleID | UserID, PermissionOverwrite> | null = null;
		const requestedOverwrites = params.data.permission_overwrites ?? null;
		if (requestedOverwrites) {
			const canManageRoles = await this.gatewayService.checkPermission({
				guildId: params.guildId,
				userId: params.userId,
				permission: Permissions.MANAGE_ROLES,
			});
			if (!canManageRoles) throw new MissingPermissionsError();
			const basePermissions = await this.gatewayService.getUserPermissions({
				guildId: params.guildId,
				userId: params.userId,
				channelId: parentId ?? undefined,
			});
			for (const overwrite of requestedOverwrites) {
				const allowPerms = (overwrite.allow ? BigInt(overwrite.allow) : 0n) & ALL_PERMISSIONS;
				if ((allowPerms & ~basePermissions) !== 0n) {
					throw new MissingPermissionsError();
				}
			}
			permissionOverwrites = new Map(
				requestedOverwrites.map((overwrite) => {
					const targetId = overwrite.type === 0 ? createRoleID(overwrite.id) : createUserID(overwrite.id);
					return [
						targetId,
						new ChannelPermissionOverwrite({
							type: overwrite.type,
							allow_: overwrite.allow ? BigInt(overwrite.allow) : 0n,
							deny_: overwrite.deny ? BigInt(overwrite.deny) : 0n,
						}).toPermissionOverwrite(),
					];
				}),
			);
		} else if (parentChannel?.permissionOverwrites) {
			permissionOverwrites = new Map(
				Array.from(parentChannel.permissionOverwrites.entries()).map(([targetId, overwrite]) => [
					targetId,
					overwrite.toPermissionOverwrite(),
				]),
			);
		}
		let channelName = params.data.name;
		let guildFeatures: Array<string> | null = null;
		if (params.data.type === ChannelTypes.GUILD_TEXT || params.data.type === ChannelTypes.GUILD_VOICE) {
			const guildData = await this.gatewayService.getGuildData({
				guildId: params.guildId,
				userId: params.userId,
			});
			guildFeatures = guildData.features;
		}
		if (params.data.type === ChannelTypes.GUILD_TEXT) {
			const hasFlexibleNamesEnabled = (guildFeatures ?? []).includes(GuildFeatures.TEXT_CHANNEL_FLEXIBLE_NAMES);
			if (!hasFlexibleNamesEnabled) {
				channelName = ChannelNameType.parse(channelName);
			}
		}
		const requestedNsfwOverride =
			params.data.nsfw_override !== undefined ? params.data.nsfw_override : (params.data.nsfw ?? null);
		const requestedContentWarningLevel =
			params.data.content_warning_level === ContentWarningLevel.CONTENT_WARNING
				? ContentWarningLevel.CONTENT_WARNING
				: ContentWarningLevel.INHERIT;
		const trimmedContentWarningText =
			params.data.content_warning_text == null ? null : params.data.content_warning_text.trim();
		const requestedContentWarningText =
			trimmedContentWarningText && trimmedContentWarningText.length > 0 ? trimmedContentWarningText : null;
		const channelId = createChannelID(await this.snowflakeService.generate());
		// Echowire: forum channels carry available_tags (each tag gets a server-assigned snowflake id),
		// a default reaction, and a default sort order.
		let forumAvailableTags: Array<{id: string; name: string; emoji_name: string | null}> | null = null;
		let forumDefaultReaction: {emoji_id: string | null; emoji_name: string | null} | null = null;
		let forumDefaultSortOrder: number | null = null;
		let forumDefaultAutoArchive: number | null = null;
		let forumRequireTag: boolean | null = null;
		let forumDefaultLayout: number | null = null;
		let forumDefaultThreadRateLimit: number | null = null;
		if (params.data.type === ChannelTypes.GUILD_FORUM) {
			const tags = params.data.available_tags ?? [];
			forumAvailableTags = await Promise.all(
				tags.map(async (tag) => ({
					id: tag.id ?? (await this.snowflakeService.generate()).toString(),
					name: tag.name,
					emoji_name: tag.emoji_name ?? null,
				})),
			);
			forumDefaultReaction = params.data.default_reaction_emoji
				? {
						emoji_id: params.data.default_reaction_emoji.emoji_id ?? null,
						emoji_name: params.data.default_reaction_emoji.emoji_name ?? null,
					}
				: null;
			forumDefaultSortOrder = params.data.default_sort_order ?? null;
			forumDefaultAutoArchive = params.data.default_auto_archive_duration ?? null;
			forumRequireTag = params.data.require_tag ?? false;
			forumDefaultLayout = params.data.default_forum_layout ?? null;
			forumDefaultThreadRateLimit = params.data.default_thread_rate_limit_per_user ?? null;
		}
		const channel = await this.channelRepository.upsert({
			channel_id: channelId,
			guild_id: params.guildId,
			type: params.data.type,
			name: channelName,
			topic: params.data.topic ?? null,
			icon_hash: null,
			url: params.data.url ?? null,
			parent_id: parentId,
			position: newPosition,
			owner_id: null,
			recipient_ids: null,
			nsfw: requestedNsfwOverride,
			content_warning_level: requestedContentWarningLevel,
			content_warning_text: requestedContentWarningText,
			rate_limit_per_user: params.data.rate_limit_per_user ?? 0,
			bitrate:
				params.data.type === ChannelTypes.GUILD_VOICE
					? resolveVoiceChannelBitrate(params.data.bitrate, guildFeatures)
					: null,
			user_limit: params.data.type === ChannelTypes.GUILD_VOICE ? (params.data.user_limit ?? 0) : null,
			voice_connection_limit:
				params.data.type === ChannelTypes.GUILD_VOICE
					? (params.data.voice_connection_limit ?? VOICE_CHANNEL_CONNECTION_LIMIT_DEFAULT)
					: null,
			rtc_region: null,
			last_message_id: null,
			last_pin_timestamp: null,
			permission_overwrites: permissionOverwrites,
			nicks: null,
			...NULL_THREAD_FIELDS,
			available_tags: forumAvailableTags,
			default_reaction_emoji: forumDefaultReaction,
			default_sort_order: forumDefaultSortOrder,
			forum_default_auto_archive_duration: forumDefaultAutoArchive,
			forum_require_tag: forumRequireTag,
			default_forum_layout: forumDefaultLayout,
			default_thread_rate_limit_per_user: forumDefaultThreadRateLimit,
			soft_deleted: false,
			indexed_at: null,
			version: 1,
		});
		await this.dispatchChannelCreate({guildId: params.guildId, channel, requestCache: params.requestCache});
		await this.recordAuditLog({
			guildId: params.guildId,
			userId: params.userId,
			action: AuditLogActionType.CHANNEL_CREATE,
			targetId: channel.id,
			auditLogReason: auditLogReason ?? null,
			metadata: {name: channel.name ?? '', type: channel.type.toString()},
			changes: this.guildAuditLogService.computeChanges(null, ChannelHelpers.serializeChannelForAudit(channel)),
		});
		if (channel.permissionOverwrites.size > 0) {
			await this.guildAuditLogService.recordPermissionOverwriteDiff({
				guildId: params.guildId,
				userId: params.userId,
				channelId: channel.id,
				previous: null,
				next: channel.permissionOverwrites,
				reason: auditLogReason ?? null,
			});
		}
		return await mapChannelToResponse({
			channel,
			currentUserId: null,
			userCacheService: this.userCacheService,
			requestCache: params.requestCache,
		});
	}

	// Echowire: create a thread under a text/forum parent channel.
	async createThread(params: {
		userId: UserID;
		parentChannelId: ChannelID;
		data: ThreadCreateRequest;
		requestCache: RequestCache;
	}): Promise<ChannelResponse> {
		const parent = await this.channelRepository.findUnique(params.parentChannelId);
		if (!parent || parent.isSoftDeleted || !parent.guildId) {
			throw new UnknownChannelError();
		}
		if (parent.type !== ChannelTypes.GUILD_TEXT && parent.type !== ChannelTypes.GUILD_FORUM) {
			throw new UnknownChannelError();
		}
		const guildId = parent.guildId;
		// Echowire: creating a thread needs VIEW_CHANNEL and SEND_MESSAGES on the parent channel itself,
		// honouring its overwrites, not just the guild-level grant.
		const parentPermissions = await this.gatewayService.getUserPermissions({
			guildId,
			userId: params.userId,
			channelId: parent.id,
		});
		if (!hasPermissionBits(parentPermissions, Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES)) {
			throw new MissingPermissionsError();
		}
		// Echowire: forum posts may carry applied_tags, but only IDs defined in the forum's
		// available_tags are valid. Reject unknown tags (and reject tags on non-forum threads).
		if (params.data.applied_tags && params.data.applied_tags.length > 0) {
			if (parent.type !== ChannelTypes.GUILD_FORUM) {
				throw InputValidationError.fromCode('applied_tags', ValidationErrorCodes.FORUM_TAG_INVALID);
			}
			const validTagIds = new Set((parent.availableTags ?? []).map((tag) => tag.id));
			if (!params.data.applied_tags.every((tagId) => validTagIds.has(tagId))) {
				throw InputValidationError.fromCode('applied_tags', ValidationErrorCodes.FORUM_TAG_INVALID);
			}
		}
		// Echowire: a forum that requires a tag rejects tagless posts.
		if (
			parent.type === ChannelTypes.GUILD_FORUM &&
			parent.forumRequireTag &&
			(!params.data.applied_tags || params.data.applied_tags.length === 0)
		) {
			throw InputValidationError.fromCode('applied_tags', ValidationErrorCodes.FORUM_TAG_REQUIRED);
		}
		const threadType = params.data.type ?? ChannelTypes.PUBLIC_THREAD;
		const now = new Date();
		// Echowire: when starting a thread from a message, the thread adopts the source
		// message's ID (Discord semantics) so the message can render an inline link to it.
		// If a thread already exists for that message, return it idempotently.
		let channelId: ChannelID;
		if (params.data.message_id != null) {
			// SECURITY: the client supplies message_id and we adopt it as the new channel's
			// ID, so we must verify it actually names a real message in THIS parent channel.
			// Otherwise a caller could squat an arbitrary snowflake (e.g. collide a thread's
			// ID with an unrelated message/resource, making a bogus inline thread link appear
			// under it). The SEND_MESSAGES check above already gates who may create threads
			// here; this gates which IDs they may claim.
			const messageId = createMessageID(BigInt(params.data.message_id));
			channelId = createChannelID(BigInt(params.data.message_id));
			const existing = await this.channelRepository.findUnique(channelId);
			if (existing && !existing.isSoftDeleted) {
				if (existing.parentId !== params.parentChannelId || !THREAD_CHANNEL_TYPES.has(existing.type)) {
					throw new UnknownChannelError();
				}
				// Echowire: the idempotent path must not hand back a private thread the caller cannot see,
				// nor confirm it exists: answer as if no thread were there.
				const canAccessExisting = await canAccessPrivateThread({
					channel: existing,
					userId: params.userId,
					parentPermissions,
					threadMemberRepository: this.threadMemberRepository,
				});
				if (!canAccessExisting) {
					throw new UnknownChannelError();
				}
				return mapChannelToResponse({
					channel: existing,
					currentUserId: null,
					userCacheService: this.userCacheService,
					requestCache: params.requestCache,
				});
			}
			const message = await this.channelRepository.getMessage(params.parentChannelId, messageId);
			if (!message) {
				throw new UnknownMessageError();
			}
		} else {
			channelId = createChannelID(await this.snowflakeService.generate());
		}
		// Echowire: a forum's own slowmode limits how often a member may open new posts. Checked after
		// every validation, so a rejected request does not use up the member's slowmode window.
		await this.enforceForumPostSlowmode(parent, params.userId, parentPermissions);
		const channel = await this.channelRepository.upsert({
			channel_id: channelId,
			guild_id: guildId,
			type: threadType,
			name: params.data.name,
			topic: null,
			icon_hash: null,
			url: null,
			parent_id: params.parentChannelId,
			position: 0,
			owner_id: params.userId,
			recipient_ids: null,
			nsfw: parent.nsfwOverride,
			content_warning_level: parent.contentWarningLevel,
			content_warning_text: parent.contentWarningText,
			// Echowire: forum posts take the forum's per-post default; threads in a text channel keep
			// copying the parent's slowmode.
			rate_limit_per_user:
				parent.type === ChannelTypes.GUILD_FORUM
					? (parent.defaultThreadRateLimitPerUser ?? 0)
					: parent.rateLimitPerUser,
			bitrate: null,
			user_limit: null,
			voice_connection_limit: null,
			rtc_region: null,
			last_message_id: null,
			last_pin_timestamp: null,
			permission_overwrites: null,
			nicks: null,
			thread_archived: false,
			thread_auto_archive_duration: params.data.auto_archive_duration ?? parent.forumDefaultAutoArchiveDuration ?? 1440,
			thread_archive_timestamp: now,
			thread_locked: false,
			thread_invitable: threadType === ChannelTypes.PRIVATE_THREAD,
			thread_create_timestamp: now,
			thread_member_count: 1,
			thread_message_count: 0,
			thread_pinned: false,
			available_tags: null,
			applied_tags: params.data.applied_tags ?? null,
			default_reaction_emoji: null,
			default_sort_order: null,
			forum_default_auto_archive_duration: null,
			forum_require_tag: null,
			default_forum_layout: null,
			default_thread_rate_limit_per_user: null,
			soft_deleted: false,
			indexed_at: null,
			version: 1,
		});
		const response = await mapChannelToResponse({
			channel,
			currentUserId: null,
			userCacheService: this.userCacheService,
			requestCache: params.requestCache,
		});
		// Echowire: the creator auto-joins the thread (member_count was seeded to 1 on the row above)
		// before THREAD_CREATE, so a private thread's creator is already a member when the gateway
		// filters the event. Clients learn about the join the same way as any other.
		const creatorMember = await this.threadMemberRepository.addMember(channelId, params.userId);
		await this.gatewayService.dispatchGuild({
			guildId,
			event: 'THREAD_CREATE',
			data: await withPrivateThreadMemberIds({
				channel,
				response,
				threadMemberRepository: this.threadMemberRepository,
			}),
		});
		await this.gatewayService.dispatchGuild({
			guildId,
			event: 'THREAD_MEMBERS_UPDATE',
			data: {
				id: channelId.toString(),
				guild_id: guildId.toString(),
				member_count: 1,
				added_members: [
					{
						id: channelId.toString(),
						user_id: params.userId.toString(),
						join_timestamp: creatorMember.joinTimestamp.toISOString(),
						flags: creatorMember.flags,
					},
				],
			},
		});
		// Echowire: drop a "started a thread" system message in the parent channel (Discord
		// parity). Best-effort — a failure here must not fail thread creation. Private threads are
		// not announced: the message would reveal the thread's id and creator to every parent viewer.
		if (threadType !== ChannelTypes.PRIVATE_THREAD) {
			try {
				await this.messageSystemService.sendThreadCreatedSystemMessage({
					parentChannelId: params.parentChannelId,
					threadChannelId: channelId,
					userId: params.userId,
					guildId,
					requestCache: params.requestCache,
				});
			} catch {
				// ignore — the thread is already created and dispatched.
			}
		}
		return response;
	}

	// Echowire: list active (non-archived) threads under a text/forum channel.
	async listActiveThreads(params: {
		userId: UserID;
		parentChannelId: ChannelID;
		requestCache: RequestCache;
	}): Promise<Array<ChannelResponse>> {
		const parent = await this.channelRepository.findUnique(params.parentChannelId);
		if (!parent || parent.isSoftDeleted || !parent.guildId) {
			throw new UnknownChannelError();
		}
		const parentPermissions = await this.gatewayService.getUserPermissions({
			guildId: parent.guildId,
			userId: params.userId,
			channelId: parent.id,
		});
		if (!hasPermissionBits(parentPermissions, Permissions.VIEW_CHANNEL)) {
			throw new MissingPermissionsError();
		}
		const channels = await this.channelRepository.listGuildChannels(parent.guildId);
		const threads = channels.filter(
			(channel) =>
				channel.parentId === params.parentChannelId &&
				THREAD_CHANNEL_TYPES.has(channel.type) &&
				!channel.threadMetadata?.archived,
		);
		const visibleThreads = await this.filterVisibleThreads(threads, params.userId, parentPermissions);
		return this.mapThreadsWithPreview(visibleThreads, params.requestCache, () =>
			hasPermissionBits(parentPermissions, Permissions.READ_MESSAGE_HISTORY),
		);
	}

	// Echowire: every active thread in the guild the caller can view, plus the caller's memberships,
	// for sidebar nesting. Access follows the same parent-channel and private-thread rules.
	async listGuildActiveThreads(params: {
		userId: UserID;
		guildId: GuildID;
		requestCache: RequestCache;
	}): Promise<GuildActiveThreadsResponse> {
		const isMember = await this.gatewayService.hasGuildMember({guildId: params.guildId, userId: params.userId});
		if (!isMember) {
			throw new UnknownGuildError();
		}
		const channels = await this.channelRepository.listGuildChannels(params.guildId);
		const activeThreads = channels.filter(
			(channel) =>
				THREAD_CHANNEL_TYPES.has(channel.type) && !channel.isSoftDeleted && !channel.threadMetadata?.archived,
		);
		const parentPermissions = new Map<ChannelID, bigint>();
		const liveChannelIds = new Set(channels.filter((channel) => !channel.isSoftDeleted).map((channel) => channel.id));
		const visible: Array<Channel> = [];
		for (const thread of activeThreads) {
			// Echowire: a thread whose parent is gone is inaccessible.
			if (!thread.parentId || !liveChannelIds.has(thread.parentId)) {
				continue;
			}
			let permissions = parentPermissions.get(thread.parentId);
			if (permissions === undefined) {
				permissions = await this.gatewayService.getUserPermissions({
					guildId: params.guildId,
					userId: params.userId,
					channelId: thread.parentId,
				});
				parentPermissions.set(thread.parentId, permissions);
			}
			if (!hasPermissionBits(permissions, Permissions.VIEW_CHANNEL)) {
				continue;
			}
			const canAccess = await canAccessPrivateThread({
				channel: thread,
				userId: params.userId,
				parentPermissions: permissions,
				threadMemberRepository: this.threadMemberRepository,
			});
			if (canAccess) {
				visible.push(thread);
			}
		}
		const memberships = await Promise.all(
			visible.map((thread) => this.threadMemberRepository.getMember(thread.id, params.userId)),
		);
		return {
			threads: await this.mapThreadsWithPreview(visible, params.requestCache, (thread) =>
				hasPermissionBits(parentPermissions.get(thread.parentId!) ?? 0n, Permissions.READ_MESSAGE_HISTORY),
			),
			members: memberships.flatMap((member) =>
				member
					? [
							{
								id: member.threadId.toString(),
								user_id: member.userId.toString(),
								join_timestamp: member.joinTimestamp.toISOString(),
								flags: member.flags,
							},
						]
					: [],
			),
		};
	}

	// Echowire: the starter preview carries message content, so it is included only when the caller
	// may read message history in the thread's parent channel. canReadHistory answers per parent.
	private async mapThreadsWithPreview(
		threads: Array<Channel>,
		requestCache: RequestCache,
		canReadHistory: (thread: Channel) => boolean,
	): Promise<Array<ChannelResponse>> {
		return Promise.all(
			threads.map(async (channel) => {
				const response = await mapChannelToResponse({
					channel,
					currentUserId: null,
					userCacheService: this.userCacheService,
					requestCache,
				});
				if (canReadHistory(channel)) {
					response.starter_message_preview = await this.buildStarterMessagePreview(channel, requestCache);
				}
				return response;
			}),
		);
	}

	// Echowire: a thread started from a message shares that message's id and its starter lives in the
	// parent; any other thread (every forum post) uses its own first message.
	private async buildStarterMessagePreview(
		thread: Channel,
		requestCache: RequestCache,
	): Promise<ThreadStarterMessagePreviewResponse | null> {
		try {
			const threadIdAsMessage = createMessageID(BigInt(thread.id));
			let message: Message | null = thread.parentId
				? await this.channelRepository.getMessage(thread.parentId, threadIdAsMessage)
				: null;
			if (!message) {
				const [first] = await this.channelRepository.listMessages(thread.id, undefined, 1, threadIdAsMessage);
				message = first ?? null;
			}
			if (!message) {
				return null;
			}
			const author = message.authorId
				? await this.userCacheService.getUserPartialResponse(message.authorId, requestCache)
				: null;
			const attachment = message.attachments[0];
			return {
				message_id: message.id.toString(),
				author: author
					? {id: author.id, username: author.username, global_name: author.global_name, avatar: author.avatar}
					: null,
				content: (message.content ?? '').slice(0, STARTER_PREVIEW_MAX_LENGTH),
				first_attachment: attachment
					? {
							id: attachment.id.toString(),
							filename: attachment.filename,
							url: makeAttachmentCdnUrl(message.channelId, attachment.id, attachment.filename),
							proxy_url: null,
							content_type: attachment.contentType ?? null,
							width: attachment.width,
							height: attachment.height,
						}
					: null,
			};
		} catch (error) {
			Logger.warn({error, threadId: thread.id.toString()}, 'Failed to build starter message preview');
			return null;
		}
	}

	// Echowire: list archived threads under a text/forum channel.
	async listArchivedThreads(params: {
		userId: UserID;
		parentChannelId: ChannelID;
		requestCache: RequestCache;
	}): Promise<Array<ChannelResponse>> {
		const parent = await this.channelRepository.findUnique(params.parentChannelId);
		if (!parent || parent.isSoftDeleted || !parent.guildId) {
			throw new UnknownChannelError();
		}
		const parentPermissions = await this.gatewayService.getUserPermissions({
			guildId: parent.guildId,
			userId: params.userId,
			channelId: parent.id,
		});
		if (!hasPermissionBits(parentPermissions, Permissions.VIEW_CHANNEL)) {
			throw new MissingPermissionsError();
		}
		const channels = await this.channelRepository.listGuildChannels(parent.guildId);
		const threads = channels.filter(
			(channel) =>
				channel.parentId === params.parentChannelId &&
				THREAD_CHANNEL_TYPES.has(channel.type) &&
				channel.threadMetadata?.archived === true,
		);
		const visibleThreads = await this.filterVisibleThreads(threads, params.userId, parentPermissions);
		return this.mapThreadsWithPreview(visibleThreads, params.requestCache, () =>
			hasPermissionBits(parentPermissions, Permissions.READ_MESSAGE_HISTORY),
		);
	}

	// Echowire: update a thread (name / archived / locked / auto-archive / invitable).
	async updateThread(params: {
		userId: UserID;
		threadChannelId: ChannelID;
		data: ThreadUpdateRequest;
		requestCache: RequestCache;
	}): Promise<ChannelResponse> {
		const thread = await this.channelRepository.findUnique(params.threadChannelId);
		if (!thread || thread.isSoftDeleted || !thread.guildId || !THREAD_CHANNEL_TYPES.has(thread.type)) {
			throw new UnknownChannelError();
		}
		// Echowire: the caller must be able to see the thread, and then be its owner or hold
		// MANAGE_CHANNELS on the parent channel.
		const {isModerator} = await this.assertCanManageThread(thread, params.userId);
		const row = thread.toRow();
		const {data} = params;
		// Echowire: owners may rename, retag, change auto-archive, and close or reopen their own
		// unlocked thread. Locking, pinning, invitability, and any edit at all to a locked thread are
		// for moderators only.
		if (!isModerator) {
			const moderatorOnlyChange =
				row.thread_locked === true ||
				data.locked !== undefined ||
				data.pinned !== undefined ||
				data.invitable !== undefined;
			if (moderatorOnlyChange) {
				throw new MissingPermissionsError();
			}
		}
		// Echowire: editing a forum post's tags — validate against the parent forum's available_tags.
		let appliedTags = row.applied_tags;
		if (data.applied_tags !== undefined) {
			if (data.applied_tags.length > 0) {
				const parent = thread.parentId ? await this.channelRepository.findUnique(thread.parentId) : null;
				if (!parent || parent.type !== ChannelTypes.GUILD_FORUM) {
					throw InputValidationError.fromCode('applied_tags', ValidationErrorCodes.FORUM_TAG_INVALID);
				}
				const validTagIds = new Set((parent.availableTags ?? []).map((tag) => tag.id));
				if (!data.applied_tags.every((tagId) => validTagIds.has(tagId))) {
					throw InputValidationError.fromCode('applied_tags', ValidationErrorCodes.FORUM_TAG_INVALID);
				}
			}
			appliedTags = data.applied_tags.length > 0 ? data.applied_tags : null;
		}
		const archivedChanged = data.archived !== undefined && data.archived !== row.thread_archived;
		// Echowire: write only the fields this request changes. Upserting the whole row read above
		// would roll back anything written since, such as last_message_id, the message and member
		// counts, or an unarchive triggered by a concurrent send.
		await this.channelRepository.channelData.patchThreadFields(thread.id, {
			name: data.name,
			thread_archived: data.archived,
			thread_locked: data.locked,
			thread_auto_archive_duration: data.auto_archive_duration,
			thread_invitable: data.invitable,
			thread_archive_timestamp: archivedChanged ? new Date() : undefined,
			thread_pinned: data.pinned,
			applied_tags: data.applied_tags !== undefined ? appliedTags : undefined,
		});
		const channel = await this.channelRepository.findUnique(thread.id);
		if (!channel) {
			throw new UnknownChannelError();
		}
		const response = await mapChannelToResponse({
			channel,
			currentUserId: null,
			userCacheService: this.userCacheService,
			requestCache: params.requestCache,
		});
		await this.gatewayService.dispatchGuild({
			guildId: thread.guildId,
			event: 'THREAD_UPDATE',
			data: await withPrivateThreadMemberIds({
				channel,
				response,
				threadMemberRepository: this.threadMemberRepository,
			}),
		});
		if (data.pinned === true && !row.thread_pinned) {
			await this.unpinOtherForumPosts(channel, params.requestCache);
		}
		return response;
	}

	// Echowire: a forum shows a single pinned post, so pinning one unpins the rest.
	private async unpinOtherForumPosts(pinned: Channel, requestCache: RequestCache): Promise<void> {
		if (!pinned.guildId || !pinned.parentId) {
			return;
		}
		const parent = await this.channelRepository.findUnique(pinned.parentId);
		if (!parent || parent.type !== ChannelTypes.GUILD_FORUM) {
			return;
		}
		const channels = await this.channelRepository.listGuildChannels(pinned.guildId);
		const others = channels.filter(
			(channel) =>
				channel.id !== pinned.id &&
				channel.parentId === pinned.parentId &&
				THREAD_CHANNEL_TYPES.has(channel.type) &&
				channel.pinned,
		);
		for (const other of others) {
			await this.channelRepository.channelData.patchThreadFields(other.id, {thread_pinned: false});
			const unpinned = await this.channelRepository.findUnique(other.id);
			if (!unpinned) {
				continue;
			}
			const data = await mapChannelToResponse({
				channel: unpinned,
				currentUserId: null,
				userCacheService: this.userCacheService,
				requestCache,
			});
			await this.gatewayService.dispatchGuild({
				guildId: pinned.guildId,
				event: 'THREAD_UPDATE',
				data: await withPrivateThreadMemberIds({
					channel: unpinned,
					response: data,
					threadMemberRepository: this.threadMemberRepository,
				}),
			});
		}
	}

	// Echowire: delete a thread.
	async deleteThread(params: {userId: UserID; threadChannelId: ChannelID}): Promise<void> {
		const thread = await this.channelRepository.findUnique(params.threadChannelId);
		if (!thread || thread.isSoftDeleted || !thread.guildId || !THREAD_CHANNEL_TYPES.has(thread.type)) {
			throw new UnknownChannelError();
		}
		await this.assertCanManageThread(thread, params.userId);
		await this.channelRepository.delete(thread.id, thread.guildId);
		// Echowire: a deleted thread keeps no membership rows behind.
		await this.threadMemberRepository.removeAllMembers(thread.id);
		await this.gatewayService.dispatchGuild({
			guildId: thread.guildId,
			event: 'THREAD_DELETE',
			data: {
				id: thread.id.toString(),
				guild_id: thread.guildId.toString(),
				parent_id: thread.parentId ? thread.parentId.toString() : null,
				type: thread.type,
			},
		});
	}

	// Echowire: recompute member_count from the membership table and persist it on the thread.
	private async syncThreadMemberCount(threadChannelId: ChannelID): Promise<number> {
		const thread = await this.channelRepository.findUnique(threadChannelId);
		if (!thread || !THREAD_CHANNEL_TYPES.has(thread.type)) {
			return 0;
		}
		const members = await this.threadMemberRepository.listMembers(threadChannelId);
		const count = members.length;
		await this.channelRepository.channelData.patchThreadFields(threadChannelId, {thread_member_count: count});
		return count;
	}

	// Echowire: join the current user (or auto-join an actor) to a thread. Idempotent.
	async joinThread(params: {threadChannelId: ChannelID; userId: UserID; silent?: boolean}): Promise<void> {
		const thread = await this.channelRepository.findUnique(params.threadChannelId);
		if (!thread || thread.isSoftDeleted || !thread.guildId || !THREAD_CHANNEL_TYPES.has(thread.type)) {
			throw new UnknownChannelError();
		}
		const parentPermissions = await getThreadParentPermissions({
			gatewayService: this.gatewayService,
			channelRepository: this.channelRepository,
			guildId: thread.guildId,
			channel: thread,
			userId: params.userId,
		});
		// Echowire: joining needs VIEW_CHANNEL on the parent channel, even for an existing member.
		if (!hasPermissionBits(parentPermissions, Permissions.VIEW_CHANNEL)) {
			throw new MissingPermissionsError();
		}
		const existing = await this.threadMemberRepository.getMember(params.threadChannelId, params.userId);
		if (existing) {
			return;
		}
		// Echowire: nobody can add themselves to a private thread unless they manage the parent channel.
		if (
			thread.type === ChannelTypes.PRIVATE_THREAD &&
			!hasPermissionBits(parentPermissions, Permissions.MANAGE_CHANNELS)
		) {
			throw new MissingPermissionsError();
		}
		const member = await this.threadMemberRepository.addMember(params.threadChannelId, params.userId);
		const count = await this.syncThreadMemberCount(params.threadChannelId);
		await this.gatewayService.dispatchGuild({
			guildId: thread.guildId,
			event: 'THREAD_MEMBERS_UPDATE',
			data: {
				id: thread.id.toString(),
				guild_id: thread.guildId.toString(),
				member_count: count,
				added_members: [
					{
						id: thread.id.toString(),
						user_id: params.userId.toString(),
						join_timestamp: member.joinTimestamp.toISOString(),
						flags: member.flags,
					},
				],
			},
		});
	}

	// Echowire: leave a thread.
	async leaveThread(params: {threadChannelId: ChannelID; userId: UserID}): Promise<void> {
		const thread = await this.channelRepository.findUnique(params.threadChannelId);
		if (!thread || thread.isSoftDeleted || !thread.guildId || !THREAD_CHANNEL_TYPES.has(thread.type)) {
			throw new UnknownChannelError();
		}
		const existing = await this.threadMemberRepository.getMember(params.threadChannelId, params.userId);
		if (!existing) {
			return;
		}
		await this.threadMemberRepository.removeMember(params.threadChannelId, params.userId);
		const count = await this.syncThreadMemberCount(params.threadChannelId);
		await this.gatewayService.dispatchGuild({
			guildId: thread.guildId,
			event: 'THREAD_MEMBERS_UPDATE',
			data: {
				id: thread.id.toString(),
				guild_id: thread.guildId.toString(),
				member_count: count,
				removed_member_ids: [params.userId.toString()],
			},
		});
	}

	// Echowire: list the members of a thread (requires VIEW_CHANNEL).
	async listThreadMembers(params: {
		threadChannelId: ChannelID;
		userId: UserID;
	}): Promise<Array<{user_id: string; join_timestamp: string; flags: number}>> {
		const thread = await this.channelRepository.findUnique(params.threadChannelId);
		if (!thread || thread.isSoftDeleted || !thread.guildId || !THREAD_CHANNEL_TYPES.has(thread.type)) {
			throw new UnknownChannelError();
		}
		const canView = await canViewThread({
			gatewayService: this.gatewayService,
			channelRepository: this.channelRepository,
			threadMemberRepository: this.threadMemberRepository,
			guildId: thread.guildId,
			channel: thread,
			userId: params.userId,
		});
		if (!canView) {
			throw new MissingPermissionsError();
		}
		const members = await this.threadMemberRepository.listMembers(params.threadChannelId);
		return members.map((member) => ({
			user_id: member.userId.toString(),
			join_timestamp: member.joinTimestamp.toISOString(),
			flags: member.flags,
		}));
	}

	// Echowire: forum post-creation slowmode, applied the way message slowmode is: the shared rate
	// limiter, bots exempt, BYPASS_SLOWMODE exempt.
	private async enforceForumPostSlowmode(parent: Channel, userId: UserID, parentPermissions: bigint): Promise<void> {
		if (parent.type !== ChannelTypes.GUILD_FORUM || parent.rateLimitPerUser <= 0) {
			return;
		}
		if (hasPermissionBits(parentPermissions, Permissions.BYPASS_SLOWMODE)) {
			return;
		}
		const user = await this.userRepository.findUnique(userId);
		if (user?.isBot) {
			return;
		}
		const result = await this.rateLimitService.checkLimit({
			identifier: `forum-post-slowmode:${parent.id}:${userId}`,
			maxAttempts: 1,
			windowMs: parent.rateLimitPerUser * 1000,
			algorithm: 'leaky_bucket',
		});
		if (!result.allowed) {
			throw new SlowmodeRateLimitError({
				retryAfter: result.retryAfter,
				retryAfterDecimal: result.retryAfterDecimal,
			});
		}
	}

	// Echowire: drop private threads the caller is neither a member of nor a manager of.
	private async filterVisibleThreads(
		threads: Array<Channel>,
		userId: UserID,
		parentPermissions: bigint,
	): Promise<Array<Channel>> {
		const visible = await Promise.all(
			threads.map((channel) =>
				canAccessPrivateThread({
					channel,
					userId,
					parentPermissions,
					threadMemberRepository: this.threadMemberRepository,
				}),
			),
		);
		return threads.filter((_, index) => visible[index]);
	}

	// Echowire: thread moderation. The caller must see the thread, then own it or hold
	// MANAGE_CHANNELS on the parent channel.
	private async assertCanManageThread(thread: Channel, userId: UserID): Promise<{isModerator: boolean}> {
		const guildId = thread.guildId!;
		const parentPermissions = await getThreadParentPermissions({
			gatewayService: this.gatewayService,
			channelRepository: this.channelRepository,
			guildId,
			channel: thread,
			userId,
		});
		const canView = await canViewThread({
			gatewayService: this.gatewayService,
			channelRepository: this.channelRepository,
			threadMemberRepository: this.threadMemberRepository,
			guildId,
			channel: thread,
			userId,
			parentPermissions,
		});
		if (!canView) {
			throw new MissingPermissionsError();
		}
		const isModerator = hasPermissionBits(parentPermissions, Permissions.MANAGE_CHANNELS);
		if (!isModerator && thread.ownerId !== userId) {
			throw new MissingPermissionsError();
		}
		return {isModerator};
	}

	async updateChannelPositionsLocked(params: {
		userId: UserID;
		guildId: GuildID;
		operation: ChannelReorderOperation;
		requestCache: RequestCache;
	}): Promise<void> {
		const lockKey = `guild:${params.guildId}:channel-positions`;
		const lockToken = await this.cacheService.acquireLock(lockKey, 30);
		if (!lockToken) {
			throw new ResourceLockedError();
		}
		try {
			await this.executeChannelReorder(params);
		} finally {
			await this.cacheService.releaseLock(lockKey, lockToken);
		}
	}

	async sanitizeTextChannelNames(params: {guildId: GuildID; requestCache: RequestCache}): Promise<void> {
		const {guildId, requestCache} = params;
		const channels = await this.channelRepository.listGuildChannels(guildId);
		let hasChanges = false;
		const updatedChannels: Array<Channel> = [];
		for (const channel of channels) {
			if (channel.type !== ChannelTypes.GUILD_TEXT || channel.name == null) {
				updatedChannels.push(channel);
				continue;
			}
			const normalized = ChannelNameType.parse(channel.name);
			if (normalized === channel.name) {
				updatedChannels.push(channel);
				continue;
			}
			const updated = await this.channelRepository.upsert({
				...channel.toRow(),
				name: normalized,
			});
			updatedChannels.push(updated);
			hasChanges = true;
		}
		if (hasChanges) {
			await this.dispatchChannelUpdateBulk({guildId, channels: updatedChannels, requestCache});
		}
	}

	async updateChannelPositionsByList(params: {
		userId: UserID;
		guildId: GuildID;
		updates: Array<{
			channelId: ChannelID;
			position?: number;
			parentId: ChannelID | null | undefined;
			precedingSiblingId: ChannelID | null | undefined;
			lockPermissions: boolean;
		}>;
		requestCache: RequestCache;
		auditLogReason: string | null;
	}): Promise<void> {
		const {guildId, userId, updates, requestCache} = params;
		const lockKey = `guild:${guildId}:channel-positions`;
		const lockToken = await this.cacheService.acquireLock(lockKey, 30);
		if (!lockToken) {
			throw new ResourceLockedError();
		}
		try {
			const allChannels = await this.channelRepository.listGuildChannels(guildId);
			const channelMap = new Map(allChannels.map((ch) => [ch.id, ch]));
			for (const update of updates) {
				if (!channelMap.has(update.channelId)) {
					throw InputValidationError.fromCode('id', ValidationErrorCodes.CHANNEL_NOT_FOUND);
				}
				if (update.parentId && !channelMap.has(update.parentId)) {
					throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.INVALID_PARENT_CHANNEL);
				}
				if (update.precedingSiblingId && !channelMap.has(update.precedingSiblingId)) {
					throw InputValidationError.fromCode('preceding_sibling_id', ValidationErrorCodes.INVALID_CHANNEL_ID, {
						channelId: update.precedingSiblingId.toString(),
					});
				}
			}
			for (const update of updates) {
				await this.applySinglePositionUpdate({
					guildId,
					userId,
					update,
					requestCache,
				});
			}
		} finally {
			await this.cacheService.releaseLock(lockKey, lockToken);
		}
	}

	private async applySinglePositionUpdate(params: {
		guildId: GuildID;
		userId: UserID;
		update: {
			channelId: ChannelID;
			position?: number;
			parentId: ChannelID | null | undefined;
			precedingSiblingId: ChannelID | null | undefined;
			lockPermissions: boolean;
		};
		requestCache: RequestCache;
	}): Promise<void> {
		const {guildId, update, requestCache} = params;
		const allChannels = await this.channelRepository.listGuildChannels(guildId);
		const channelMap = new Map(allChannels.map((ch) => [ch.id, ch]));
		const target = channelMap.get(update.channelId);
		if (!target) {
			throw InputValidationError.fromCode('id', ValidationErrorCodes.CHANNEL_NOT_FOUND);
		}
		const desiredParent = update.parentId === undefined ? (target.parentId ?? null) : update.parentId;
		if (desiredParent && !channelMap.has(desiredParent)) {
			throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.INVALID_PARENT_CHANNEL);
		}
		if (desiredParent) {
			const parentChannel = channelMap.get(desiredParent)!;
			if (parentChannel.type !== ChannelTypes.GUILD_CATEGORY) {
				throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.PARENT_MUST_BE_CATEGORY);
			}
		}
		if (target.type === ChannelTypes.GUILD_CATEGORY && desiredParent) {
			throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.CATEGORIES_CANNOT_HAVE_PARENTS);
		}
		let precedingSibling = update.precedingSiblingId ?? null;
		if (update.precedingSiblingId === undefined) {
			const orderedChannels = sortChannelsForOrdering(allChannels);
			const siblings = orderedChannels.filter((ch) => (ch.parentId ?? null) === desiredParent);
			const blockIds = computeChannelMoveBlockIds({channels: orderedChannels, targetId: target.id});
			const siblingsWithoutBlock = siblings.filter((ch) => !blockIds.has(ch.id));
			let insertIndex = siblingsWithoutBlock.length;
			if (update.position !== undefined) {
				const adjustedPosition = Math.max(update.position, 0);
				insertIndex = Math.min(adjustedPosition, siblingsWithoutBlock.length);
			} else {
				const isVoice = target.type === ChannelTypes.GUILD_VOICE;
				if (isVoice) {
					insertIndex = siblingsWithoutBlock.length;
				} else {
					const firstVoice = siblingsWithoutBlock.findIndex((ch) => ch.type === ChannelTypes.GUILD_VOICE);
					insertIndex = firstVoice === -1 ? siblingsWithoutBlock.length : firstVoice;
				}
			}
			precedingSibling = insertIndex === 0 ? null : siblingsWithoutBlock[insertIndex - 1].id;
		}
		await this.executeChannelReorder({
			guildId,
			operation: {
				channelId: target.id,
				parentId: desiredParent,
				precedingSiblingId: precedingSibling,
			},
			requestCache,
		});
		if (update.lockPermissions && desiredParent && desiredParent !== (target.parentId ?? null)) {
			await this.syncPermissionsWithParent({
				guildId,
				userId: params.userId,
				channelId: target.id,
				parentId: desiredParent,
			});
		}
	}

	private async syncPermissionsWithParent(params: {
		guildId: GuildID;
		userId: UserID;
		channelId: ChannelID;
		parentId: ChannelID;
	}): Promise<void> {
		const parent = await this.channelRepository.findUnique(params.parentId);
		if (!parent || parent.guildId !== params.guildId || parent.type !== ChannelTypes.GUILD_CATEGORY) return;
		const child = await this.channelRepository.findUnique(params.channelId);
		if (!child || child.guildId !== params.guildId) return;
		const userPermissions = await this.gatewayService.getUserPermissions({
			guildId: params.guildId,
			userId: params.userId,
			channelId: child.id,
		});
		if ((userPermissions & Permissions.MANAGE_ROLES) === 0n) {
			throw new MissingPermissionsError();
		}
		for (const [targetId, existing] of child.permissionOverwrites) {
			const incomingDeny = parent.permissionOverwrites.get(targetId)?.deny ?? 0n;
			if ((existing.deny & ~incomingDeny & ~userPermissions) !== 0n) throw new MissingPermissionsError();
		}
		for (const [targetId, incoming] of parent.permissionOverwrites) {
			const existingAllow = child.permissionOverwrites.get(targetId)?.allow ?? 0n;
			if ((incoming.allow & ~existingAllow & ~userPermissions) !== 0n) throw new MissingPermissionsError();
		}
		await this.channelRepository.upsert({
			...child.toRow(),
			permission_overwrites: new Map(
				Array.from(parent.permissionOverwrites.entries()).map(([targetId, overwrite]) => [
					targetId,
					overwrite.toPermissionOverwrite(),
				]),
			),
		});
	}

	private async executeChannelReorder(params: {
		guildId: GuildID;
		operation: ChannelReorderOperation;
		requestCache: RequestCache;
	}): Promise<void> {
		const {guildId, operation, requestCache} = params;
		const allChannels = await this.channelRepository.listGuildChannels(guildId);
		const planResult = computeGuildChannelReorderPlan({channels: allChannels, operation});
		if (!planResult.ok) {
			this.throwReorderPlanError(planResult.code, operation);
		}
		const {plan} = planResult;
		const desiredParentId = plan.desiredParentById.get(operation.channelId) ?? null;
		const targetChannel = allChannels.find((ch) => ch.id === operation.channelId);
		const currentParentId = targetChannel?.parentId ?? null;
		const parentIdsToValidate = new Set<ChannelID>();
		if (currentParentId) {
			parentIdsToValidate.add(currentParentId);
		}
		if (desiredParentId) {
			parentIdsToValidate.add(desiredParentId);
		}
		if (desiredParentId && desiredParentId !== currentParentId) {
			await this.ensureCategoryHasCapacity({guildId, categoryId: desiredParentId});
		}
		ChannelHelpers.validateChannelVoicePlacement(
			plan.finalChannels,
			plan.desiredParentById,
			parentIdsToValidate,
			operation.channelId,
		);
		if (plan.orderUnchanged) {
			return;
		}
		const updatePromises: Array<Promise<void>> = [];
		for (let index = 0; index < plan.finalChannels.length; index++) {
			const channel = plan.finalChannels[index];
			const desiredPosition = index + 1;
			const desiredParent = plan.desiredParentById.get(channel.id) ?? null;
			const currentParent = channel.parentId ?? null;
			if (channel.position !== desiredPosition || currentParent !== desiredParent) {
				updatePromises.push(
					this.channelRepository
						.upsert({...channel.toRow(), position: desiredPosition, parent_id: desiredParent})
						.then(() => {}),
				);
			}
		}
		await Promise.all(updatePromises);
		const updatedChannels = await this.channelRepository.listGuildChannels(guildId);
		await this.dispatchChannelUpdateBulk({guildId, channels: updatedChannels, requestCache});
	}

	private throwReorderPlanError(code: GuildChannelReorderErrorCode, operation: ChannelReorderOperation): never {
		switch (code) {
			case 'TARGET_CHANNEL_NOT_FOUND':
				throw InputValidationError.fromCode('channel_id', ValidationErrorCodes.INVALID_CHANNEL_ID, {
					channelId: operation.channelId.toString(),
				});
			case 'CATEGORIES_CANNOT_HAVE_PARENTS':
				throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.CATEGORIES_CANNOT_HAVE_PARENT_CHANNEL);
			case 'PARENT_NOT_FOUND':
			case 'PARENT_NOT_CATEGORY':
				throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.INVALID_PARENT_CHANNEL);
			case 'PRECEDING_CHANNEL_NOT_FOUND':
				throw InputValidationError.fromCode('preceding_sibling_id', ValidationErrorCodes.INVALID_CHANNEL_ID, {
					channelId: String(operation.precedingSiblingId),
				});
			case 'CANNOT_POSITION_RELATIVE_TO_SELF_BLOCK':
				throw InputValidationError.fromCode(
					'preceding_sibling_id',
					ValidationErrorCodes.CANNOT_POSITION_CHANNEL_RELATIVE_TO_ITSELF,
				);
			case 'PRECEDING_PARENT_MISMATCH':
				throw InputValidationError.fromCode(
					'preceding_sibling_id',
					ValidationErrorCodes.PRECEDING_CHANNEL_MUST_SHARE_PARENT,
				);
			case 'PRECEDING_NOT_IN_GUILD_LIST':
				throw InputValidationError.fromCode(
					'preceding_sibling_id',
					ValidationErrorCodes.PRECEDING_CHANNEL_NOT_IN_GUILD,
				);
			case 'PARENT_NOT_IN_GUILD_LIST':
				throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.PARENT_CHANNEL_NOT_IN_GUILD);
		}
	}

	private validateParentCategory(params: {
		parentId: ChannelID | null;
		channelType: number;
		channels: Array<Channel>;
	}): Channel | null {
		if (params.parentId === null) {
			return null;
		}
		if (params.channelType === ChannelTypes.GUILD_CATEGORY) {
			throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.CATEGORIES_CANNOT_HAVE_PARENTS);
		}
		const parentChannel = params.channels.find((channel) => channel.id === params.parentId);
		if (!parentChannel) {
			throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.INVALID_PARENT_CHANNEL);
		}
		if (parentChannel.type !== ChannelTypes.GUILD_CATEGORY) {
			throw InputValidationError.fromCode('parent_id', ValidationErrorCodes.PARENT_MUST_BE_CATEGORY);
		}
		return parentChannel;
	}

	private async recordAuditLog(params: {
		guildId: GuildID;
		userId: UserID;
		action: AuditLogActionType;
		targetId?: GuildID | ChannelID | RoleID | UserID | EmojiID | StickerID | string | null;
		auditLogReason?: string | null;
		metadata?: Map<string, string> | Record<string, string>;
		changes?: GuildAuditLogChange | null;
		createdAt?: Date;
	}): Promise<void> {
		const targetId =
			params.targetId === undefined || params.targetId === null
				? null
				: typeof params.targetId === 'string'
					? params.targetId
					: params.targetId.toString();
		try {
			const builder = this.guildAuditLogService
				.createBuilder(params.guildId, params.userId)
				.withAction(params.action, targetId)
				.withReason(params.auditLogReason ?? null);
			if (params.metadata) {
				builder.withMetadata(params.metadata);
			}
			if (params.changes) {
				builder.withChanges(params.changes);
			}
			if (params.createdAt) {
				builder.withCreatedAt(params.createdAt);
			}
			await builder.commit();
		} catch (error) {
			Logger.error(
				{
					error,
					guildId: params.guildId.toString(),
					userId: params.userId.toString(),
					action: params.action,
					targetId,
				},
				'Failed to record guild audit log',
			);
		}
	}

	private async dispatchChannelCreate({
		guildId,
		channel,
		requestCache,
	}: {
		guildId: GuildID;
		channel: Channel;
		requestCache: RequestCache;
	}): Promise<void> {
		await this.gatewayService.dispatchGuild({
			guildId,
			event: 'CHANNEL_CREATE',
			data: await mapChannelToResponse({
				channel,
				currentUserId: null,
				userCacheService: this.userCacheService,
				requestCache,
			}),
		});
	}

	private async dispatchChannelUpdateBulk({
		guildId,
		channels,
		requestCache,
	}: {
		guildId: GuildID;
		channels: Array<Channel>;
		requestCache: RequestCache;
	}): Promise<void> {
		const channelResponses = await Promise.all(
			channels.map((channel) =>
				mapChannelToResponse({
					channel,
					currentUserId: null,
					userCacheService: this.userCacheService,
					requestCache,
				}),
			),
		);
		await this.gatewayService.dispatchGuild({
			guildId,
			event: 'CHANNEL_UPDATE_BULK',
			data: {channels: channelResponses},
		});
	}

	private async ensureCategoryHasCapacity(params: {guildId: GuildID; categoryId: ChannelID}): Promise<void> {
		const count = await this.gatewayService.getCategoryChannelCount(params);
		let maxChannels = MAX_CHANNELS_PER_CATEGORY;
		const guild = await this.guildRepository.findUnique(params.guildId);
		const ctx = createLimitMatchContext({user: null, guildFeatures: guild?.features ?? null});
		maxChannels = resolveLimitSafe(
			this.limitConfigService.getConfigSnapshot(),
			ctx,
			'max_channels_per_category',
			maxChannels,
		);
		if (count >= maxChannels) {
			throw new MaxCategoryChannelsError(maxChannels);
		}
	}

	private async ensureGuildHasCapacity(guildId: GuildID): Promise<void> {
		const count = await this.gatewayService.getChannelCount({guildId});
		let maxChannels = MAX_GUILD_CHANNELS;
		const guild = await this.guildRepository.findUnique(guildId);
		const ctx = createLimitMatchContext({user: null, guildFeatures: guild?.features ?? null});
		maxChannels = resolveLimitSafe(this.limitConfigService.getConfigSnapshot(), ctx, 'max_guild_channels', maxChannels);
		if (count >= maxChannels) {
			throw new MaxGuildChannelsError(maxChannels);
		}
	}
}
