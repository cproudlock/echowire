// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: who may add or remove thread members, mirroring the server rules in
// ChannelOperationsService.addThreadMember and removeThreadMember so the UI hides what the
// server would refuse.
//   Add: a moderator or the thread owner always; otherwise a private thread needs invitable
//         plus the actor already being a member, and a public thread needs send-in-threads.
//   Remove someone else: a moderator or the thread owner.
//   Remove yourself: any member, which the server routes to leave.

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';

export interface ThreadMemberActionInput {
	isOwner: boolean;
	canManage: boolean;
	isPrivate: boolean;
	invitable: boolean;
	isMember: boolean;
	canSendInThreads: boolean;
}

export interface ThreadMemberActions {
	canAdd: boolean;
	canRemoveOthers: boolean;
	canLeave: boolean;
}

export function resolveThreadMemberActions({
	isOwner,
	canManage,
	isPrivate,
	invitable,
	isMember,
	canSendInThreads,
}: ThreadMemberActionInput): ThreadMemberActions {
	const privileged = canManage || isOwner;
	const canAdd = privileged || (isPrivate ? invitable && isMember : canSendInThreads);
	return {
		canAdd,
		canRemoveOthers: privileged,
		canLeave: isMember,
	};
}

// Echowire: the server answers a member change with a specific code, and each one means something
// a person can act on, so they are not collapsed into one generic failure.
export type ThreadMemberFailure = 'cap' | 'unknown_member' | 'forbidden' | 'generic';

export function classifyThreadMemberFailure(code: string | undefined): ThreadMemberFailure {
	switch (code) {
		case APIErrorCodes.MAX_THREAD_MEMBERS:
			return 'cap';
		// The target cannot see the parent channel, so the server reports them as unknown rather
		// than confirming a member it will not add.
		case APIErrorCodes.UNKNOWN_MEMBER:
			return 'unknown_member';
		case APIErrorCodes.MISSING_PERMISSIONS:
			return 'forbidden';
		default:
			return 'generic';
	}
}
