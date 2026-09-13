// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads and forum posts store no permission overwrites of their own. Every
// permission on a thread resolves against its parent channel, and a private thread is
// further limited to its members and to members who can manage the parent channel.
// The gateway applies the same rules when it filters thread events (see
// guild_permissions_overwrites.erl), so keep the two in step.

import type {ChannelID, GuildID, UserID} from '@app/api/BrandedTypes';
import type {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {Channel} from '@app/api/models/Channel';
import {ChannelTypes, Permissions, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';

type ThreadLike = Pick<Channel, 'id' | 'type' | 'parentId'>;

export function isThreadChannel(channel: Pick<Channel, 'type'>): boolean {
	return THREAD_CHANNEL_TYPES.has(channel.type);
}

// The channel whose overwrites govern access: the parent for a thread, the channel itself otherwise.
// Returns null for a thread with no parent, which must be treated as inaccessible.
export function permissionChannelId(channel: ThreadLike): ChannelID | null {
	if (!isThreadChannel(channel)) {
		return channel.id;
	}
	return channel.parentId ?? null;
}

export function hasPermissionBits(permissions: bigint, required: bigint): boolean {
	return (permissions & required) === required;
}

// The gateway cannot look up thread membership, so a private thread's payload to it (THREAD_CREATE,
// THREAD_UPDATE, the guild channel collection) carries the member ids. Members are the only
// non-moderators who can view a private thread, and they can already list its members.
export async function withPrivateThreadMemberIds(params: {
	channel: Pick<Channel, 'id' | 'type'>;
	response: ChannelResponse;
	threadMemberRepository: ThreadMemberRepository;
}): Promise<ChannelResponse> {
	const {channel, response, threadMemberRepository} = params;
	if (channel.type !== ChannelTypes.PRIVATE_THREAD) {
		return response;
	}
	const members = await threadMemberRepository.listMembers(channel.id);
	return {...response, thread_member_ids: members.map((member) => member.userId.toString())};
}

// Private-thread gate, given the caller's permissions on the parent channel.
export async function canAccessPrivateThread(params: {
	channel: Pick<Channel, 'id' | 'type'>;
	userId: UserID;
	parentPermissions: bigint;
	threadMemberRepository: ThreadMemberRepository;
}): Promise<boolean> {
	const {channel, userId, parentPermissions, threadMemberRepository} = params;
	if (channel.type !== ChannelTypes.PRIVATE_THREAD) {
		return true;
	}
	if (hasPermissionBits(parentPermissions, Permissions.MANAGE_CHANNELS)) {
		return true;
	}
	return (await threadMemberRepository.getMember(channel.id, userId)) !== null;
}

// The caller's permissions on the parent channel of a thread, or 0n when it has no parent.
export async function getThreadParentPermissions(params: {
	gatewayService: IGatewayService;
	guildId: GuildID;
	channel: ThreadLike;
	userId: UserID;
}): Promise<bigint> {
	const {gatewayService, guildId, channel, userId} = params;
	const channelId = permissionChannelId(channel);
	if (!channelId) {
		return 0n;
	}
	return gatewayService.getUserPermissions({guildId, userId, channelId});
}

// Whether the caller may see this thread at all: VIEW_CHANNEL on the parent, plus the private gate.
export async function canViewThread(params: {
	gatewayService: IGatewayService;
	threadMemberRepository: ThreadMemberRepository;
	guildId: GuildID;
	channel: ThreadLike;
	userId: UserID;
	parentPermissions?: bigint;
}): Promise<boolean> {
	const parentPermissions = params.parentPermissions ?? (await getThreadParentPermissions(params));
	if (!hasPermissionBits(parentPermissions, Permissions.VIEW_CHANNEL)) {
		return false;
	}
	return canAccessPrivateThread({
		channel: params.channel,
		userId: params.userId,
		parentPermissions,
		threadMemberRepository: params.threadMemberRepository,
	});
}
