// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: membership written before thread_members_by_user existed has no row in that index, so
// a session would be told it belongs to fewer threads than it does. This sweep writes the missing
// index rows. It is idempotent: an index row is written only when it is absent, so the sweep
// settles to doing nothing once it has caught up.
//
// Runs on both backends by walking guilds and their threads (see ThreadSweepScan.ts) and reading
// each thread's members from the thread-partitioned table, which is a single-partition query on
// either backend. It replaces a raw SQL scan of thread_members that only Postgres could answer.

import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {scanGuildThreads} from '@app/api/channel/services/ThreadSweepScan';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

const backfillThreadMembersByUser: WorkerTaskHandler = async (_payload, helpers) => {
	const {channelRepository, guildRepository} = getWorkerDependencies();
	const threadMemberRepository = new ThreadMemberRepository();
	const indexedThreadsByUser = new Map<string, Set<string>>();
	let written = 0;
	for await (const {guildId, threads} of scanGuildThreads(guildRepository, channelRepository.channelData)) {
		for (const thread of threads) {
			const members = await threadMemberRepository.listMembers(thread.id);
			for (const member of members) {
				const userKey = String(member.userId);
				try {
					let seen = indexedThreadsByUser.get(userKey);
					if (!seen) {
						const existing = await threadMemberRepository.listMembershipsForUser(member.userId);
						seen = new Set(existing.map((membership) => String(membership.threadId)));
						indexedThreadsByUser.set(userKey, seen);
					}
					if (seen.has(String(thread.id))) {
						continue;
					}
					await threadMemberRepository.writeByUserRow({
						threadId: thread.id,
						userId: member.userId,
						guildId,
						joinTimestamp: member.joinTimestamp,
						flags: member.flags,
					});
					seen.add(String(thread.id));
					written += 1;
				} catch (error) {
					helpers.logger.warn(
						{error, threadId: String(thread.id), userId: String(member.userId)},
						'Failed to backfill thread membership index row',
					);
				}
			}
		}
	}
	if (written > 0) {
		helpers.logger.info({written}, 'Backfilled thread membership index rows');
	}
};

export default backfillThreadMembersByUser;
