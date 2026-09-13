// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: storage for thread membership (who has joined a thread / forum post).

import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import {deleteOneOrMany, fetchMany, fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {type ThreadMemberRow, ThreadMembers} from '@app/api/Tables';

const GET_MEMBER_QUERY = ThreadMembers.select({
	where: [ThreadMembers.where.eq('thread_id'), ThreadMembers.where.eq('user_id')],
});
const LIST_MEMBERS_QUERY = ThreadMembers.select({where: ThreadMembers.where.eq('thread_id')});

export interface ThreadMember {
	threadId: ChannelID;
	userId: UserID;
	joinTimestamp: Date;
	flags: number;
}

function mapRow(row: ThreadMemberRow): ThreadMember {
	return {
		threadId: row.thread_id as ChannelID,
		userId: row.user_id as UserID,
		joinTimestamp: row.join_timestamp,
		flags: row.flags,
	};
}

export class ThreadMemberRepository {
	async getMember(threadId: ChannelID, userId: UserID): Promise<ThreadMember | null> {
		const row = await fetchOne<ThreadMemberRow>(GET_MEMBER_QUERY.bind({thread_id: threadId, user_id: userId}));
		return row ? mapRow(row) : null;
	}

	async listMembers(threadId: ChannelID): Promise<Array<ThreadMember>> {
		const rows = await fetchMany<ThreadMemberRow>(LIST_MEMBERS_QUERY.bind({thread_id: threadId}));
		return rows.map(mapRow);
	}

	async addMember(threadId: ChannelID, userId: UserID, flags = 0): Promise<ThreadMember> {
		const row: ThreadMemberRow = {
			thread_id: threadId,
			user_id: userId,
			join_timestamp: new Date(),
			flags,
		};
		await upsertOne(ThreadMembers.insert(row));
		return mapRow(row);
	}

	async removeMember(threadId: ChannelID, userId: UserID): Promise<void> {
		await deleteOneOrMany(ThreadMembers.deleteByPk({thread_id: threadId, user_id: userId}));
	}
}
