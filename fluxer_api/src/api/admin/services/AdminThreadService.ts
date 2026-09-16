// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads and forum posts are channels, so no part of the admin surface knew they
// existed. This service lists them under their parent channel and gives an instance admin the
// three moderation actions that matter: archive, lock, and a delete that purges the content
// rather than orphaning it (the user-facing delete path shares purgeThread for the same reason).

import type {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import {createChannelID} from '@app/api/BrandedTypes';
import {mapChannelToResponse} from '@app/api/channel/ChannelMappers';
import type {IChannelRepository} from '@app/api/channel/IChannelRepository';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import type {ChannelService} from '@app/api/channel/services/ChannelService';
import {withPrivateThreadMemberIds} from '@app/api/channel/services/ThreadAccess';
import {canParentThreads, purgeThread, threadsOfParent} from '@app/api/channel/services/ThreadPurge';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {Channel} from '@app/api/models/Channel';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import type {
	AdminThreadResponse,
	AdminThreadSummary,
	ListChannelThreadsResponse,
	UpdateAdminThreadRequest,
} from '@fluxer/schema/src/domains/admin/AdminThreadSchemas';
import type {SuccessResponse} from '@fluxer/schema/src/domains/common/CommonParamSchemas';

interface AdminThreadServiceDeps {
	channelRepository: IChannelRepository;
	channelService: ChannelService;
	gatewayService: IGatewayService;
	userCacheService: UserCacheService;
	auditService: AdminAuditService;
}

function toIsoString(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

export class AdminThreadService {
	private readonly threadMemberRepository = new ThreadMemberRepository();

	constructor(private readonly deps: AdminThreadServiceDeps) {}

	private summarize(thread: Channel, parent: Channel | null): AdminThreadSummary {
		return {
			id: thread.id.toString(),
			guild_id: thread.guildId?.toString() ?? '',
			parent_id: thread.parentId?.toString() ?? null,
			parent_name: parent?.name ?? null,
			name: thread.name,
			type: thread.type,
			owner_id: thread.ownerId?.toString() ?? null,
			archived: thread.threadMetadata?.archived ?? false,
			locked: thread.threadMetadata?.locked ?? false,
			pinned: thread.pinned,
			message_count: thread.messageCount,
			member_count: thread.memberCount,
			auto_archive_duration: thread.threadMetadata?.autoArchiveDuration ?? null,
			archive_timestamp: toIsoString(thread.threadMetadata?.archiveTimestamp),
			create_timestamp: toIsoString(thread.threadMetadata?.createTimestamp),
			applied_tags: thread.appliedTags,
		};
	}

	private async loadThread(channelId: bigint): Promise<{thread: Channel; parent: Channel | null}> {
		const {channelRepository} = this.deps;
		const thread = await channelRepository.findUnique(createChannelID(channelId));
		if (!thread || !THREAD_CHANNEL_TYPES.has(thread.type) || !thread.guildId) {
			throw new UnknownChannelError();
		}
		const parent = thread.parentId ? await channelRepository.findUnique(thread.parentId) : null;
		return {thread, parent};
	}

	async listChannelThreads(data: {
		channel_id: bigint;
		adminUserId: UserID;
		auditLogReason: string | null;
	}): Promise<ListChannelThreadsResponse> {
		const {channelRepository, auditService} = this.deps;
		const parent = await channelRepository.findUnique(createChannelID(data.channel_id));
		if (!parent || !parent.guildId) {
			throw new UnknownChannelError();
		}
		if (!canParentThreads(parent)) {
			await auditService.createAuditLog({
				adminUserId: data.adminUserId,
				targetType: 'channel',
				targetId: parent.id,
				action: 'list_channel_threads',
				auditLogReason: data.auditLogReason,
				metadata: new Map<string, string>([['result_count', '0']]),
			});
			return {threads: []};
		}
		const guildChannels = await channelRepository.listGuildChannels(parent.guildId);
		const threads = threadsOfParent(guildChannels, parent.id).sort((left, right) =>
			left.id === right.id ? 0 : left.id > right.id ? -1 : 1,
		);
		await auditService.createAuditLog({
			adminUserId: data.adminUserId,
			targetType: 'channel',
			targetId: parent.id,
			action: 'list_channel_threads',
			auditLogReason: data.auditLogReason,
			metadata: new Map<string, string>([['result_count', threads.length.toString()]]),
		});
		return {threads: threads.map((thread) => this.summarize(thread, parent))};
	}

	async updateThread(data: {
		channel_id: bigint;
		body: UpdateAdminThreadRequest;
		adminUserId: UserID;
		auditLogReason: string | null;
	}): Promise<AdminThreadResponse> {
		const {channelRepository, gatewayService, userCacheService, auditService} = this.deps;
		const {thread, parent} = await this.loadThread(data.channel_id);
		const archivedChanged = data.body.archived !== undefined && data.body.archived !== thread.threadMetadata?.archived;
		await channelRepository.channelData.patchThreadFields(thread.id, {
			thread_archived: data.body.archived,
			thread_locked: data.body.locked,
			thread_archive_timestamp: archivedChanged ? new Date() : undefined,
		});
		const updated = await channelRepository.findUnique(thread.id);
		if (!updated) {
			throw new UnknownChannelError();
		}
		const response = await mapChannelToResponse({
			channel: updated,
			currentUserId: null,
			userCacheService,
			requestCache: createRequestCache(),
		});
		await gatewayService.dispatchGuild({
			guildId: updated.guildId!,
			event: 'THREAD_UPDATE',
			data: await withPrivateThreadMemberIds({
				channel: updated,
				response,
				threadMemberRepository: this.threadMemberRepository,
			}),
		});
		const metadata = new Map<string, string>([['thread_name', updated.name ?? '']]);
		if (data.body.archived !== undefined) {
			metadata.set('archived', String(data.body.archived));
		}
		if (data.body.locked !== undefined) {
			metadata.set('locked', String(data.body.locked));
		}
		await auditService.createAuditLog({
			adminUserId: data.adminUserId,
			targetType: 'thread',
			targetId: updated.id,
			action: 'thread_update',
			auditLogReason: data.auditLogReason,
			metadata,
		});
		return {thread: this.summarize(updated, parent)};
	}

	async deleteThread(data: {
		channel_id: bigint;
		adminUserId: UserID;
		auditLogReason: string | null;
	}): Promise<SuccessResponse> {
		const {channelRepository, channelService, gatewayService, auditService} = this.deps;
		const {thread} = await this.loadThread(data.channel_id);
		const guildId = thread.guildId!;
		await purgeThread({
			thread,
			guildId,
			deleteMessages: (id: ChannelID) => channelRepository.messages.deleteAllChannelMessages(id),
			deleteChannelRow: (id: ChannelID, gid) => channelRepository.channelData.delete(id, gid),
			purgeAttachments: (target: Channel) => channelService.attachments.purgeChannelAttachments(target),
			threadMemberRepository: this.threadMemberRepository,
			gatewayService,
			source: 'admin_thread_delete',
		});
		await auditService.createAuditLog({
			adminUserId: data.adminUserId,
			targetType: 'thread',
			targetId: thread.id,
			action: 'thread_delete',
			auditLogReason: data.auditLogReason,
			metadata: new Map<string, string>([
				['thread_name', thread.name ?? ''],
				['guild_id', guildId.toString()],
				['parent_id', thread.parentId?.toString() ?? ''],
			]),
		});
		return {success: true};
	}
}
