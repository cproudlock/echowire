// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: auto-archive worker. Periodically archives threads that have been
// inactive longer than their auto_archive_duration. Postgres-only (scans the
// generic KV table for active thread channels; reuses the channel repository to
// persist so versioning/serialisation stay correct).

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import {getDefaultPostgresClient} from '@pkgs/postgres/src/Client';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {createChannelID} from '../../BrandedTypes';
import {Config} from '../../Config';
import {getWorkerDependencies} from '../WorkerContext';

interface ActiveThreadRow {
	channel_id: string | null;
	duration: string | null;
	create_ts: string | null;
	last_message_id: string | null;
}

const FETCH_LIMIT = 1000;

const archiveInactiveThreads: WorkerTaskHandler = async (_payload, helpers) => {
	if (Config.database.backend !== 'postgres') {
		return;
	}
	const {channelRepository} = getWorkerDependencies();
	const client = getDefaultPostgresClient();
	const result = await client.query<ActiveThreadRow>(
		`SELECT row_data->'channel_id'->>'value' AS channel_id,
		        row_data->>'thread_auto_archive_duration' AS duration,
		        row_data->'thread_create_timestamp'->>'value' AS create_ts,
		        row_data->'last_message_id'->>'value' AS last_message_id
		 FROM ${client.kvTable()}
		 WHERE table_name = 'channels'
		   AND row_data->>'type' IN ($1, $2)
		   AND (row_data->>'thread_archived') IS DISTINCT FROM 'true'
		 LIMIT ${FETCH_LIMIT}`,
		[String(ChannelTypes.PUBLIC_THREAD), String(ChannelTypes.PRIVATE_THREAD)],
	);
	const now = Date.now();
	let archivedCount = 0;
	for (const row of result.rows) {
		if (!row.channel_id) {
			continue;
		}
		const durationMinutes = Number(row.duration ?? 1440);
		if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
			continue;
		}
		const lastActivityMs = row.last_message_id
			? snowflakeToDate(BigInt(row.last_message_id)).getTime()
			: row.create_ts
				? new Date(row.create_ts).getTime()
				: now;
		if (now - lastActivityMs < durationMinutes * 60_000) {
			continue;
		}
		const channel = await channelRepository.findUnique(createChannelID(BigInt(row.channel_id)));
		if (!channel || channel.isSoftDeleted || !channel.threadMetadata || channel.threadMetadata.archived) {
			continue;
		}
		await channelRepository.upsert({
			...channel.toRow(),
			thread_archived: true,
			thread_archive_timestamp: new Date(),
		});
		archivedCount += 1;
	}
	if (archivedCount > 0) {
		helpers.logger.info({archivedCount}, 'Auto-archived inactive threads');
	}
};

export default archiveInactiveThreads;
