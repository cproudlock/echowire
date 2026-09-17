// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	classifyThreadMemberFailure,
	resolveThreadMemberActions,
	type ThreadMemberActionInput,
} from '@app/features/channel/utils/ThreadMemberActions';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {describe, expect, test} from 'vitest';

function input(overrides: Partial<ThreadMemberActionInput> = {}): ThreadMemberActionInput {
	return {
		isOwner: false,
		canManage: false,
		isPrivate: false,
		invitable: false,
		isMember: false,
		canSendInThreads: false,
		...overrides,
	};
}

describe('resolveThreadMemberActions', () => {
	test('a moderator may add and remove anyone', () => {
		expect(resolveThreadMemberActions(input({canManage: true}))).toEqual({
			canAdd: true,
			canRemoveOthers: true,
			canLeave: false,
		});
	});

	test('the thread owner may add and remove anyone', () => {
		expect(resolveThreadMemberActions(input({isOwner: true}))).toEqual({
			canAdd: true,
			canRemoveOthers: true,
			canLeave: false,
		});
	});

	test('a member of a public thread may add others when they can post in threads', () => {
		const actions = resolveThreadMemberActions(input({canSendInThreads: true, isMember: true}));
		expect(actions.canAdd).toBe(true);
		expect(actions.canRemoveOthers).toBe(false);
		expect(actions.canLeave).toBe(true);
	});

	test('a public thread refuses an adder who cannot post in threads', () => {
		expect(resolveThreadMemberActions(input({isMember: true})).canAdd).toBe(false);
	});

	test('a private thread needs invitable and membership, not send permission', () => {
		expect(
			resolveThreadMemberActions(input({isPrivate: true, invitable: true, isMember: true, canSendInThreads: false}))
				.canAdd,
		).toBe(true);
		expect(
			resolveThreadMemberActions(input({isPrivate: true, invitable: false, isMember: true, canSendInThreads: true}))
				.canAdd,
		).toBe(false);
		expect(
			resolveThreadMemberActions(input({isPrivate: true, invitable: true, isMember: false, canSendInThreads: true}))
				.canAdd,
		).toBe(false);
	});

	test('only a member may leave', () => {
		expect(resolveThreadMemberActions(input({isMember: true})).canLeave).toBe(true);
		expect(resolveThreadMemberActions(input({canManage: true, isMember: false})).canLeave).toBe(false);
	});
});

describe('classifyThreadMemberFailure', () => {
	test('names the cases a person can act on', () => {
		expect(classifyThreadMemberFailure(APIErrorCodes.MAX_THREAD_MEMBERS)).toBe('cap');
		expect(classifyThreadMemberFailure(APIErrorCodes.UNKNOWN_MEMBER)).toBe('unknown_member');
		expect(classifyThreadMemberFailure(APIErrorCodes.MISSING_PERMISSIONS)).toBe('forbidden');
	});

	test('falls back to generic for anything else', () => {
		expect(classifyThreadMemberFailure(undefined)).toBe('generic');
		expect(classifyThreadMemberFailure('SOMETHING_ELSE')).toBe('generic');
	});
});
