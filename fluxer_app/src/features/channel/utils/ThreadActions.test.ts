// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveThreadActions} from '@app/features/channel/utils/ThreadActions';
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
		});
	});

	it('stops the owner reopening a post a moderator locked', () => {
		const actions = resolveThreadActions({isOwner: true, canManage: false, locked: true});
		expect(actions.canReopen).toBe(false);
		expect(actions.canClose).toBe(false);
		expect(actions.canEdit).toBe(true);
	});

	it('gives other members nothing', () => {
		const actions = resolveThreadActions({isOwner: false, canManage: false, locked: false});
		expect(Object.values(actions).every((value) => value === false)).toBe(true);
	});
});
