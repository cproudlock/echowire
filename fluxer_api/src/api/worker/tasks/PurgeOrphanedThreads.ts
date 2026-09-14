// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: one-off and ongoing cleanup for threads whose parent channel is gone. Deleting a text
// or forum channel now purges its threads (ThreadPurge.ts), but threads orphaned before that rule
// still exist in the store, and with no parent they have nothing to resolve permissions against.
// The API and gateway already treat them as inaccessible; this sweep removes them. It is
// idempotent: a thread with a live parent is never touched, and a purged thread no longer matches.
// Postgres-only, paging the generic KV table in row_key order like ArchiveInactiveThreads.

import {type ChannelID, createChannelID, type MessageID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {purgeMessageAttachments} from '@app/api/channel/services/message/MessageHelpers';
import {purgeThread} from '@app/api/channel/services/ThreadPurge';
import type {Channel} from '@app/api/models/Channel';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {getDefaultPostgresClient} from '@pkgs/postgres/src/Client';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

interface ThreadRow {
	row_key: string;
	channel_id: string | null;
}

const PAGE_SIZE = 500;
const ATTACHMENT_BATCH = 100;

// A thread is orphaned when it has no parent id, or its parent row is missing or soft-deleted.
export async function isOrphanedThread(
	thread: Pick<Channel, 'type' | 'parentId'>,
	findChannel: (channelId: ChannelID) => Promise<Pick<Channel, 'isSoftDeleted'> | null>,
): Promise<boolean> {
	if (!THREAD_CHANNEL_TYPES.has(thread.type)) {
		return false;
	}
	if (!thread.parentId) {
		return true;
	}
	const parent = await findChannel(thread.parentId);
	return parent === null || parent.isSoftDeleted;
}

const purgeOrphanedThreads: WorkerTaskHandler = async (_payload, helpers) => {
	if (Config.database.backend !== 'postgres') {
		return;
	}
	const {channelRepository, gatewayService, storageService, purgeQueue} = getWorkerDependencies();
	const client = getDefaultPostgresClient();
	const threadMemberRepository = new ThreadMemberRepository();
	let purged = 0;
	let cursor = '';
	for (;;) {
		const result = await client.query<ThreadRow>(
			`SELECT row_key, row_data->'channel_id'->>'value' AS channel_id
			 FROM ${client.kvTable()}
			 WHERE table_name = 'channels'
			   AND row_key > $3
			   AND row_data->>'type' IN ($1, $2)
			 ORDER BY row_key
			 LIMIT ${PAGE_SIZE}`,
			[String(ChannelTypes.PUBLIC_THREAD), String(ChannelTypes.PRIVATE_THREAD), cursor],
		);
		for (const row of result.rows) {
			if (!row.channel_id) {
				continue;
			}
			const thread = await channelRepository.findUnique(createChannelID(BigInt(row.channel_id)));
			if (!thread || !thread.guildId) {
				continue;
			}
			if (!(await isOrphanedThread(thread, (id) => channelRepository.findUnique(id)))) {
				continue;
			}
			try {
				await purgeThread({
					thread,
					guildId: thread.guildId,
					deleteMessages: (id) => channelRepository.messages.deleteAllChannelMessages(id),
					deleteChannelRow: (id, guildId) => channelRepository.channelData.delete(id, guildId),
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
				helpers.logger.warn({error, channelId: row.channel_id}, 'Failed to purge orphaned thread');
			}
		}
		if (result.rows.length < PAGE_SIZE) {
			break;
		}
		cursor = result.rows[result.rows.length - 1].row_key;
	}
	if (purged > 0) {
		helpers.logger.info({purged}, 'Purged threads whose parent channel no longer exists');
	}
};

export default purgeOrphanedThreads;
