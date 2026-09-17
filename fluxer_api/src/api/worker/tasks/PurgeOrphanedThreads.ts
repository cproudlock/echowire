// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: one-off and ongoing cleanup for threads whose parent channel is gone. Deleting a text
// or forum channel now purges its threads (ThreadPurge.ts), but threads orphaned before that rule
// still exist in the store, and with no parent they have nothing to resolve permissions against.
// The API and gateway already treat them as inaccessible; this sweep removes them. It is
// idempotent: a thread with a live parent is never touched, and a purged thread no longer matches.
//
// Runs on both backends by walking guilds and their channels (see ThreadSweepScan.ts), replacing a
// raw SQL scan only Postgres could answer. Archived threads are included, because an archived
// thread whose parent was deleted is still an orphan holding storage. The parent lookup comes from
// the guild's own channel set, so deciding orphanhood costs no extra read.

import type {MessageID} from '@app/api/BrandedTypes';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {purgeMessageAttachments} from '@app/api/channel/services/message/MessageHelpers';
import {purgeThread} from '@app/api/channel/services/ThreadPurge';
import {scanGuildThreads} from '@app/api/channel/services/ThreadSweepScan';
import type {Channel} from '@app/api/models/Channel';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

const ATTACHMENT_BATCH = 100;

// A thread is orphaned when it has no parent id, or its parent is missing or soft-deleted. The
// lookup is a plain function so the caller can answer it from a set it already holds.
export function isOrphanedThread(
	thread: Pick<Channel, 'type' | 'parentId'>,
	findChannel: (channelId: string) => Pick<Channel, 'isSoftDeleted'> | null,
): boolean {
	if (!THREAD_CHANNEL_TYPES.has(thread.type)) {
		return false;
	}
	if (!thread.parentId) {
		return true;
	}
	const parent = findChannel(String(thread.parentId));
	return parent === null || parent.isSoftDeleted;
}

const purgeOrphanedThreads: WorkerTaskHandler = async (_payload, helpers) => {
	const {channelRepository, gatewayService, guildRepository, storageService, purgeQueue} = getWorkerDependencies();
	const threadMemberRepository = new ThreadMemberRepository();
	let purged = 0;
	for await (const {guildId, threads, channelsById} of scanGuildThreads(
		guildRepository,
		channelRepository.channelData,
	)) {
		for (const thread of threads) {
			if (!isOrphanedThread(thread, (id) => channelsById.get(id) ?? null)) {
				continue;
			}
			try {
				await purgeThread({
					thread,
					guildId,
					deleteMessages: (id) => channelRepository.messages.deleteAllChannelMessages(id),
					deleteChannelRow: (id, purgeGuildId) => channelRepository.channelData.delete(id, purgeGuildId),
					purgeAttachments: async (target) => {
						let before: MessageID | undefined;
						for (;;) {
							const messages = await channelRepository.messages.listMessages(target.id, before, ATTACHMENT_BATCH);
							await Promise.all(messages.map((m) => purgeMessageAttachments(m, storageService, purgeQueue)));
							if (messages.length < ATTACHMENT_BATCH) {
								break;
							}
							before = messages[messages.length - 1].id;
						}
					},
					threadMemberRepository,
					gatewayService,
					source: 'orphaned_thread_sweep',
				});
				purged += 1;
			} catch (error) {
				helpers.logger.warn({error, channelId: String(thread.id)}, 'Failed to purge orphaned thread');
			}
		}
	}
	if (purged > 0) {
		helpers.logger.info({purged}, 'Purged threads whose parent channel no longer exists');
	}
};

export default purgeOrphanedThreads;
