// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: auto-archive worker. Periodically archives threads that have been inactive longer than
// their auto_archive_duration and tells clients with THREAD_UPDATE. Postgres-only: it pages through
// the generic KV table for active thread channels in row_key order, so every thread is reached no
// matter how many there are. Cassandra deployments have no equivalent secondary scan and are skipped.

import {createChannelID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {mapChannelToResponse} from '@app/api/channel/ChannelMappers';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {withPrivateThreadMemberIds} from '@app/api/channel/services/ThreadAccess';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import {getDefaultPostgresClient} from '@pkgs/postgres/src/Client';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

interface ActiveThreadRow {
	row_key: string;
	channel_id: string | null;
	duration: string | null;
	create_ts: string | null;
	last_message_id: string | null;
}

const PAGE_SIZE = 500;

export function isThreadInactive(
	row: Pick<ActiveThreadRow, 'duration' | 'create_ts' | 'last_message_id'>,
	nowMs: number,
): boolean {
	const durationMinutes = Number(row.duration ?? 1440);
	if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
		return false;
	}
	const lastActivityMs = row.last_message_id
		? snowflakeToDate(BigInt(row.last_message_id)).getTime()
		: row.create_ts
			? new Date(row.create_ts).getTime()
			: nowMs;
	return nowMs - lastActivityMs >= durationMinutes * 60_000;
}

const archiveInactiveThreads: WorkerTaskHandler = async (_payload, helpers) => {
	if (Config.database.backend !== 'postgres') {
		return;
	}
	const {channelRepository, gatewayService, userCacheService} = getWorkerDependencies();
	const client = getDefaultPostgresClient();
	const threadMemberRepository = new ThreadMemberRepository();
	const now = Date.now();
	let archivedCount = 0;
	let cursor = '';
	for (;;) {
		const result = await client.query<ActiveThreadRow>(
			`SELECT row_key,
			        row_data->'channel_id'->>'value' AS channel_id,
			        row_data->>'thread_auto_archive_duration' AS duration,
			        row_data->'thread_create_timestamp'->>'value' AS create_ts,
			        row_data->'last_message_id'->>'value' AS last_message_id
			 FROM ${client.kvTable()}
			 WHERE table_name = 'channels'
			   AND row_key > $3
			   AND row_data->>'type' IN ($1, $2)
			   AND (row_data->>'thread_archived') IS DISTINCT FROM 'true'
			 ORDER BY row_key
			 LIMIT ${PAGE_SIZE}`,
			[String(ChannelTypes.PUBLIC_THREAD), String(ChannelTypes.PRIVATE_THREAD), cursor],
		);
		for (const row of result.rows) {
			if (!row.channel_id || !isThreadInactive(row, now)) {
				continue;
			}
			const channelId = createChannelID(BigInt(row.channel_id));
			const channel = await channelRepository.findUnique(channelId);
			if (!channel || channel.isSoftDeleted || !channel.guildId || !channel.threadMetadata) {
				continue;
			}
			if (channel.threadMetadata.archived) {
				continue;
			}
			await channelRepository.channelData.patchThreadFields(channelId, {
				thread_archived: true,
				thread_archive_timestamp: new Date(),
			});
			archivedCount += 1;
			try {
				const archived = await channelRepository.findUnique(channelId);
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
					await gatewayService.dispatchGuild({guildId: channel.guildId, event: 'THREAD_UPDATE', data});
				}
			} catch (error) {
				helpers.logger.warn({error, channelId: row.channel_id}, 'Failed to dispatch THREAD_UPDATE for auto-archive');
			}
		}
		if (result.rows.length < PAGE_SIZE) {
			break;
		}
		cursor = result.rows[result.rows.length - 1].row_key;
	}
	if (archivedCount > 0) {
		helpers.logger.info({archivedCount}, 'Auto-archived inactive threads');
	}
};

export default archiveInactiveThreads;
