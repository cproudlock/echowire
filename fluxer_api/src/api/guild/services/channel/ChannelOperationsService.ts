// SPDX-License-Identifier: AGPL-3.0-or-later

import {AuditLogActionType} from '@fluxer/constants/src/AuditLogActionType';
import {ALL_PERMISSIONS, ChannelTypes, Permissions, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {ContentWarningLevel, GuildFeatures} from '@fluxer/constants/src/GuildConstants';
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
import {MaxGuildChannelsError} from '@fluxer/errors/src/domains/guild/MaxGuildChannelsError';
import type {
	ChannelCreateRequest,
	ThreadCreateRequest,
	ThreadUpdateRequest,
} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {
	computeChannelMoveBlockIds,
	computeGuildChannelReorderPlan,
	type GuildChannelReorderErrorCode,
	sortChannelsForOrdering,
} from '@fluxer/schema/src/domains/channel/GuildChannelOrdering';
import {ChannelNameType} from '@fluxer/schema/src/primitives/ChannelValidators';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import type {ChannelID, EmojiID, GuildID, RoleID, StickerID, UserID} from '../../../BrandedTypes';
import {createChannelID, createMessageID, createRoleID, createUserID} from '../../../BrandedTypes';
import {mapChannelToResponse} from '../../../channel/ChannelMappers';
import type {IChannelRepository} from '../../../channel/IChannelRepository';
import {NULL_THREAD_FIELDS, type PermissionOverwrite} from '../../../database/types/ChannelTypes';
import type {IGatewayService} from '../../../infrastructure/IGatewayService';
import type {ISnowflakeService} from '../../../infrastructure/ISnowflakeService';
import type {UserCacheService} from '../../../infrastructure/UserCacheService';
import {Logger} from '../../../Logger';
import type {LimitConfigService} from '../../../limits/LimitConfigService';
import {resolveLimitSafe} from '../../../limits/LimitConfigUtils';
import {createLimitMatchContext} from '../../../limits/LimitMatchContextBuilder';
import type {MessageSystemService} from '../../../channel/services/message/MessageSystemService';
import type {RequestCache} from '../../../middleware/RequestCacheMiddleware';
import type {Channel} from '../../../models/Channel';
import {ChannelPermissionOverwrite} from '../../../models/ChannelPermissionOverwrite';
import type {GuildAuditLogService} from '../../GuildAuditLogService';
import type {GuildAuditLogChange} from '../../GuildAuditLogTypes';
import type {IGuildRepositoryAggregate} from '../../repositories/IGuildRepositoryAggregate';
import {ChannelHelpers, type ChannelReorderOperation} from './ChannelHelpers';

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
	) {}

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
		if (params.data.type === ChannelTypes.GUILD_TEXT) {
			const guildData = await this.gatewayService.getGuildData({
				guildId: params.guildId,
				userId: params.userId,
			});
			const hasFlexibleNamesEnabled = guildData.features.includes(GuildFeatures.TEXT_CHANNEL_FLEXIBLE_NAMES);
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
			rate_limit_per_user: 0,
			bitrate: params.data.type === ChannelTypes.GUILD_VOICE ? (params.data.bitrate ?? 64000) : null,
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
		const canSend = await this.gatewayService.checkPermission({
			guildId,
			userId: params.userId,
			permission: Permissions.SEND_MESSAGES,
		});
		if (!canSend) {
			throw new MissingPermissionsError();
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
			rate_limit_per_user: parent.rateLimitPerUser,
			bitrate: null,
			user_limit: null,
			voice_connection_limit: null,
			rtc_region: null,
			last_message_id: null,
			last_pin_timestamp: null,
			permission_overwrites: null,
			nicks: null,
			thread_archived: false,
			thread_auto_archive_duration: params.data.auto_archive_duration ?? 1440,
			thread_archive_timestamp: now,
			thread_locked: false,
			thread_invitable: threadType === ChannelTypes.PRIVATE_THREAD,
			thread_create_timestamp: now,
			thread_member_count: 1,
			thread_message_count: 0,
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
		await this.gatewayService.dispatchGuild({guildId, event: 'THREAD_CREATE', data: response});
		// Echowire: drop a "started a thread" system message in the parent channel (Discord
		// parity). Best-effort — a failure here must not fail thread creation.
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
		const canView = await this.gatewayService.checkPermission({
			guildId: parent.guildId,
			userId: params.userId,
			permission: Permissions.VIEW_CHANNEL,
		});
		if (!canView) {
			throw new MissingPermissionsError();
		}
		const channels = await this.channelRepository.listGuildChannels(parent.guildId);
		const threads = channels.filter(
			(channel) =>
				channel.parentId === params.parentChannelId &&
				THREAD_CHANNEL_TYPES.has(channel.type) &&
				!channel.threadMetadata?.archived,
		);
		return Promise.all(
			threads.map((channel) =>
				mapChannelToResponse({
					channel,
					currentUserId: null,
					userCacheService: this.userCacheService,
					requestCache: params.requestCache,
				}),
			),
		);
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
		const canView = await this.gatewayService.checkPermission({
			guildId: parent.guildId,
			userId: params.userId,
			permission: Permissions.VIEW_CHANNEL,
		});
		if (!canView) {
			throw new MissingPermissionsError();
		}
		const channels = await this.channelRepository.listGuildChannels(parent.guildId);
		const threads = channels.filter(
			(channel) =>
				channel.parentId === params.parentChannelId &&
				THREAD_CHANNEL_TYPES.has(channel.type) &&
				channel.threadMetadata?.archived === true,
		);
		return Promise.all(
			threads.map((channel) =>
				mapChannelToResponse({
					channel,
					currentUserId: null,
					userCacheService: this.userCacheService,
					requestCache: params.requestCache,
				}),
			),
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
		// Owner can edit; otherwise MANAGE_CHANNELS is required.
		if (thread.ownerId !== params.userId) {
			const canManage = await this.gatewayService.checkPermission({
				guildId: thread.guildId,
				userId: params.userId,
				permission: Permissions.MANAGE_CHANNELS,
			});
			if (!canManage) {
				throw new MissingPermissionsError();
			}
		}
		const row = thread.toRow();
		const {data} = params;
		const archivedChanged = data.archived !== undefined && data.archived !== row.thread_archived;
		const updatedRow = {
			...row,
			name: data.name ?? row.name,
			thread_archived: data.archived ?? row.thread_archived,
			thread_locked: data.locked ?? row.thread_locked,
			thread_auto_archive_duration: data.auto_archive_duration ?? row.thread_auto_archive_duration,
			thread_invitable: data.invitable ?? row.thread_invitable,
			thread_archive_timestamp: archivedChanged ? new Date() : row.thread_archive_timestamp,
		};
		const channel = await this.channelRepository.upsert(updatedRow);
		const response = await mapChannelToResponse({
			channel,
			currentUserId: null,
			userCacheService: this.userCacheService,
			requestCache: params.requestCache,
		});
		await this.gatewayService.dispatchGuild({guildId: thread.guildId, event: 'THREAD_UPDATE', data: response});
		return response;
	}

	// Echowire: delete a thread.
	async deleteThread(params: {userId: UserID; threadChannelId: ChannelID}): Promise<void> {
		const thread = await this.channelRepository.findUnique(params.threadChannelId);
		if (!thread || thread.isSoftDeleted || !thread.guildId || !THREAD_CHANNEL_TYPES.has(thread.type)) {
			throw new UnknownChannelError();
		}
		if (thread.ownerId !== params.userId) {
			const canManage = await this.gatewayService.checkPermission({
				guildId: thread.guildId,
				userId: params.userId,
				permission: Permissions.MANAGE_CHANNELS,
			});
			if (!canManage) {
				throw new MissingPermissionsError();
			}
		}
		await this.channelRepository.delete(thread.id, thread.guildId);
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
			await this.syncPermissionsWithParent({guildId, channelId: target.id, parentId: desiredParent});
		}
	}

	private async syncPermissionsWithParent(params: {
		guildId: GuildID;
		channelId: ChannelID;
		parentId: ChannelID;
	}): Promise<void> {
		const parent = await this.channelRepository.findUnique(params.parentId);
		if (!parent || parent.guildId !== params.guildId || parent.type !== ChannelTypes.GUILD_CATEGORY) return;
		const child = await this.channelRepository.findUnique(params.channelId);
		if (!child || child.guildId !== params.guildId) return;
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
