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
import {
	ChannelTypes,
	Permissions,
	THREAD_CHANNEL_TYPES,
	THREAD_PERMISSION_BITS,
} from '@fluxer/constants/src/ChannelConstants';
import {MAX_APPLIED_TAGS_PER_POST} from '@fluxer/constants/src/LimitConstants';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';

type ThreadLike = Pick<Channel, 'id' | 'type' | 'parentId'>;

interface ChannelLookup {
	findUnique(channelId: ChannelID): Promise<Channel | null>;
}

// A thread whose parent row is gone (or soft-deleted) has nothing to resolve permissions against.
// It is inaccessible to everyone; the orphan sweep deletes it.
export async function threadParentExists(channelRepository: ChannelLookup, channel: ThreadLike): Promise<boolean> {
	if (!isThreadChannel(channel)) {
		return true;
	}
	if (!channel.parentId) {
		return false;
	}
	const parent = await channelRepository.findUnique(channel.parentId);
	return parent !== null && !parent.isSoftDeleted;
}

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

// Echowire: threads have their own permissions (MANAGE_THREADS, CREATE_PUBLIC_THREADS,
// CREATE_PRIVATE_THREADS, SEND_MESSAGES_IN_THREADS), added after this instance was already live.
// Roles and overwrites written before then carry none of those bits, so a resolved mask with none
// of them means "this guild predates the bits" and the old rules still apply: SEND_MESSAGES on the
// parent allowed creating a thread and posting in one, MANAGE_CHANNELS allowed moderating one.
//
// The moment any thread bit appears anywhere in the resolution chain, the bits are authoritative
// and an explicit deny is honoured. Every guild created after this change starts that way, because
// DEFAULT_PERMISSIONS grants CREATE_PUBLIC_THREADS and SEND_MESSAGES_IN_THREADS, and an older guild
// joins them as soon as an admin touches any thread permission in its roles or overwrites.
function isLegacyThreadPermissionMask(permissions: bigint): boolean {
	return (permissions & THREAD_PERMISSION_BITS) === 0n;
}

// Moderating someone else's thread. MANAGE_CHANNELS is accepted for good, not only as a fallback:
// it is the permission every existing moderator setup uses, and it already implies control of the
// parent channel.
export function canModerateThreads(parentPermissions: bigint): boolean {
	return (
		hasPermissionBits(parentPermissions, Permissions.MANAGE_THREADS) ||
		hasPermissionBits(parentPermissions, Permissions.MANAGE_CHANNELS)
	);
}

// Echowire: a moderated forum tag may only be applied or removed by a member who can moderate
// threads. A caller without that permission neither adds one nor drops one: the moderated tags
// already on the post are preserved even when their replacement set omits them, so an owner
// retagging their own post cannot quietly strip a moderator's tag. Moderated tags take precedence
// when the merged set would exceed the per-post cap.
export function resolveAppliedTags(params: {
	requested: ReadonlyArray<string>;
	current: ReadonlyArray<string>;
	availableTags: ReadonlyArray<{id: string; moderated?: boolean | null}> | null;
	canModerate: boolean;
}): Array<string> {
	const requested = [...params.requested];
	if (params.canModerate) {
		return requested;
	}
	const moderatedIds = new Set(
		(params.availableTags ?? []).filter((tag) => tag.moderated === true).map((tag) => tag.id),
	);
	if (moderatedIds.size === 0) {
		return requested;
	}
	const alreadyApplied = new Set(params.current);
	if (requested.some((id) => moderatedIds.has(id) && !alreadyApplied.has(id))) {
		throw new MissingPermissionsError();
	}
	const preserved = params.current.filter((id) => moderatedIds.has(id) && !requested.includes(id));
	return [...preserved, ...requested].slice(0, MAX_APPLIED_TAGS_PER_POST);
}

export function canCreatePublicThread(parentPermissions: bigint): boolean {
	if (hasPermissionBits(parentPermissions, Permissions.CREATE_PUBLIC_THREADS)) {
		return true;
	}
	return (
		isLegacyThreadPermissionMask(parentPermissions) && hasPermissionBits(parentPermissions, Permissions.SEND_MESSAGES)
	);
}

// Private threads hide their contents, so there is no legacy grant: before the bits existed no
// client offered them. A moderator of the parent may always create one.
export function canCreatePrivateThread(parentPermissions: bigint): boolean {
	return (
		hasPermissionBits(parentPermissions, Permissions.CREATE_PRIVATE_THREADS) || canModerateThreads(parentPermissions)
	);
}

export function canSendInThread(parentPermissions: bigint): boolean {
	if (hasPermissionBits(parentPermissions, Permissions.SEND_MESSAGES_IN_THREADS)) {
		return true;
	}
	return (
		isLegacyThreadPermissionMask(parentPermissions) && hasPermissionBits(parentPermissions, Permissions.SEND_MESSAGES)
	);
}

// Inside a thread, a request for SEND_MESSAGES means SEND_MESSAGES_IN_THREADS: Discord's model lets
// a member talk in threads without talking in the parent channel, and the other way round. Every
// other bit resolves against the parent unchanged.
export function threadRequirementSatisfied(parentPermissions: bigint, required: bigint): boolean {
	const withoutSend = required & ~Permissions.SEND_MESSAGES;
	if (withoutSend !== 0n && !hasPermissionBits(parentPermissions, withoutSend)) {
		return false;
	}
	if ((required & Permissions.SEND_MESSAGES) === 0n) {
		return true;
	}
	return canSendInThread(parentPermissions);
}

// The gateway cannot look up thread membership, so a private thread's payload to it (THREAD_CREATE,
// THREAD_UPDATE, the guild channel collection) carries the member ids. Members are the only
// non-moderators who can view a private thread, and they can already list its members.
// Echowire: thread_member_ids is internal to the gateway, which uses it to deliver a private
// thread's events to its members, and guild_data_wire strips it before any client sees it. It is
// therefore not part of the public ChannelResponse schema.
type ThreadGatewayChannelPayload = ChannelResponse & {thread_member_ids?: ReadonlyArray<string>};

export async function withPrivateThreadMemberIds(params: {
	channel: Pick<Channel, 'id' | 'type'>;
	response: ChannelResponse;
	threadMemberRepository: ThreadMemberRepository;
}): Promise<ThreadGatewayChannelPayload> {
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
	if (canModerateThreads(parentPermissions)) {
		return true;
	}
	return (await threadMemberRepository.getMember(channel.id, userId)) !== null;
}

// The caller's permissions on the parent channel of a thread, or 0n when the parent is missing.
export async function getThreadParentPermissions(params: {
	gatewayService: IGatewayService;
	channelRepository: ChannelLookup;
	guildId: GuildID;
	channel: ThreadLike;
	userId: UserID;
}): Promise<bigint> {
	const {gatewayService, guildId, channel, userId} = params;
	const channelId = permissionChannelId(channel);
	if (!channelId || !(await threadParentExists(params.channelRepository, channel))) {
		return 0n;
	}
	return gatewayService.getUserPermissions({guildId, userId, channelId});
}

// Whether the caller may see this thread at all: VIEW_CHANNEL on the parent, plus the private gate.
export async function canViewThread(params: {
	gatewayService: IGatewayService;
	channelRepository: ChannelLookup;
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
