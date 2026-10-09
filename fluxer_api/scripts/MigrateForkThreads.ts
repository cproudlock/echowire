// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MigrateForkThreads
 *
 * Copies the echowire fork's thread and forum state (columns on the channel row, thread_members,
 * thread_members_by_user) into upstream's tables, per docs/adr/0012-adopt-upstream-threads-and-forums.md
 * Phase 3. The old columns and rows are never changed or deleted by the sync modes, so rollback to the
 * previous image stays possible. Mapping rules live in src/api/channel/migration/ForkThreadMapping.ts.
 *
 * Reads: the RAW jsonb of table_name = 'channels' (the typed ChannelRow no longer has the old columns),
 * 'thread_members' and 'thread_members_by_user'. Writes: through the app's own table DSL
 * (Tables.X.upsertAll), so the key and value encoding cannot drift from what the app reads.
 *
 * Usage (from fluxer_api):
 *   MIGRATE_PG_URL=postgres://user:pass@127.0.0.1:55432/fluxer pnpm exec tsx scripts/MigrateForkThreads.ts [flags]
 *
 * Modes (exactly one; the default is --dry-run):
 *   --dry-run          print the plan and the per-table create/update/unchanged counts, write nothing
 *   --apply            full idempotent sync old -> new. Safe to run while the OLD code is live.
 *   --delta            post-deploy catch-up: create what is missing, refresh only thread_state rows that
 *                      upstream has not touched yet (state_version still 1), never overwrite an existing
 *                      parent config or member row, never delete. Add --dry-run to preview it.
 *   --verify           read the migrated data back through upstream's ThreadRepository and mappers and
 *                      compare it with the old columns and the Phase 0 counts. Writes nothing.
 *   --cleanup-legacy   POST-CUTOVER ONLY. Deletes the fork's thread_members_by_user rows (different key, same
 *                      table name) and the forums' channels_by_guild_id rows (upstream lists forums from
 *                      thread_only_channels_by_guild). Previews unless --apply is also given; --apply
 *                      requires --backup-file <path> and saves every deleted row there first.
 *
 * Other flags:
 *   --pre-cutover      do not write the new-key thread_members_by_user rows. Their table name collides with the
 *                      fork's, so while the old image is live they would sit beside the old rows. Write them with
 *                      the first --delta after the new image is up.
 *   --allow-remote     required when the database host is not loopback
 *   --verbose          print every planned row as JSON
 *
 * Env: MIGRATE_PG_URL, or MIGRATE_PG_HOST / PORT / DATABASE / USER / PASSWORD; MIGRATE_PG_KV_TABLE.
 */

import {writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {
	isLegacyByUserRow,
	type LegacyChannel,
	type LegacyMember,
	MIGRATED_STATE_VERSION,
	type MigrationPlan,
	mapAutoArchiveDuration,
	type PlannedParent,
	type PlannedThread,
	parseLegacyChannel,
	parseLegacyMember,
	planMigration,
	rowsEqual,
} from '@app/api/channel/migration/ForkThreadMapping';
import {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import type {IMessageRepository} from '@app/api/channel/repositories/IMessageRepository';
import {ThreadRepository} from '@app/api/channel/repositories/ThreadRepository';
import {mapThreadToResponse} from '@app/api/channel/services/thread/ThreadMappers';
import {mapThreadParentFields} from '@app/api/channel/services/thread/ThreadParentSettings';
import {
	deleteOneOrMany,
	fetchMany,
	fetchOne,
	setDatabaseQueryExecutor,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {ensurePostgresKvSchema, PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import type {
	ActiveThreadsByGuildRow,
	ArchivedThreadsByParentRow,
	ForumPinnedThreadRow,
	GuildThreadStateRow,
	ThreadMemberRow,
	ThreadMembersByUserRow,
	ThreadOnlyChannelsByGuildRow,
	ThreadParentConfigRow,
	ThreadStateRow,
	ThreadStatsRow,
	ThreadsByParentRow,
} from '@app/api/database/types/ThreadTypes';
import * as Tables from '@app/api/Tables';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {
	ChannelFlags,
	DEFAULT_THREAD_AUTO_ARCHIVE_DURATION,
	THREAD_MEMBER_COUNT_DISPLAY_CAP,
	THREAD_ONLY_CHANNEL_TYPES,
} from '@fluxer/constants/src/ThreadConstants';
import * as BucketUtils from '@fluxer/snowflake/src/SnowflakeBuckets';
import {getDefaultPostgresClient, initPostgres, shutdownPostgres} from '@pkgs/postgres/src/Client';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Mode = 'sync' | 'verify' | 'cleanup';

interface Options {
	mode: Mode;
	/** sync and cleanup only: false means read and report, true means write. */
	write: boolean;
	delta: boolean;
	preCutover: boolean;
	allowRemote: boolean;
	verbose: boolean;
	backupFile: string | null;
}

function parseOptions(): Options {
	const {values} = parseArgs({
		args: process.argv.slice(2),
		options: {
			'dry-run': {type: 'boolean', default: false},
			apply: {type: 'boolean', default: false},
			delta: {type: 'boolean', default: false},
			verify: {type: 'boolean', default: false},
			'cleanup-legacy': {type: 'boolean', default: false},
			'pre-cutover': {type: 'boolean', default: false},
			'allow-remote': {type: 'boolean', default: false},
			'backup-file': {type: 'string'},
			verbose: {type: 'boolean', default: false},
		},
		allowPositionals: false,
	});
	const dryRun = values['dry-run'] === true;
	const apply = values.apply === true;
	const delta = values.delta === true;
	const verify = values.verify === true;
	const cleanup = values['cleanup-legacy'] === true;
	if (verify && (apply || delta || cleanup)) throw new Error('--verify cannot be combined with another mode.');
	if (cleanup && delta) throw new Error('--cleanup-legacy cannot be combined with --delta.');
	if (apply && delta) throw new Error('Choose --apply or --delta, not both.');
	if (dryRun && apply) throw new Error('--dry-run and --apply contradict each other.');
	const backupFile = values['backup-file'] ?? null;
	const mode: Mode = verify ? 'verify' : cleanup ? 'cleanup' : 'sync';
	const write = mode === 'cleanup' ? apply : (apply || delta) && !dryRun;
	if (mode === 'cleanup' && write && backupFile === null) {
		throw new Error('--cleanup-legacy --apply needs --backup-file <path>: the deleted rows are saved there first.');
	}
	return {
		mode,
		write,
		delta,
		preCutover: values['pre-cutover'] === true,
		allowRemote: values['allow-remote'] === true,
		verbose: values.verbose === true,
		backupFile,
	};
}

interface PgConfig {
	url?: string;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	kvTable?: string;
}

function readPgConfig(): PgConfig {
	const kvTable = process.env.MIGRATE_PG_KV_TABLE || undefined;
	const url = process.env.MIGRATE_PG_URL;
	if (url && url.length > 0) return {url, kvTable};
	const host = process.env.MIGRATE_PG_HOST;
	if (!host) throw new Error('Set MIGRATE_PG_URL, or MIGRATE_PG_HOST/PORT/DATABASE/USER/PASSWORD.');
	return {
		host,
		port: process.env.MIGRATE_PG_PORT ? Number.parseInt(process.env.MIGRATE_PG_PORT, 10) : 5432,
		database: process.env.MIGRATE_PG_DATABASE || undefined,
		username: process.env.MIGRATE_PG_USER || undefined,
		password: process.env.MIGRATE_PG_PASSWORD || undefined,
		kvTable,
	};
}

function hostOf(config: PgConfig): string {
	if (config.url) return new URL(config.url).hostname;
	return config.host ?? '';
}

function isLoopback(host: string): boolean {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

// ---------------------------------------------------------------------------
// Reading the old data
// ---------------------------------------------------------------------------

interface KvRow {
	row_key: string;
	partition_key: string;
	row_data: unknown;
}

async function readKvTable(tableName: string): Promise<Array<KvRow>> {
	const client = getDefaultPostgresClient();
	const result = await client.query<KvRow>(
		`SELECT row_key, partition_key, row_data FROM ${client.kvTable()} WHERE table_name = $1 ORDER BY row_key`,
		[tableName],
	);
	return result.rows;
}

interface LegacySnapshot {
	channels: Array<LegacyChannel>;
	members: Array<LegacyMember>;
	legacyByUserRows: Array<KvRow>;
	rawMemberRows: number;
}

async function readLegacy(): Promise<LegacySnapshot> {
	const channels = (await readKvTable('channels'))
		.map((row) => parseLegacyChannel(row.row_data))
		.filter((row): row is LegacyChannel => row !== null);
	const memberRows = await readKvTable('thread_members');
	const members = memberRows
		.map((row) => parseLegacyMember(row.row_data))
		.filter((row): row is LegacyMember => row !== null);
	const legacyByUserRows = (await readKvTable('thread_members_by_user')).filter((row) =>
		isLegacyByUserRow(row.row_data),
	);
	return {channels, members, legacyByUserRows, rawMemberRows: memberRows.length};
}

/** Text-parent threads whose id is also a message id in the parent: they were started from that message. */
async function findStarterThreads(channels: ReadonlyArray<LegacyChannel>): Promise<Set<bigint>> {
	const byId = new Map(channels.filter((c) => !c.softDeleted).map((c) => [c.id, c]));
	const found = new Set<bigint>();
	const query = Tables.Messages.select({
		columns: ['message_id'],
		where: [
			Tables.Messages.where.eq('channel_id'),
			Tables.Messages.where.eq('bucket'),
			Tables.Messages.where.eq('message_id'),
		],
		limit: 1,
	});
	for (const thread of channels) {
		if (thread.softDeleted || thread.parentId === null) continue;
		if (thread.type !== ChannelTypes.PUBLIC_THREAD && thread.type !== ChannelTypes.ANNOUNCEMENT_THREAD) continue;
		const parent = byId.get(thread.parentId);
		if (!parent || THREAD_ONLY_CHANNEL_TYPES.has(parent.type)) continue;
		const messageId = createMessageID(thread.id);
		const row = await fetchOne<{message_id: bigint}>(
			query.bind({
				channel_id: createChannelID(parent.id),
				bucket: BucketUtils.makeBucket(messageId),
				message_id: messageId,
			}),
		);
		if (row) found.add(thread.id);
	}
	return found;
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

type Outcome = 'create' | 'update' | 'same' | 'kept';

interface Counter {
	create: number;
	update: number;
	same: number;
	kept: number;
}

class Report {
	private readonly tables = new Map<string, Counter>();

	record(table: string, outcome: Outcome): void {
		const counter = this.tables.get(table) ?? {create: 0, update: 0, same: 0, kept: 0};
		counter[outcome] += 1;
		this.tables.set(table, counter);
	}

	changes(): number {
		let total = 0;
		for (const counter of this.tables.values()) total += counter.create + counter.update;
		return total;
	}

	print(write: boolean): void {
		const verbCreate = write ? 'created' : 'to create';
		const verbUpdate = write ? 'updated' : 'to update';
		console.log('');
		console.log(`${'table'.padEnd(34)}${verbCreate.padEnd(12)}${verbUpdate.padEnd(12)}${'unchanged'.padEnd(11)}kept`);
		for (const [table, c] of [...this.tables.entries()].sort()) {
			console.log(
				table.padEnd(34) +
					String(c.create).padEnd(12) +
					String(c.update).padEnd(12) +
					String(c.same).padEnd(11) +
					String(c.kept),
			);
		}
		console.log(`total ${write ? 'writes' : 'writes needed'}: ${this.changes()}`);
	}
}

interface Ctx {
	options: Options;
	report: Report;
	/** Run a prepared write; a no-op in dry-run. */
	put(query: PreparedQuery): Promise<void>;
}

async function syncRow<T extends object>(
	ctx: Ctx,
	table: string,
	desired: T,
	existing: T | null,
	write: () => PreparedQuery,
	label: string,
): Promise<Outcome> {
	let outcome: Outcome;
	if (existing === null) outcome = 'create';
	else if (rowsEqual(existing, desired)) outcome = 'same';
	else outcome = 'update';
	ctx.report.record(table, outcome);
	if (outcome !== 'same') {
		if (ctx.options.verbose) {
			console.log(`  ${outcome.toUpperCase()} ${table} ${label} ${JSON.stringify(desired, jsonReplacer)}`);
		}
		if (ctx.options.write) await ctx.put(write());
	}
	return outcome;
}

function jsonReplacer(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? value.toString() : value;
}

const Q = {
	state: Tables.ThreadState.select({where: Tables.ThreadState.where.eq('thread_id'), limit: 1}),
	stats: Tables.ThreadStats.select({where: Tables.ThreadStats.where.eq('thread_id'), limit: 1}),
	byParent: Tables.ThreadsByParent.select({
		where: [Tables.ThreadsByParent.where.eq('parent_id'), Tables.ThreadsByParent.where.eq('thread_id')],
		limit: 1,
	}),
	active: Tables.ActiveThreadsByGuild.select({
		where: [Tables.ActiveThreadsByGuild.where.eq('guild_id'), Tables.ActiveThreadsByGuild.where.eq('thread_id')],
		limit: 1,
	}),
	archivedPartition: Tables.ArchivedThreadsByParent.select({
		where: [
			Tables.ArchivedThreadsByParent.where.eq('parent_id'),
			Tables.ArchivedThreadsByParent.where.eq('is_private'),
		],
	}),
	members: Tables.ThreadMembers.select({where: Tables.ThreadMembers.where.eq('thread_id')}),
	byUser: Tables.ThreadMembersByUser.select({
		where: [
			Tables.ThreadMembersByUser.where.eq('user_id'),
			Tables.ThreadMembersByUser.where.eq('guild_id'),
			Tables.ThreadMembersByUser.where.eq('parent_id'),
			Tables.ThreadMembersByUser.where.eq('is_private'),
			Tables.ThreadMembersByUser.where.eq('thread_id'),
		],
		limit: 1,
	}),
	config: Tables.ThreadParentConfig.select({
		where: [Tables.ThreadParentConfig.where.eq('guild_id'), Tables.ThreadParentConfig.where.eq('channel_id')],
		limit: 1,
	}),
	pin: Tables.ForumPinnedThread.select({where: Tables.ForumPinnedThread.where.eq('parent_id'), limit: 1}),
	threadOnly: Tables.ThreadOnlyChannelsByGuild.select({
		where: [
			Tables.ThreadOnlyChannelsByGuild.where.eq('guild_id'),
			Tables.ThreadOnlyChannelsByGuild.where.eq('channel_id'),
		],
		limit: 1,
	}),
	marker: Tables.GuildThreadState.select({where: Tables.GuildThreadState.where.eq('guild_id'), limit: 1}),
};

async function syncThread(ctx: Ctx, planned: PlannedThread): Promise<void> {
	const {state} = planned;
	const existing = await fetchOne<ThreadStateRow>(Q.state.bind({thread_id: state.thread_id}));
	const protectedByUpstream = existing !== null && existing.state_version > MIGRATED_STATE_VERSION;
	const label = `thread ${planned.threadId}`;

	if (protectedByUpstream) {
		// Upstream has written to this thread since we migrated it: its tables are the truth now.
		ctx.report.record('thread_state', 'kept');
	} else {
		await syncRow(ctx, 'thread_state', state, existing, () => Tables.ThreadState.upsertAll(state), label);
		const stats = await fetchOne<ThreadStatsRow>(Q.stats.bind({thread_id: state.thread_id}));
		await syncRow(ctx, 'thread_stats', planned.stats, stats, () => Tables.ThreadStats.upsertAll(planned.stats), label);
		const byParent = await fetchOne<ThreadsByParentRow>(
			Q.byParent.bind({parent_id: state.parent_id, thread_id: state.thread_id}),
		);
		await syncRow(
			ctx,
			'threads_by_parent',
			planned.byParent,
			byParent,
			() => Tables.ThreadsByParent.upsertAll(planned.byParent),
			label,
		);
		await syncIndexes(ctx, planned, label);
	}
	await syncMembers(ctx, planned, label);
	if (planned.forumPin && !protectedByUpstream) {
		const pin = planned.forumPin;
		const current = await fetchOne<ForumPinnedThreadRow>(Q.pin.bind({parent_id: pin.parent_id}));
		await syncRow(ctx, 'forum_pinned_thread', pin, current, () => Tables.ForumPinnedThread.upsertAll(pin), label);
	}
}

/** Exactly one of active_threads_by_guild / archived_threads_by_parent holds a thread, as repairThreadIndexes does. */
async function syncIndexes(ctx: Ctx, planned: PlannedThread, label: string): Promise<void> {
	const {state} = planned;
	const existingActive = await fetchOne<ActiveThreadsByGuildRow>(
		Q.active.bind({guild_id: state.guild_id, thread_id: state.thread_id}),
	);
	if (planned.active) {
		const active = planned.active;
		await syncRow(
			ctx,
			'active_threads_by_guild',
			active,
			existingActive,
			() => Tables.ActiveThreadsByGuild.upsertAll(active),
			label,
		);
	} else if (existingActive !== null) {
		ctx.report.record('active_threads_by_guild', 'update');
		if (ctx.options.write) {
			await deleteOneOrMany(
				Tables.ActiveThreadsByGuild.deleteByPk({guild_id: state.guild_id, thread_id: state.thread_id}),
			);
		}
	}
	const stale: Array<ArchivedThreadsByParentRow> = [];
	let existingArchived: ArchivedThreadsByParentRow | null = null;
	for (const isPrivate of [false, true]) {
		const rows = await fetchMany<ArchivedThreadsByParentRow>(
			Q.archivedPartition.bind({parent_id: state.parent_id, is_private: isPrivate}),
		);
		for (const row of rows) {
			if (row.thread_id !== state.thread_id) continue;
			const wanted = planned.archived;
			if (
				wanted &&
				row.is_private === wanted.is_private &&
				row.archive_timestamp.getTime() === wanted.archive_timestamp.getTime()
			) {
				existingArchived = row;
			} else {
				stale.push(row);
			}
		}
	}
	for (const row of stale) {
		ctx.report.record('archived_threads_by_parent', 'update');
		if (ctx.options.write) {
			await deleteOneOrMany(
				Tables.ArchivedThreadsByParent.deleteByPk({
					parent_id: row.parent_id,
					is_private: row.is_private,
					archive_timestamp: row.archive_timestamp,
					thread_id: row.thread_id,
				}),
			);
		}
	}
	if (planned.archived) {
		const archived = planned.archived;
		await syncRow(
			ctx,
			'archived_threads_by_parent',
			archived,
			existingArchived,
			() => Tables.ArchivedThreadsByParent.upsertAll(archived),
			label,
		);
	}
}

async function syncMembers(ctx: Ctx, planned: PlannedThread, label: string): Promise<void> {
	const existing = await fetchMany<ThreadMemberRow>(Q.members.bind({thread_id: planned.state.thread_id}));
	const byUserId = new Map(existing.map((row) => [row.user_id, row]));
	for (const member of planned.members) {
		const current = byUserId.get(member.user_id) ?? null;
		if (ctx.options.delta && current !== null) {
			ctx.report.record('thread_members', 'kept');
			continue;
		}
		// Merging keeps the fork's own fields (they share the primary key), so rollback still reads them.
		await syncRow(
			ctx,
			'thread_members',
			member,
			current,
			() => Tables.ThreadMembers.upsertAll(member),
			`${label} user ${member.user_id}`,
		);
	}
	if (ctx.options.preCutover) {
		ctx.report.record('thread_members_by_user', 'kept');
		return;
	}
	for (const row of planned.byUser) {
		const current = await fetchOne<ThreadMembersByUserRow>(
			Q.byUser.bind({
				user_id: row.user_id,
				guild_id: row.guild_id,
				parent_id: row.parent_id,
				is_private: row.is_private,
				thread_id: row.thread_id,
			}),
		);
		await syncRow(
			ctx,
			'thread_members_by_user',
			row,
			current,
			() => Tables.ThreadMembersByUser.upsertAll(row),
			`${label} user ${row.user_id}`,
		);
	}
}

async function syncParent(ctx: Ctx, planned: PlannedParent): Promise<void> {
	const {config} = planned;
	const existing = await fetchOne<ThreadParentConfigRow>(
		Q.config.bind({guild_id: config.guild_id, channel_id: config.channel_id}),
	);
	const label = `channel ${planned.channelId}`;
	// default_tag_setting and has_threads have no fork source or only ever turn on: never clear what upstream wrote.
	const merged: ThreadParentConfigRow = planned.isThreadOnly
		? {
				...config,
				default_tag_setting: existing?.default_tag_setting ?? null,
				has_threads: config.has_threads ?? existing?.has_threads ?? null,
			}
		: {...(existing ?? config), has_threads: true};
	if (ctx.options.delta && existing !== null && !(existing.has_threads !== true && merged.has_threads === true)) {
		ctx.report.record('thread_parent_config', 'kept');
		return;
	}
	const desired = ctx.options.delta && existing !== null ? {...existing, has_threads: merged.has_threads} : merged;
	await syncRow(
		ctx,
		'thread_parent_config',
		desired,
		existing,
		() => Tables.ThreadParentConfig.upsertAll(desired),
		label,
	);
}

async function syncPlan(ctx: Ctx, plan: MigrationPlan): Promise<void> {
	for (const row of plan.threadOnly) {
		const existing = await fetchOne<ThreadOnlyChannelsByGuildRow>(
			Q.threadOnly.bind({guild_id: row.guild_id, channel_id: row.channel_id}),
		);
		await syncRow(
			ctx,
			'thread_only_channels_by_guild',
			row,
			existing,
			() => Tables.ThreadOnlyChannelsByGuild.upsertAll(row),
			`channel ${row.channel_id}`,
		);
	}
	for (const parent of plan.parents) await syncParent(ctx, parent);
	for (const thread of plan.threads) await syncThread(ctx, thread);
	for (const marker of plan.guildMarkers) {
		const existing = await fetchOne<GuildThreadStateRow>(Q.marker.bind({guild_id: marker.guild_id}));
		if (existing !== null) {
			// Never touch an existing marker: perms_seeded_at and search_backfilled_at belong to upstream's jobs.
			ctx.report.record('guild_thread_state', 'same');
			continue;
		}
		await syncRow(
			ctx,
			'guild_thread_state',
			marker,
			null,
			() => Tables.GuildThreadState.upsertAll(marker),
			`guild ${marker.guild_id}`,
		);
	}
}

function printPlan(plan: MigrationPlan, legacy: LegacySnapshot): void {
	const live = legacy.channels.filter((c) => !c.softDeleted);
	console.log(
		`old data: ${live.length} live channels, ${legacy.channels.length - live.length} soft-deleted, ${legacy.rawMemberRows} thread_members rows, ${legacy.legacyByUserRows.length} legacy thread_members_by_user rows`,
	);
	console.log(
		`plan: ${plan.threads.length} threads, ${plan.parents.length} parent configs, ${plan.threadOnly.length} thread-only channels, ${plan.guildMarkers.length} guild markers`,
	);
	for (const parent of plan.parents) {
		const tags = parent.config.available_tags?.length ?? 0;
		console.log(
			`  parent ${parent.channelId} guild ${parent.guildId} ${parent.isThreadOnly ? 'forum' : 'text'} threads=${parent.threadCount} flags=${parent.config.flags ?? 0} tags=${tags} layout=${parent.config.default_forum_layout ?? '-'} sort=${parent.config.default_sort_order ?? '-'}`,
		);
	}
	for (const thread of plan.threads) {
		const s = thread.state;
		console.log(
			`  thread ${thread.threadId} guild ${s.guild_id} parent ${s.parent_id} type=${s.type} ${s.archived ? 'archived' : 'active'}${s.locked ? ' locked' : ''}${s.flags !== 0 ? ` flags=${s.flags}` : ''} members=${s.member_count} rows=${thread.members.length} messages=${thread.stats.message_count} tags=${s.applied_tags?.length ?? 0} starter=${s.has_starter}`,
		);
	}
	for (const skipped of plan.skippedThreads) console.log(`  SKIP thread ${skipped.id}: ${skipped.reason}`);
	const orphanRows = plan.skippedMemberGroups.reduce((sum, group) => sum + group.count, 0);
	console.log(
		`skipped orphaned thread_members groups: ${plan.skippedMemberGroups.length} (${orphanRows} rows, their thread channel row no longer exists)`,
	);
	for (const warning of plan.warnings) console.log(`  WARN ${warning}`);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

class Checks {
	failures: Array<string> = [];
	passes = 0;

	expect(name: string, actual: unknown, expected: unknown): void {
		if (JSON.stringify(actual, jsonReplacer) === JSON.stringify(expected, jsonReplacer)) {
			this.passes += 1;
			return;
		}
		this.failures.push(
			`${name}: expected ${JSON.stringify(expected, jsonReplacer)}, got ${JSON.stringify(actual, jsonReplacer)}`,
		);
	}
}

async function verify(fullPlan: MigrationPlan, legacy: LegacySnapshot, options: Options): Promise<number> {
	// A thread upstream has written to since (state_version above ours) legitimately differs from the old columns.
	const touched = new Set(
		(await readKvTable('thread_state'))
			.map((row) => row.row_data as Record<string, unknown>)
			.filter((data) => Number(data['state_version'] ?? 0) > MIGRATED_STATE_VERSION)
			.map((data) => id(data['thread_id'])),
	);
	const plan: MigrationPlan = {...fullPlan, threads: fullPlan.threads.filter((t) => !touched.has(t.threadId))};
	if (touched.size > 0) {
		console.log(
			`info ${touched.size} thread(s) already modified by upstream code (state_version > 1) are not compared`,
		);
	}
	const checks = new Checks();
	const messageStub = {} as IMessageRepository;
	const channelData = new ChannelDataRepository();
	const threads = new ThreadRepository(channelData, messageStub);
	const byId = new Map(legacy.channels.filter((c) => !c.softDeleted).map((c) => [c.id, c]));

	console.log('--- counts: old columns vs migrated tables ---');
	const oldThreads = plan.threads.map((t) => byId.get(t.threadId)!);
	const expected = {
		thread_state: oldThreads.length,
		thread_stats: oldThreads.length,
		threads_by_parent: oldThreads.length,
		active: oldThreads.filter((t) => !t.archived).length,
		archived: oldThreads.filter((t) => t.archived).length,
		locked: oldThreads.filter((t) => t.locked).length,
		pinned: oldThreads.filter((t) => t.pinned).length,
		forum_posts: oldThreads.filter((t) => THREAD_ONLY_CHANNEL_TYPES.has(byId.get(t.parentId!)!.type)).length,
		forums: legacy.channels.filter((c) => !c.softDeleted && THREAD_ONLY_CHANNEL_TYPES.has(c.type)).length,
		members: oldThreads.reduce((sum, t) => sum + legacy.members.filter((m) => m.threadId === t.id).length, 0),
	};
	const stateRows = await fetchManyAll<ThreadStateRow>('thread_state');
	const planned = new Set(plan.threads.map((t) => t.threadId));
	const migratedStates = stateRows.filter((row) => planned.has(row.thread_id));
	const actual = {
		thread_state: migratedStates.length,
		thread_stats: (await fetchManyAll<ThreadStatsRow>('thread_stats')).filter((r) => planned.has(r.thread_id)).length,
		threads_by_parent: (await fetchManyAll<ThreadsByParentRow>('threads_by_parent')).filter((r) =>
			planned.has(r.thread_id),
		).length,
		active: (await fetchManyAll<ActiveThreadsByGuildRow>('active_threads_by_guild')).filter((r) =>
			planned.has(r.thread_id),
		).length,
		archived: (await fetchManyAll<ArchivedThreadsByParentRow>('archived_threads_by_parent')).filter((r) =>
			planned.has(r.thread_id),
		).length,
		locked: migratedStates.filter((r) => r.locked).length,
		pinned: migratedStates.filter((r) => (r.flags & ChannelFlags.PINNED) !== 0).length,
		forum_posts: migratedStates.filter((r) => THREAD_ONLY_CHANNEL_TYPES.has(byId.get(r.parent_id)?.type ?? -1)).length,
		forums: (await fetchManyAll<ThreadOnlyChannelsByGuildRow>('thread_only_channels_by_guild')).length,
		members: (await fetchManyAll<ThreadMemberRow>('thread_members')).filter((r) => planned.has(r.thread_id)).length,
	};
	for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
		const mark = expected[key] === actual[key] ? 'ok  ' : 'FAIL';
		console.log(`${mark} ${key.padEnd(20)} old=${expected[key]} new=${actual[key]}`);
		checks.expect(`count ${key}`, actual[key], expected[key]);
	}
	if (!options.preCutover) {
		const byUser = (await readKvTable('thread_members_by_user')).filter(
			(row) =>
				!isLegacyByUserRow(row.row_data) &&
				planned.has(createChannelID(id((row.row_data as Record<string, unknown>)['thread_id']))),
		).length;
		console.log(
			`${byUser === expected.members ? 'ok  ' : 'FAIL'} ${'members_by_user'.padEnd(20)} old=${expected.members} new=${byUser}`,
		);
		checks.expect('count thread_members_by_user', byUser, expected.members);
	}
	console.log(
		`info orphaned member groups skipped: ${plan.skippedMemberGroups.length} (${plan.skippedMemberGroups.reduce((s, g) => s + g.count, 0)} rows)`,
	);
	console.log(`info legacy thread_members_by_user rows still present: ${legacy.legacyByUserRows.length}`);

	let duplicateJoins = 0;
	const sampled = new Set<string>();
	console.log('--- per-thread read-back through ThreadRepository and mapThreadToResponse ---');
	for (const thread of plan.threads) {
		const old = byId.get(thread.threadId)!;
		const parentOld = byId.get(old.parentId!)!;
		const id = createChannelID(thread.threadId);
		const state = await threads.getState(id);
		const stats = await threads.getStats(id);
		const row = await channelData.findUnique(id);
		const name = `thread ${thread.threadId}`;
		if (!state || !row) {
			checks.failures.push(`${name}: missing ${state ? 'channel row' : 'thread_state'}`);
			continue;
		}
		const response = mapThreadToResponse({channel: row, state, stats, parentType: parentOld.type});
		if (options.verbose && isSample(old, parentOld, sampled)) {
			console.log(`sample ${name} (mapThreadToResponse): ${JSON.stringify(response)}`);
		}
		checks.expect(`${name} archived`, response.thread_metadata?.archived, old.archived);
		checks.expect(`${name} locked`, response.thread_metadata?.locked, old.locked);
		checks.expect(
			`${name} member_count`,
			response.member_count,
			Math.min(
				old.memberCount ?? legacy.members.filter((m) => m.threadId === old.id).length,
				THREAD_MEMBER_COUNT_DISPLAY_CAP,
			),
		);
		checks.expect(`${name} message_count`, response.message_count, Math.max(0, old.messageCount ?? 0));
		checks.expect(`${name} total_message_sent`, response.total_message_sent, Math.max(0, old.messageCount ?? 0));
		checks.expect(
			`${name} auto_archive_duration`,
			response.thread_metadata?.auto_archive_duration,
			mapAutoArchiveDuration(old.autoArchiveDuration) ?? DEFAULT_THREAD_AUTO_ARCHIVE_DURATION,
		);
		if (old.archiveTimestamp) {
			checks.expect(
				`${name} archive_timestamp`,
				response.thread_metadata?.archive_timestamp,
				old.archiveTimestamp.toISOString(),
			);
		}
		if (old.createTimestamp) {
			checks.expect(
				`${name} create_timestamp`,
				response.thread_metadata?.create_timestamp,
				old.createTimestamp.toISOString(),
			);
		}
		checks.expect(
			`${name} flags pinned`,
			(response.flags ?? 0) & ChannelFlags.PINNED,
			old.pinned && !old.archived && THREAD_ONLY_CHANNEL_TYPES.has(parentOld.type) ? ChannelFlags.PINNED : 0,
		);
		if (THREAD_ONLY_CHANNEL_TYPES.has(parentOld.type)) {
			checks.expect(`${name} applied_tags`, response.applied_tags, old.appliedTags.map(String));
		}
		const members = await threads.listMembers(id, {limit: 1000});
		const oldMembers = legacy.members
			.filter((m) => m.threadId === old.id)
			.map((m) => m.userId.toString())
			.sort();
		checks.expect(`${name} members`, members.map((m) => m.userId.toString()).sort(), oldMembers);
		for (const member of members) {
			checks.expect(`${name} member ${member.userId} muted`, member.muted, false);
			if (!options.preCutover) {
				const joined = await threads.listJoinedThreadIds(member.userId, createGuildID(old.guildId!));
				checks.expect(`${name} joined by ${member.userId}`, joined.includes(id), true);
				const copies = joined.filter((candidate) => candidate === id).length;
				if (copies > 1) duplicateJoins += 1;
			}
		}
		checks.expect(
			`${name} indexed as ${old.archived ? 'archived' : 'active'}`,
			await indexedAs(threads, thread),
			old.archived ? 'archived' : 'active',
		);
		if (old.archived === false) {
			const pin = await threads.getForumPin(createChannelID(old.parentId!));
			const shouldPin = response.flags !== undefined && (response.flags & ChannelFlags.PINNED) !== 0;
			if (shouldPin) checks.expect(`${name} forum pin holder`, pin, id);
		}
	}

	console.log(
		`info listJoinedThreadIds returned a thread twice for ${duplicateJoins} member(s) (legacy by-user rows sit beside the new ones)`,
	);
	console.log('--- per-parent read-back through getParentConfig and mapThreadParentFields ---');
	for (const parent of plan.parents) {
		const old = byId.get(parent.channelId)!;
		const config = await threads.getParentConfig(createGuildID(parent.guildId), createChannelID(parent.channelId));
		const name = `${parent.isThreadOnly ? 'forum' : 'channel'} ${parent.channelId}`;
		if (!config) {
			checks.failures.push(`${name}: no thread_parent_config`);
			continue;
		}
		checks.expect(`${name} has_threads`, config.hasThreads, parent.threadCount > 0);
		if (!parent.isThreadOnly) continue;
		const fields = mapThreadParentFields(old.type, config);
		if (options.verbose) {
			console.log(`sample ${name} (mapThreadParentFields): ${JSON.stringify(fields)}`);
		}
		checks.expect(
			`${name} available_tags`,
			fields.available_tags,
			old.availableTags.map((tag) => ({
				id: tag.id.toString(),
				name: tag.name,
				moderated: tag.moderated,
				emoji_id: null,
				emoji_name: tag.emojiName,
			})),
		);
		checks.expect(
			`${name} require_tag flag`,
			((fields.flags ?? 0) & ChannelFlags.REQUIRE_TAG) !== 0,
			old.forumRequireTag,
		);
		checks.expect(
			`${name} default_reaction_emoji`,
			fields.default_reaction_emoji ?? null,
			old.defaultReactionEmoji &&
				(old.defaultReactionEmoji.emojiId !== null || old.defaultReactionEmoji.emojiName !== null)
				? {
						emoji_id: old.defaultReactionEmoji.emojiId?.toString() ?? null,
						emoji_name: old.defaultReactionEmoji.emojiName,
					}
				: null,
		);
		checks.expect(`${name} default_sort_order`, fields.default_sort_order ?? null, old.defaultSortOrder);
		checks.expect(`${name} default_forum_layout`, fields.default_forum_layout, old.defaultForumLayout ?? 0);
		checks.expect(
			`${name} default_thread_rate_limit_per_user`,
			fields.default_thread_rate_limit_per_user,
			old.defaultThreadRateLimitPerUser ?? 0,
		);
		checks.expect(
			`${name} default_auto_archive_duration`,
			fields.default_auto_archive_duration ?? null,
			old.forumDefaultAutoArchiveDuration,
		);
	}

	console.log('--- per-guild spot check through the repository list calls ---');
	const guildIds = new Set<bigint>([
		...plan.threads.map((t) => t.state.guild_id),
		...plan.threadOnly.map((t) => t.guild_id),
	]);
	for (const guildId of [...guildIds].sort()) {
		const gid = createGuildID(guildId);
		const oldGuildThreads = oldThreads.filter((t) => t.guildId === guildId);
		const allActive = await threads.listActiveThreads(gid);
		const activeIds = allActive
			.filter((s) => !touched.has(s.threadId))
			.map((s) => s.threadId.toString())
			.sort();
		checks.expect(
			`guild ${guildId} active threads`,
			activeIds,
			oldGuildThreads
				.filter((t) => !t.archived)
				.map((t) => t.id.toString())
				.sort(),
		);
		checks.expect(`guild ${guildId} countActiveThreads`, await threads.countActiveThreads(gid), allActive.length);
		const parentIds = new Set(oldGuildThreads.map((t) => t.parentId!));
		for (const parentId of parentIds) {
			const pid = createChannelID(parentId);
			const archivedIds: Array<string> = [];
			for (const isPrivate of [false, true]) {
				let before: Date | undefined;
				for (;;) {
					const page = await threads.listArchivedThreads(pid, isPrivate, {limit: 100, ...(before ? {before} : {})});
					for (const s of page.threads) if (!touched.has(s.threadId)) archivedIds.push(s.threadId.toString());
					if (!page.hasMore || page.threads.length === 0) break;
					before = new Date(page.threads[page.threads.length - 1]!.archiveTimestamp!.getTime() - 1);
				}
			}
			checks.expect(
				`guild ${guildId} parent ${parentId} archived threads`,
				archivedIds.sort(),
				oldGuildThreads
					.filter((t) => t.parentId === parentId && t.archived)
					.map((t) => t.id.toString())
					.sort(),
			);
			const childIds = (await threads.listThreadIdsByParent(pid, {limit: 1000}))
				.filter((child) => !touched.has(child))
				.map(String)
				.sort();
			checks.expect(
				`guild ${guildId} parent ${parentId} listThreadIdsByParent`,
				childIds,
				oldGuildThreads
					.filter((t) => t.parentId === parentId)
					.map((t) => t.id.toString())
					.sort(),
			);
		}
		const listed = await channelData.listGuildChannels(gid, 'enrolled').catch(() => null);
		void listed;
		const marker = await threads.getGuildMarker(gid);
		checks.expect(`guild ${guildId} guild_thread_state present`, marker !== null, true);
		checks.expect(`guild ${guildId} perms_seeded_at untouched`, marker?.perms_seeded_at ?? null, null);
		console.log(`guild ${guildId}: ${oldGuildThreads.length} threads checked`);
	}

	console.log('');
	console.log(`verify: ${checks.passes} checks passed, ${checks.failures.length} failed`);
	for (const failure of checks.failures) console.log(`  FAIL ${failure}`);
	return checks.failures.length;
}

/** One thread of each interesting kind, so --verify --verbose shows real mapper output without printing everything. */
function isSample(thread: LegacyChannel, parent: LegacyChannel, seen: Set<string>): boolean {
	const kinds = [
		THREAD_ONLY_CHANNEL_TYPES.has(parent.type) ? 'forum-post' : 'text-thread',
		...(thread.locked ? ['locked'] : []),
		...(thread.appliedTags.length > 0 ? ['tagged'] : []),
		...(thread.archived ? [] : ['active']),
	];
	const fresh = kinds.filter((kind) => !seen.has(kind));
	for (const kind of kinds) seen.add(kind);
	return fresh.length > 0;
}

async function indexedAs(threads: ThreadRepository, thread: PlannedThread): Promise<'active' | 'archived' | 'none'> {
	const guildId = thread.state.guild_id;
	const active = (await threads.listActiveThreads(guildId)).some((s) => s.threadId === thread.state.thread_id);
	let archived = false;
	for (const isPrivate of [false, true]) {
		const page = await threads.listArchivedThreads(thread.state.parent_id, isPrivate, {limit: 100});
		if (page.threads.some((s) => s.threadId === thread.state.thread_id)) archived = true;
	}
	if (active && archived) return 'none';
	return active ? 'active' : archived ? 'archived' : 'none';
}

async function fetchManyAll<T>(tableName: string): Promise<Array<T>> {
	const client = getDefaultPostgresClient();
	const meta = TABLES_BY_NAME[tableName];
	if (!meta) throw new Error(`unknown table ${tableName}`);
	const result = await client.query<{row_data: Record<string, unknown>}>(
		`SELECT row_data FROM ${client.kvTable()} WHERE table_name = $1`,
		[tableName],
	);
	return result.rows.map((row) => meta(row.row_data) as T);
}

function id(value: unknown): bigint {
	const v = value as {value?: unknown} | string | number | bigint;
	if (typeof v === 'object' && v !== null && 'value' in v) return BigInt(String(v.value));
	return BigInt(v as string | number | bigint);
}

function date(value: unknown): Date {
	const v = value as {value?: unknown} | string;
	return new Date(String(typeof v === 'object' && v !== null && 'value' in v ? v.value : v));
}

/** Minimal decoders so the verify counts do not depend on the DSL they are checking. */
const TABLES_BY_NAME: Record<string, (row: Record<string, unknown>) => unknown> = {
	thread_state: (r) => ({
		thread_id: createChannelID(id(r['thread_id'])),
		parent_id: createChannelID(id(r['parent_id'])),
		locked: r['locked'] === true,
		flags: Number(r['flags'] ?? 0),
	}),
	thread_stats: (r) => ({thread_id: createChannelID(id(r['thread_id']))}),
	threads_by_parent: (r) => ({thread_id: createChannelID(id(r['thread_id']))}),
	active_threads_by_guild: (r) => ({thread_id: createChannelID(id(r['thread_id']))}),
	archived_threads_by_parent: (r) => ({
		thread_id: createChannelID(id(r['thread_id'])),
		archive_timestamp: date(r['archive_timestamp']),
	}),
	thread_only_channels_by_guild: (r) => ({channel_id: createChannelID(id(r['channel_id']))}),
	thread_members: (r) => ({
		thread_id: createChannelID(id(r['thread_id'])),
		user_id: createUserID(id(r['user_id'])),
		guild_id: r['guild_id'],
	}),
	thread_members_by_user: (r) => ({
		thread_id: createChannelID(id(r['thread_id'])),
		user_id: createUserID(id(r['user_id'])),
	}),
};

// ---------------------------------------------------------------------------
// Cleanup (post-cutover)
// ---------------------------------------------------------------------------

async function cleanupLegacy(plan: MigrationPlan, legacy: LegacySnapshot, options: Options): Promise<void> {
	const client = getDefaultPostgresClient();
	const migrated = new Set(plan.threads.map((t) => t.threadId));
	const newByUser = new Set<string>();
	for (const row of await fetchManyAll<ThreadMembersByUserRow>('thread_members_by_user')) {
		newByUser.add(`${row.user_id}:${row.thread_id}`);
	}
	const doomed: Array<KvRow & {table_name: string}> = [];
	const refused: Array<string> = [];
	for (const row of legacy.legacyByUserRows) {
		const data = row.row_data as Record<string, unknown>;
		const threadId = id(data['thread_id']);
		const userId = id(data['user_id']);
		if (migrated.has(threadId) && !newByUser.has(`${userId}:${threadId}`)) {
			refused.push(`user ${userId} thread ${threadId}`);
			continue;
		}
		doomed.push({table_name: 'thread_members_by_user', ...row});
	}
	console.log(
		`legacy thread_members_by_user rows: ${legacy.legacyByUserRows.length}, deletable ${doomed.length}, refused ${refused.length}`,
	);
	for (const line of refused) console.log(`  REFUSED (no replacement row yet): ${line}`);

	const forumIds = new Set(plan.threadOnly.map((t) => t.channel_id));
	const forumIndexRows = (await readKvTable('channels_by_guild_id')).filter((row) => {
		const data = row.row_data as Record<string, unknown>;
		return forumIds.has(createChannelID(id(data['channel_id'])));
	});
	for (const row of forumIndexRows) doomed.push({table_name: 'channels_by_guild_id', ...row});
	console.log(`forum rows in channels_by_guild_id: ${forumIndexRows.length}`);

	if (!options.write) {
		console.log(`cleanup preview: would delete ${doomed.length} rows. Re-run with --apply --backup-file <path>.`);
		return;
	}
	writeFileSync(
		options.backupFile!,
		doomed.map((row) => JSON.stringify(row)).join('\n') + (doomed.length > 0 ? '\n' : ''),
	);
	console.log(`saved ${doomed.length} rows to ${options.backupFile}`);
	for (const table of ['thread_members_by_user', 'channels_by_guild_id']) {
		const keys = doomed.filter((row) => row.table_name === table).map((row) => row.row_key);
		if (keys.length === 0) continue;
		await client.query(`DELETE FROM ${client.kvTable()} WHERE table_name = $1 AND row_key = ANY($2::text[])`, [
			table,
			keys,
		]);
		console.log(`deleted ${keys.length} rows from ${table}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseOptions();
	const config = readPgConfig();
	const host = hostOf(config);
	if (!isLoopback(host) && !options.allowRemote) {
		throw new Error(`Refusing to connect to non-loopback host "${host}" without --allow-remote.`);
	}
	const modeLabel =
		options.mode === 'verify'
			? 'verify'
			: options.mode === 'cleanup'
				? `cleanup-legacy${options.write ? ' (apply)' : ' (preview)'}`
				: options.write
					? options.delta
						? 'delta'
						: 'apply'
					: options.delta
						? 'dry-run (delta rules)'
						: 'dry-run';
	console.log(`MigrateForkThreads mode=${modeLabel}${options.preCutover ? ' pre-cutover' : ''} target=${host}`);

	await initPostgres({...config});
	try {
		const client = getDefaultPostgresClient();
		const writes = options.write && options.mode === 'sync';
		if (writes) await ensurePostgresKvSchema(client);
		setDatabaseQueryExecutor(new PostgresKvQueryExecutor(client));

		const legacy = await readLegacy();
		const starterThreadIds = await findStarterThreads(legacy.channels);
		const plan = planMigration({
			channels: legacy.channels,
			members: legacy.members,
			starterThreadIds,
		});

		if (options.mode === 'verify') {
			const failures = await verify(plan, legacy, options);
			process.exitCode = failures === 0 ? 0 : 1;
			return;
		}
		if (options.mode === 'cleanup') {
			await cleanupLegacy(plan, legacy, options);
			return;
		}

		printPlan(plan, legacy);
		const report = new Report();
		const ctx: Ctx = {
			options,
			report,
			put: async (query) => {
				await upsertOne(query);
			},
		};
		await syncPlan(ctx, plan);
		report.print(options.write);
		if (!options.write) console.log('dry run: nothing was written.');
	} finally {
		setDatabaseQueryExecutor(null);
		await shutdownPostgres().catch(() => {});
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 1;
});
