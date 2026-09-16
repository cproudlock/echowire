// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: storage for thread membership (who has joined a thread / forum post).
//
// Membership is written twice: once partitioned by thread, so a thread can list its members, and
// once partitioned by user (thread_members_by_user), so a user can be told which threads they
// belong to. Without the second index nothing can answer that question without walking every
// thread of every guild, which is what the thread list endpoints, account deletion and the data
// export each had to do. Both writes go through this repository, so they cannot drift apart.

import type {ChannelID, GuildID, UserID} from '@app/api/BrandedTypes';
import {deleteOneOrMany, fetchMany, fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {type ThreadMemberByUserRow, type ThreadMemberRow, ThreadMembers, ThreadMembersByUser} from '@app/api/Tables';

const GET_MEMBER_QUERY = ThreadMembers.select({
	where: [ThreadMembers.where.eq('thread_id'), ThreadMembers.where.eq('user_id')],
});
const LIST_MEMBERS_QUERY = ThreadMembers.select({where: ThreadMembers.where.eq('thread_id')});
const LIST_BY_USER_QUERY = ThreadMembersByUser.select({where: ThreadMembersByUser.where.eq('user_id')});

export interface ThreadMember {
	threadId: ChannelID;
	userId: UserID;
	joinTimestamp: Date;
	flags: number;
}

export interface ThreadMembershipForUser extends ThreadMember {
	guildId: GuildID | null;
}

function mapRow(row: ThreadMemberRow): ThreadMember {
	return {
		threadId: row.thread_id as ChannelID,
		userId: row.user_id as UserID,
		joinTimestamp: row.join_timestamp,
		flags: row.flags,
	};
}

function mapByUserRow(row: ThreadMemberByUserRow): ThreadMembershipForUser {
	return {
		threadId: row.thread_id as ChannelID,
		userId: row.user_id as UserID,
		joinTimestamp: row.join_timestamp,
		flags: row.flags,
		guildId: row.guild_id === null ? null : (row.guild_id as GuildID),
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

	// Every thread this user has joined, across guilds, from the by-user index.
	async listMembershipsForUser(userId: UserID): Promise<Array<ThreadMembershipForUser>> {
		const rows = await fetchMany<ThreadMemberByUserRow>(LIST_BY_USER_QUERY.bind({user_id: userId}));
		return rows.map(mapByUserRow);
	}

	async addMember(
		threadId: ChannelID,
		userId: UserID,
		flags = 0,
		guildId: GuildID | null = null,
	): Promise<ThreadMember> {
		const joinTimestamp = new Date();
		const row: ThreadMemberRow = {
			thread_id: threadId,
			user_id: userId,
			join_timestamp: joinTimestamp,
			flags,
		};
		await upsertOne(ThreadMembers.insert(row));
		await this.writeByUserRow({threadId, userId, guildId, joinTimestamp, flags});
		return mapRow(row);
	}

	// The index row is written on its own so a backfill can add one for membership that predates it.
	async writeByUserRow(params: {
		threadId: ChannelID;
		userId: UserID;
		guildId: GuildID | null;
		joinTimestamp: Date;
		flags: number;
	}): Promise<void> {
		const indexRow: ThreadMemberByUserRow = {
			user_id: params.userId,
			thread_id: params.threadId,
			guild_id: params.guildId,
			join_timestamp: params.joinTimestamp,
			flags: params.flags,
		};
		await upsertOne(ThreadMembersByUser.insert(indexRow));
	}

	async removeMember(threadId: ChannelID, userId: UserID): Promise<void> {
		await deleteOneOrMany(ThreadMembers.deleteByPk({thread_id: threadId, user_id: userId}));
		await deleteOneOrMany(ThreadMembersByUser.deleteByPk({user_id: userId, thread_id: threadId}));
	}

	async removeAllMembers(threadId: ChannelID): Promise<void> {
		const members = await this.listMembers(threadId);
		await Promise.all(members.map((member) => this.removeMember(threadId, member.userId)));
	}
}
