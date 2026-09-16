// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: who may do what to a thread or forum post, matching the forums server contract.
// MANAGE_CHANNELS is checked on the parent channel.
//   Lock, unlock, pin, unpin: managers only.
//   Close or reopen: managers, or the owner while the thread is unlocked.
//   Rename, edit tags, change auto-archive: managers, or the owner while the thread is unlocked.
// A manager here holds MANAGE_THREADS or MANAGE_CHANNELS on the parent, matching ThreadAccess.ts.
//   Delete: managers or the owner.

import Authentication from '@app/features/auth/state/Authentication';
import type {Channel} from '@app/features/channel/models/Channel';
import Permission from '@app/features/permissions/state/Permission';
import {Permissions, THREAD_PERMISSION_BITS} from '@fluxer/constants/src/ChannelConstants';

// Echowire: the client mirrors ThreadAccess.ts so the UI hides what the server would refuse.
// A resolved mask carrying no thread bit at all belongs to a role set written before those bits
// existed, and keeps the old rule: SEND_MESSAGES on the parent allowed both creating a thread and
// posting in one. Any thread bit present makes the bits authoritative.
interface ThreadPermissionContext {
	channelId: string;
	guildId?: string;
}

function parentMask(context: ThreadPermissionContext): bigint {
	return Permission.getChannelPermissions(context.channelId) ?? 0n;
}

function isLegacyMask(mask: bigint): boolean {
	return (mask & THREAD_PERMISSION_BITS) === 0n;
}

function has(mask: bigint, permission: bigint): boolean {
	return (mask & permission) === permission;
}

export function canModerateThreads(context: ThreadPermissionContext): boolean {
	return Permission.can(Permissions.MANAGE_THREADS, context) || Permission.can(Permissions.MANAGE_CHANNELS, context);
}

// Starting a thread in a text channel, or a post in a forum.
export function canCreatePublicThreadIn(context: ThreadPermissionContext): boolean {
	const mask = parentMask(context);
	if (has(mask, Permissions.CREATE_PUBLIC_THREADS)) {
		return true;
	}
	return isLegacyMask(mask) && has(mask, Permissions.SEND_MESSAGES);
}

// Replying inside a thread or forum post.
export function canSendInThreads(context: ThreadPermissionContext): boolean {
	const mask = parentMask(context);
	if (has(mask, Permissions.SEND_MESSAGES_IN_THREADS)) {
		return true;
	}
	return isLegacyMask(mask) && has(mask, Permissions.SEND_MESSAGES);
}

export interface ThreadActionInput {
	isOwner: boolean;
	canManage: boolean;
	locked: boolean;
}

export interface ThreadActions {
	canManage: boolean;
	canLock: boolean;
	canPin: boolean;
	canClose: boolean;
	canReopen: boolean;
	canEdit: boolean;
	canDelete: boolean;
}

export function resolveThreadActions({isOwner, canManage, locked}: ThreadActionInput): ThreadActions {
	const ownerOfUnlocked = isOwner && !locked;
	return {
		canManage,
		canLock: canManage,
		canPin: canManage,
		canClose: canManage || ownerOfUnlocked,
		canReopen: canManage || ownerOfUnlocked,
		canEdit: canManage || ownerOfUnlocked,
		canDelete: canManage || isOwner,
	};
}

export function getThreadActions(thread: Channel): ThreadActions {
	return resolveThreadActions({
		isOwner: thread.ownerId != null && thread.ownerId === Authentication.currentUserId,
		canManage: canModerateThreads({
			channelId: thread.parentId ?? thread.id,
			guildId: thread.guildId ?? undefined,
		}),
		locked: thread.threadMetadata?.locked === true,
	});
}

// Whether the archive (close or reopen) control applies to this thread for the current user.
export function canToggleThreadArchive(thread: Channel): boolean {
	const actions = getThreadActions(thread);
	return thread.threadMetadata?.archived ? actions.canReopen : actions.canClose;
}
