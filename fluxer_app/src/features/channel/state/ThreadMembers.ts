// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: client store for thread membership (who has joined each thread).

import Authentication from '@app/features/auth/state/Authentication';
import {action, makeObservable, observable} from 'mobx';

export interface ThreadMemberEntry {
	userId: string;
	joinTimestamp: string;
}

class ThreadMembers {
	// threadId -> members
	private readonly byThread = observable.map<string, Array<ThreadMemberEntry>>();

	constructor() {
		makeObservable(this);
	}

	getMembers(threadId: string): ReadonlyArray<ThreadMemberEntry> {
		return this.byThread.get(threadId) ?? [];
	}

	getMemberCount(threadId: string): number {
		return this.byThread.get(threadId)?.length ?? 0;
	}

	isMember(threadId: string, userId: string | null = Authentication.currentUserId): boolean {
		if (!userId) return false;
		return (this.byThread.get(threadId) ?? []).some((member) => member.userId === userId);
	}

	@action
	setMembers(threadId: string, members: Array<ThreadMemberEntry>): void {
		this.byThread.set(threadId, members);
	}

	@action
	addMember(threadId: string, member: ThreadMemberEntry): void {
		const existing = this.byThread.get(threadId);
		if (!existing) {
			this.byThread.set(threadId, [member]);
			return;
		}
		if (!existing.some((m) => m.userId === member.userId)) {
			this.byThread.set(threadId, [...existing, member]);
		}
	}

	@action
	removeMember(threadId: string, userId: string): void {
		const existing = this.byThread.get(threadId);
		if (existing) {
			this.byThread.set(
				threadId,
				existing.filter((m) => m.userId !== userId),
			);
		}
	}
}

export default new ThreadMembers();
