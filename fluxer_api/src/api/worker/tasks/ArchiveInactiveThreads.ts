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

// Echowire: the most threads one run archives. Each archive is a write plus a gateway dispatch, so a
// backlog (a long outage, or a guild that imported thousands of old threads) is worked off over
// several runs instead of in one burst. Overdue threads go first, see overdueMs.
export const MAX_ARCHIVES_PER_RUN = 500;

function autoArchiveMs(thread: Pick<Channel, 'threadMetadata'>): number {
	const durationMinutes = thread.threadMetadata?.autoArchiveDuration ?? 1440;
	return Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes * 60_000 : 0;
}

function lastActivityMs(thread: Pick<Channel, 'lastMessageId' | 'threadMetadata'>, nowMs: number): number {
	const createTimestamp = thread.threadMetadata?.createTimestamp ?? null;
	return thread.lastMessageId
		? snowflakeToDate(BigInt(thread.lastMessageId)).getTime()
		: createTimestamp
			? createTimestamp.getTime()
			: nowMs;
}

export function isThreadInactive(thread: Pick<Channel, 'lastMessageId' | 'threadMetadata'>, nowMs: number): boolean {
	const durationMs = autoArchiveMs(thread);
	if (durationMs === 0) {
		return false;
	}
	return nowMs - lastActivityMs(thread, nowMs) >= durationMs;
}

// How long past its auto-archive deadline a thread is. Larger means more overdue.
export function overdueMs(thread: Pick<Channel, 'lastMessageId' | 'threadMetadata'>, nowMs: number): number {
	return nowMs - lastActivityMs(thread, nowMs) - autoArchiveMs(thread);
}

// Echowire: the cap can be lowered for a run by the task payload ({maxArchives}), never raised.
function resolveArchiveLimit(payload: unknown): number {
	const requested = (payload as {maxArchives?: unknown} | null | undefined)?.maxArchives;
	return typeof requested === 'number' && Number.isInteger(requested) && requested > 0
		? Math.min(requested, MAX_ARCHIVES_PER_RUN)
		: MAX_ARCHIVES_PER_RUN;
}

const archiveInactiveThreads: WorkerTaskHandler = async (payload, helpers) => {
	const {channelRepository, gatewayService, guildRepository, userCacheService} = getWorkerDependencies();
	const threadMemberRepository = new ThreadMemberRepository();
	const now = Date.now();
	const limit = resolveArchiveLimit(payload);
	let archivedCount = 0;
	let capped = false;
	guilds: for await (const {guildId, threads} of scanGuildThreads(guildRepository, channelRepository.channelData)) {
		// Echowire: a pinned thread is kept open on purpose, so the job never archives one. The rest are
		// archived most-overdue first.
		const due = threads
			.filter(
				(thread) =>
					!thread.isSoftDeleted &&
					thread.threadMetadata &&
					!thread.threadMetadata.archived &&
					!thread.pinned &&
					isThreadInactive(thread, now),
			)
			.sort((a, b) => overdueMs(b, now) - overdueMs(a, now));
		for (const thread of due) {
			if (archivedCount >= limit) {
				capped = true;
				break guilds;
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
	if (capped) {
		helpers.logger.info({archivedCount, limit}, 'Auto-archive hit its per-run cap, the rest wait for the next run');
	}
};

export default archiveInactiveThreads;
