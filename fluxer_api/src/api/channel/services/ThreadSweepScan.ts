// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: how the thread maintenance sweeps visit every thread on the instance, on either
// backend.
//
// The archive, orphan and membership sweeps each need to walk all threads. They used raw SQL over
// the generic KV table, filtering row_data->>'type', which only Postgres can answer: Cassandra has
// no WHERE on a non-key column and no offset paging. So all three returned early on Cassandra and
// threads were never auto-archived there at all.
//
// The portable route already existed and is what the search index refresh uses: page every guild
// with listAllGuildsPaginated, then read that guild's channels. A guild's channel list is a single
// partition read and it contains its threads, so one pass yields fully loaded thread rows with no
// extra read per thread. It needs no new table, so there is nothing to keep in step and nothing to
// backfill, and it costs less than the old scan, which read every channel row on the instance
// (threads, text channels and DMs alike) every five minutes.
//
// Each page yields the guild's channels as one set, so a caller that needs to resolve a thread's
// parent (the orphan sweep) can do it from memory instead of a read per thread.

import type {GuildID} from '@app/api/BrandedTypes';
import type {IChannelDataRepository} from '@app/api/channel/repositories/IChannelDataRepository';
import type {Channel} from '@app/api/models/Channel';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';

const GUILD_PAGE_SIZE = 100;

interface GuildChannelSet {
	guildId: GuildID;
	threads: Array<Channel>;
	channelsById: Map<string, Channel>;
}

interface GuildPageSource {
	listAllGuildsPaginated(limit: number, lastGuildId?: GuildID): Promise<Array<{id: GuildID}>>;
}

export async function* scanGuildThreads(
	guildRepository: GuildPageSource,
	channelData: Pick<IChannelDataRepository, 'listGuildChannels'>,
): AsyncGenerator<GuildChannelSet> {
	let lastGuildId: GuildID | undefined;
	for (;;) {
		const guilds = await guildRepository.listAllGuildsPaginated(GUILD_PAGE_SIZE, lastGuildId);
		if (guilds.length === 0) {
			return;
		}
		for (const guild of guilds) {
			const channels = await channelData.listGuildChannels(guild.id);
			const threads = channels.filter((channel) => THREAD_CHANNEL_TYPES.has(channel.type));
			if (threads.length === 0) {
				continue;
			}
			yield {
				guildId: guild.id,
				threads,
				channelsById: new Map(channels.map((channel) => [String(channel.id), channel])),
			};
		}
		if (guilds.length < GUILD_PAGE_SIZE) {
			return;
		}
		lastGuildId = guilds[guilds.length - 1].id;
	}
}
