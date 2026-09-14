// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: per-user forum view state, persisted on this device. Holds the Sort & View override
// for each forum (unset means "use the channel default") and when each forum was last viewed,
// which drives the sidebar "N New" pill.

import type {ForumLayout, ForumSortOrder} from '@app/features/channel/utils/ForumPostUtils';
import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

export interface ForumViewOverride {
	sortOrder?: ForumSortOrder;
	layout?: Exclude<ForumLayout, 0>;
}

class ForumViewPreferences {
	overrides: Record<string, ForumViewOverride> = {};
	lastViewedAt: Record<string, number> = {};

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void this.initPersistence();
	}

	private async initPersistence(): Promise<void> {
		await makePersistent(this, 'ForumViewPreferences', ['overrides', 'lastViewedAt']);
	}

	getOverride(forumId: string): ForumViewOverride {
		return this.overrides[forumId] ?? {};
	}

	setSortOrder(forumId: string, sortOrder: ForumSortOrder): void {
		this.overrides = {...this.overrides, [forumId]: {...this.overrides[forumId], sortOrder}};
	}

	setLayout(forumId: string, layout: Exclude<ForumLayout, 0>): void {
		this.overrides = {...this.overrides, [forumId]: {...this.overrides[forumId], layout}};
	}

	resetOverride(forumId: string): void {
		const next = {...this.overrides};
		delete next[forumId];
		this.overrides = next;
	}

	getLastViewedAt(forumId: string): number | null {
		return this.lastViewedAt[forumId] ?? null;
	}

	markViewed(forumId: string, at: number = Date.now()): void {
		this.lastViewedAt = {...this.lastViewedAt, [forumId]: at};
	}
}

export default new ForumViewPreferences();
