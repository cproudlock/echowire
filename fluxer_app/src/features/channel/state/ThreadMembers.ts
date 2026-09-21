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
		makeObservable(this, {
			setMembers: action,
			addMember: action,
			handleGatewayReady: action,
			removeMember: action,
		});
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

	setMembers(threadId: string, members: Array<ThreadMemberEntry>): void {
		this.byThread.set(threadId, members);
	}

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

	// Echowire: the caller's own memberships from the session payload. Each row names one thread
	// the caller has joined, so it is merged in as a self-membership rather than a full member list:
	// READY says nothing about who else is in a thread.
	handleGatewayReady(rows: ReadonlyArray<{id: string; user_id: string; join_timestamp: string}>): void {
		const currentUserId = Authentication.currentUserId;
		if (!currentUserId) return;
		for (const [threadId, members] of this.byThread.entries()) {
			const withoutSelf = members.filter((member) => member.userId !== currentUserId);
			if (withoutSelf.length === 0) {
				this.byThread.delete(threadId);
			} else if (withoutSelf.length !== members.length) {
				this.byThread.set(threadId, withoutSelf);
			}
		}
		for (const row of rows) {
			this.addMember(row.id, {userId: row.user_id, joinTimestamp: row.join_timestamp});
		}
	}

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
