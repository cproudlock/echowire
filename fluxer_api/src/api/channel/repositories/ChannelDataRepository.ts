// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, MessageID, UserID} from '@app/api/BrandedTypes';
import {
	privateChannelFanOutTargets,
	privateChannelLastMessageIdPatch,
	privateChannelMetadataPatch,
} from '@app/api/channel/PrivateChannelSnapshot';
import {IChannelDataRepository} from '@app/api/channel/repositories/IChannelDataRepository';
import {
	BatchBuilder,
	fetchMany,
	fetchManyInChunks,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db, type DbOp} from '@app/api/database/CassandraTypes';
import {buildPatchFromData, executeVersionedUpdate} from '@app/api/database/CassandraVersionedUpdate';
import type {ChannelRow} from '@app/api/database/types/ChannelTypes';
import {CHANNEL_COLUMNS} from '@app/api/database/types/ChannelTypes';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {Channel} from '@app/api/models/Channel';
import {Channels, ChannelsByGuild, PrivateChannels} from '@app/api/Tables';
import {ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';

// Echowire: thread columns that change independently of the rest of the row. They are written
// with a targeted patch, never a full-row upsert from a possibly stale snapshot, so a concurrent
// message send cannot roll back last_message_id or the message count.
type ThreadPatchableColumn =
	| 'name'
	| 'applied_tags'
	| 'thread_auto_archive_duration'
	| 'thread_invitable'
	| 'thread_archived'
	| 'thread_archive_timestamp'
	| 'thread_locked'
	| 'thread_pinned'
	| 'thread_member_count'
	| 'thread_message_count';

// Echowire: thread counters have no atomic increment in the KV store, so the read-modify-write is
// serialised per thread with the distributed cache lock (the same primitive message edits use).
// If the lock cannot be taken in time the write proceeds unlocked: an occasionally inexact count
// is preferable to failing a message send. The cache singleton is loaded lazily to avoid an import
// cycle between repositories and the service singletons.
const THREAD_COUNTER_LOCK_TTL_SECONDS = 5;
const THREAD_COUNTER_LOCK_ATTEMPTS = 25;
const THREAD_COUNTER_LOCK_RETRY_MS = 10;

async function withThreadCounterLock<T>(channelId: ChannelID, fn: () => Promise<T>): Promise<T> {
	let cache: ICacheService | null = null;
	try {
		cache = (await import('@app/api/middleware/ServiceSingletons')).getCacheService();
	} catch {
		cache = null;
	}
	if (!cache) {
		return fn();
	}
	const key = `channel:${channelId}:thread-counters`;
	let token: string | null = null;
	for (let attempt = 0; attempt < THREAD_COUNTER_LOCK_ATTEMPTS; attempt++) {
		token = await cache.acquireLock(key, THREAD_COUNTER_LOCK_TTL_SECONDS).catch(() => null);
		if (token) break;
		await new Promise((resolve) => setTimeout(resolve, THREAD_COUNTER_LOCK_RETRY_MS * (attempt + 1)));
	}
	if (!token) {
		Logger.warn({channelId: channelId.toString()}, 'Thread counter lock unavailable; updating unlocked');
		return fn();
	}
	try {
		return await fn();
	} finally {
		await cache.releaseLock(key, token).catch(() => {});
	}
}

const FETCH_CHANNEL_BY_ID = Channels.select({
	where: [Channels.where.eq('channel_id'), Channels.where.eq('soft_deleted')],
	limit: 1,
});
const FETCH_CHANNELS_BY_IDS = Channels.select({
	where: [Channels.where.in('channel_id', 'channel_ids'), Channels.where.eq('soft_deleted')],
});
const FETCH_GUILD_CHANNELS_BY_GUILD_ID = ChannelsByGuild.select({
	where: ChannelsByGuild.where.eq('guild_id'),
});
const FETCH_OPEN_PRIVATE_CHANNEL_TARGET = PrivateChannels.selectCql({
	columns: ['user_id'],
	where: [PrivateChannels.where.eq('user_id'), PrivateChannels.where.eq('channel_id')],
	limit: 1,
});

export class ChannelDataRepository extends IChannelDataRepository {
	constructor(private readonly requestCache?: RequestCache) {
		super();
	}

	async findUnique(channelId: ChannelID): Promise<Channel | null> {
		const prefetched = this.requestCache?.takeChannel(channelId);
		if (prefetched !== undefined) {
			return prefetched;
		}
		const channel = await fetchOne<ChannelRow>(
			FETCH_CHANNEL_BY_ID.bind({
				channel_id: channelId,
				soft_deleted: false,
			}),
		);
		return channel ? new Channel(channel) : null;
	}

	async upsert(data: ChannelRow, oldData?: ChannelRow | null): Promise<Channel> {
		const channelId = data.channel_id;
		this.requestCache?.channels.delete(channelId);
		const result = await executeVersionedUpdate<ChannelRow, 'channel_id' | 'soft_deleted'>(
			async () => fetchOne<ChannelRow>(FETCH_CHANNEL_BY_ID.bind({channel_id: channelId, soft_deleted: false})),
			(current) => ({
				pk: {channel_id: channelId, soft_deleted: false},
				patch: buildPatchFromData(data, current, CHANNEL_COLUMNS, ['channel_id', 'soft_deleted']),
			}),
			Channels,
			{initialData: oldData},
		);
		if (data.guild_id) {
			await upsertOne(
				ChannelsByGuild.upsertAll({
					guild_id: data.guild_id,
					channel_id: channelId,
				}),
			);
		}
		const finalRow: ChannelRow = {...data, version: result.finalVersion ?? 0};
		await this.writeThroughPrivateChannelMetadata(finalRow);
		return new Channel(finalRow);
	}

	async updateLastMessageId(channelId: ChannelID, messageId: MessageID): Promise<void> {
		this.requestCache?.channels.delete(channelId);
		const existing = await fetchOne<ChannelRow>(
			FETCH_CHANNEL_BY_ID.bind({
				channel_id: channelId,
				soft_deleted: false,
			}),
		);
		if (!existing) return;
		if (!THREAD_CHANNEL_TYPES.has(existing.type)) {
			await this.advanceLastMessageId(existing, messageId);
			return;
		}
		// Echowire: a thread's message count is read, bumped and written back. Serialise that per
		// thread so concurrent sends neither lose increments nor both treat themselves as a forum
		// post's uncounted starter message. Re-read inside the lock.
		await withThreadCounterLock(channelId, async () => {
			const fresh = await fetchOne<ChannelRow>(FETCH_CHANNEL_BY_ID.bind({channel_id: channelId, soft_deleted: false}));
			if (fresh) {
				await this.advanceLastMessageId(fresh, messageId);
			}
		});
	}

	private async advanceLastMessageId(existing: ChannelRow, messageId: MessageID): Promise<void> {
		const channelId = existing.channel_id;
		const prev = existing.last_message_id ?? null;
		if (prev !== null && messageId <= prev) return;
		const patch: Partial<Record<'last_message_id' | 'thread_message_count', DbOp<unknown>>> = {
			last_message_id: Db.set(messageId),
		};
		// Echowire: a new message in a thread bumps its message count in the same write. The first
		// message of a forum post is the starter message, which Discord does not count.
		if (THREAD_CHANNEL_TYPES.has(existing.type) && !(await this.isForumPostStarter(existing, prev))) {
			patch.thread_message_count = Db.set((existing.thread_message_count ?? 0) + 1);
		}
		await upsertOne(Channels.patchByPk({channel_id: channelId, soft_deleted: false}, patch as never));
		void this.fanOutPrivateChannelLastMessageId(existing, messageId);
	}

	private async isForumPostStarter(thread: ChannelRow, previousLastMessageId: MessageID | null): Promise<boolean> {
		if (previousLastMessageId !== null || !thread.parent_id) return false;
		const parent = await fetchOne<ChannelRow>(
			FETCH_CHANNEL_BY_ID.bind({channel_id: thread.parent_id, soft_deleted: false}),
		);
		return parent?.type === ChannelTypes.GUILD_FORUM;
	}

	async patchThreadFields(
		channelId: ChannelID,
		fields: Partial<Pick<ChannelRow, ThreadPatchableColumn>>,
	): Promise<void> {
		const patch: Record<string, DbOp<unknown>> = {};
		for (const [column, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			patch[column] = value === null ? Db.clear() : Db.set(value);
		}
		if (Object.keys(patch).length === 0) return;
		this.requestCache?.channels.delete(channelId);
		await upsertOne(Channels.patchByPk({channel_id: channelId, soft_deleted: false}, patch as never));
	}

	async adjustThreadMessageCount(channelId: ChannelID, delta: number): Promise<void> {
		if (delta === 0) return;
		await withThreadCounterLock(channelId, async () => {
			const existing = await fetchOne<ChannelRow>(
				FETCH_CHANNEL_BY_ID.bind({channel_id: channelId, soft_deleted: false}),
			);
			if (!existing || !THREAD_CHANNEL_TYPES.has(existing.type)) return;
			const current = existing.thread_message_count ?? 0;
			const next = Math.max(0, current + delta);
			if (next === current) return;
			this.requestCache?.channels.delete(channelId);
			await upsertOne(
				Channels.patchByPk({channel_id: channelId, soft_deleted: false}, {thread_message_count: Db.set(next)}),
			);
		});
	}

	private async writeThroughPrivateChannelMetadata(row: ChannelRow): Promise<void> {
		try {
			const targets = await this.listOpenPrivateChannelTargets(row);
			if (targets.length === 0) return;
			const patch = privateChannelMetadataPatch(row);
			const results = await Promise.allSettled(
				targets.map((userId) =>
					upsertOne(PrivateChannels.patchByPk({user_id: userId, channel_id: row.channel_id}, patch)),
				),
			);
			this.logFanOutFailures(results, row.channel_id, 'metadata');
		} catch (error) {
			this.logFanOutError(error, row.channel_id, 'metadata');
		}
	}

	private async fanOutPrivateChannelLastMessageId(existing: ChannelRow, messageId: MessageID): Promise<void> {
		try {
			const targets = await this.listOpenPrivateChannelTargets(existing);
			if (targets.length === 0) return;
			const patch = privateChannelLastMessageIdPatch(messageId);
			const results = await Promise.allSettled(
				targets.map((userId) =>
					upsertOne(PrivateChannels.patchByPk({user_id: userId, channel_id: existing.channel_id}, patch)),
				),
			);
			this.logFanOutFailures(results, existing.channel_id, 'last_message_id');
		} catch (error) {
			this.logFanOutError(error, existing.channel_id, 'last_message_id');
		}
	}

	private async listOpenPrivateChannelTargets(row: ChannelRow): Promise<Array<UserID>> {
		const targets = privateChannelFanOutTargets(row);
		if (targets.length === 0) return [];
		const openTargets = await Promise.all(
			targets.map(async (userId) => {
				const existing = await fetchOne<{user_id: UserID}>(FETCH_OPEN_PRIVATE_CHANNEL_TARGET, {
					user_id: userId,
					channel_id: row.channel_id,
				});
				return existing ? userId : null;
			}),
		);
		return openTargets.filter((userId): userId is UserID => userId != null);
	}

	private logFanOutFailures(results: Array<PromiseSettledResult<unknown>>, channelId: ChannelID, kind: string): void {
		const failures = results.filter((result) => result.status === 'rejected');
		if (failures.length === 0) return;
		Logger.warn(
			{
				channelId: channelId.toString(),
				kind,
				failureCount: failures.length,
				error:
					failures[0].status === 'rejected' && failures[0].reason instanceof Error
						? failures[0].reason.message
						: String(failures[0].status === 'rejected' ? failures[0].reason : ''),
			},
			'Failed to write through private channel snapshot fan-out',
		);
	}

	private logFanOutError(error: unknown, channelId: ChannelID, kind: string): void {
		Logger.warn(
			{
				channelId: channelId.toString(),
				kind,
				error: error instanceof Error ? error.message : String(error),
			},
			'Failed to write through private channel snapshot fan-out',
		);
	}

	async delete(channelId: ChannelID, guildId?: GuildID): Promise<void> {
		this.requestCache?.channels.delete(channelId);
		const batch = new BatchBuilder();
		batch.addPrepared(
			Channels.deleteByPk({
				channel_id: channelId,
				soft_deleted: false,
			}),
		);
		if (guildId) {
			batch.addPrepared(
				ChannelsByGuild.deleteByPk({
					guild_id: guildId,
					channel_id: channelId,
				}),
			);
		}
		await batch.execute();
	}

	async listGuildChannels(guildId: GuildID): Promise<Array<Channel>> {
		const guildChannels = await fetchMany<{
			channel_id: bigint;
		}>(FETCH_GUILD_CHANNELS_BY_GUILD_ID.bind({guild_id: guildId}));
		if (guildChannels.length === 0) return [];
		const channelIds = guildChannels.map((c) => c.channel_id);
		const channels = await fetchManyInChunks<ChannelRow>(FETCH_CHANNELS_BY_IDS, channelIds, (chunk) => ({
			channel_ids: chunk,
			soft_deleted: false,
		}));
		return channels.map((channel) => new Channel(channel));
	}

	async listChannels(channelIds: Array<ChannelID>): Promise<Array<Channel>> {
		if (channelIds.length === 0) return [];
		const channels = await fetchManyInChunks<ChannelRow>(FETCH_CHANNELS_BY_IDS, channelIds, (chunk) => ({
			channel_ids: chunk,
			soft_deleted: false,
		}));
		return channels.map((channel) => new Channel(channel));
	}

	async countGuildChannels(guildId: GuildID): Promise<number> {
		const guildChannels = await fetchMany<{
			channel_id: bigint;
		}>(FETCH_GUILD_CHANNELS_BY_GUILD_ID.bind({guild_id: guildId}));
		return guildChannels.length;
	}
}
