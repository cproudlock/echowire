// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: auto-archive worker. Periodically archives threads that have been inactive longer than
// their auto_archive_duration and tells clients with THREAD_UPDATE.
//
// Runs on both backends. It walks guilds and their channels (see ThreadSweepScan.ts) rather than
// the raw SQL scan over the KV table it used to do, which only Postgres could answer, so Cassandra
// deployments never auto-archived a thread. The walk hands back fully loaded thread rows, so the
// inactivity decision needs no further read.

import {mapChannelToResponse} from '@app/api/channel/ChannelMappers';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {withPrivateThreadMemberIds} from '@app/api/channel/services/ThreadAccess';
import {scanGuildThreads} from '@app/api/channel/services/ThreadSweepScan';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {Channel} from '@app/api/models/Channel';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

export function isThreadInactive(thread: Pick<Channel, 'lastMessageId' | 'threadMetadata'>, nowMs: number): boolean {
	const durationMinutes = thread.threadMetadata?.autoArchiveDuration ?? 1440;
	if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
		return false;
	}
	const createTimestamp = thread.threadMetadata?.createTimestamp ?? null;
	const lastActivityMs = thread.lastMessageId
		? snowflakeToDate(BigInt(thread.lastMessageId)).getTime()
		: createTimestamp
			? createTimestamp.getTime()
			: nowMs;
	return nowMs - lastActivityMs >= durationMinutes * 60_000;
}

const archiveInactiveThreads: WorkerTaskHandler = async (_payload, helpers) => {
	const {channelRepository, gatewayService, guildRepository, userCacheService} = getWorkerDependencies();
	const threadMemberRepository = new ThreadMemberRepository();
	const now = Date.now();
	let archivedCount = 0;
	for await (const {guildId, threads} of scanGuildThreads(guildRepository, channelRepository.channelData)) {
		for (const thread of threads) {
			if (thread.isSoftDeleted || !thread.threadMetadata || thread.threadMetadata.archived) {
				continue;
			}
			if (!isThreadInactive(thread, now)) {
				continue;
			}
			await channelRepository.channelData.patchThreadFields(thread.id, {
				thread_archived: true,
				thread_archive_timestamp: new Date(),
			});
			archivedCount += 1;
			try {
				const archived = await channelRepository.findUnique(thread.id);
				if (archived) {
					const response = await mapChannelToResponse({
						channel: archived,
						currentUserId: null,
						userCacheService,
						requestCache: createRequestCache(),
					});
					const data = await withPrivateThreadMemberIds({
						channel: archived,
						response,
						threadMemberRepository,
					});
					await gatewayService.dispatchGuild({guildId, event: 'THREAD_UPDATE', data});
				}
			} catch (error) {
				helpers.logger.warn({error, channelId: String(thread.id)}, 'Failed to dispatch THREAD_UPDATE for auto-archive');
			}
		}
	}
	if (archivedCount > 0) {
		helpers.logger.info({archivedCount}, 'Auto-archived inactive threads');
	}
};

export default archiveInactiveThreads;
