// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: membership written before thread_members_by_user existed has no row in that index, so
// a session would be told it belongs to fewer threads than it does. This sweep walks the
// thread-partitioned table and writes the missing index rows. It is idempotent: an index row is
// written only when it is absent, and a row already present is left alone, so the sweep settles
// to doing nothing once it has caught up.
//
// Postgres-only, paging the generic KV table in row_key order like the other thread sweeps. On a
// Cassandra deployment the index is still correct for membership created from now on, because
// every write goes through ThreadMemberRepository; only the historical rows are missed.

import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {getDefaultPostgresClient} from '@pkgs/postgres/src/Client';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

interface MembershipRow {
	row_key: string;
	thread_id: string | null;
	user_id: string | null;
	join_timestamp: string | null;
	flags: string | null;
}

const PAGE_SIZE = 500;

const backfillThreadMembersByUser: WorkerTaskHandler = async (_payload, helpers) => {
	if (Config.database.backend !== 'postgres') {
		return;
	}
	const {channelRepository} = getWorkerDependencies();
	const client = getDefaultPostgresClient();
	const threadMemberRepository = new ThreadMemberRepository();
	const guildIdByThread = new Map<string, bigint | null>();
	let written = 0;
	let cursor = '';
	for (;;) {
		const result = await client.query<MembershipRow>(
			`SELECT row_key,
			        row_data->'thread_id'->>'value' AS thread_id,
			        row_data->'user_id'->>'value' AS user_id,
			        row_data->'join_timestamp'->>'value' AS join_timestamp,
			        row_data->>'flags' AS flags
			 FROM ${client.kvTable()}
			 WHERE table_name = 'thread_members'
			   AND row_key > $1
			 ORDER BY row_key
			 LIMIT ${PAGE_SIZE}`,
			[cursor],
		);
		for (const row of result.rows) {
			if (!row.thread_id || !row.user_id) {
				continue;
			}
			const threadId = createChannelID(BigInt(row.thread_id));
			const userId = createUserID(BigInt(row.user_id));
			try {
				const existing = await threadMemberRepository.listMembershipsForUser(userId);
				if (existing.some((membership) => membership.threadId === threadId)) {
					continue;
				}
				if (!guildIdByThread.has(row.thread_id)) {
					const thread = await channelRepository.findUnique(threadId);
					guildIdByThread.set(row.thread_id, thread?.guildId ?? null);
				}
				const guildId = guildIdByThread.get(row.thread_id) ?? null;
				await threadMemberRepository.writeByUserRow({
					threadId,
					userId,
					guildId: guildId === null ? null : (guildId as never),
					joinTimestamp: row.join_timestamp ? new Date(row.join_timestamp) : new Date(),
					flags: row.flags ? Number(row.flags) : 0,
				});
				written += 1;
			} catch (error) {
				helpers.logger.warn(
					{error, threadId: row.thread_id, userId: row.user_id},
					'Failed to backfill thread membership index row',
				);
			}
		}
		if (result.rows.length < PAGE_SIZE) {
			break;
		}
		cursor = result.rows[result.rows.length - 1].row_key;
	}
	if (written > 0) {
		helpers.logger.info({written}, 'Backfilled thread membership index rows');
	}
};

export default backfillThreadMembersByUser;
