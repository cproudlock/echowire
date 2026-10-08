// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveThreadActions, resolveThreadComposerLocked} from '@app/features/channel/utils/ThreadActions';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => false}}));

describe('resolveThreadActions', () => {
	it('lets managers do everything', () => {
		expect(resolveThreadActions({isOwner: false, canManage: true, locked: true})).toEqual({
			canManage: true,
			canLock: true,
			canPin: true,
			canClose: true,
			canReopen: true,
			canEdit: true,
			canDelete: true,
			canSetSlowmode: true,
			canSetInvitable: true,
		});
	});

	it('lets the owner close, reopen, edit and delete an unlocked post but never lock or pin', () => {
		expect(resolveThreadActions({isOwner: true, canManage: false, locked: false})).toEqual({
			canManage: false,
			canLock: false,
			canPin: false,
			canClose: true,
			canReopen: true,
			canEdit: true,
			canDelete: true,
			canSetSlowmode: true,
			canSetInvitable: false,
		});
	});

	it('stops the owner reopening or editing a post a moderator locked', () => {
		const actions = resolveThreadActions({isOwner: true, canManage: false, locked: true});
		expect(actions.canReopen).toBe(false);
		expect(actions.canClose).toBe(false);
		expect(actions.canEdit).toBe(false);
		expect(actions.canSetSlowmode).toBe(false);
	});

	it('keeps invitability for managers only, even for the owner of an unlocked post', () => {
		expect(resolveThreadActions({isOwner: true, canManage: false, locked: false}).canSetInvitable).toBe(false);
		expect(resolveThreadActions({isOwner: false, canManage: true, locked: false}).canSetInvitable).toBe(true);
	});

	it('gives other members nothing', () => {
		const actions = resolveThreadActions({isOwner: false, canManage: false, locked: false});
		expect(Object.values(actions).every((value) => value === false)).toBe(true);
	});
});

describe('resolveThreadComposerLocked', () => {
	it('disables the composer in a locked thread for members who cannot moderate', () => {
		expect(resolveThreadComposerLocked({isThread: true, locked: true, canManage: false})).toBe(true);
	});

	it('leaves it enabled for moderators of a locked thread', () => {
		expect(resolveThreadComposerLocked({isThread: true, locked: true, canManage: true})).toBe(false);
	});

	it('leaves it enabled in an unlocked thread, and in channels that are not threads', () => {
		expect(resolveThreadComposerLocked({isThread: true, locked: false, canManage: false})).toBe(false);
		expect(resolveThreadComposerLocked({isThread: false, locked: true, canManage: false})).toBe(false);
	});
});
