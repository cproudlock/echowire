// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: who may do what to a thread or forum post, matching the forums server contract.
// MANAGE_CHANNELS is checked on the parent channel.
//   Lock, unlock, pin, unpin: managers only.
//   Close or reopen: managers, or the owner while the thread is unlocked.
//   Rename, edit tags, change auto-archive: managers, or the owner while the thread is unlocked.
//   Delete: managers or the owner.

import Authentication from '@app/features/auth/state/Authentication';
import type {Channel} from '@app/features/channel/models/Channel';
import Permission from '@app/features/permissions/state/Permission';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';

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
		canManage: Permission.can(Permissions.MANAGE_CHANNELS, {
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
