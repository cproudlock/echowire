// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MigrateScyllaToPostgres
 *
 * One-shot data migration that copies durable application data FROM the old
 * production ScyllaDB (keyspace `fluxer`, old-arch) INTO the new-arch Postgres
 * `fluxer_kv` wide-column table.
 *
 * Design (the crux):
 *   - READ the source with a RAW `cassandra-driver` client pointed at prod Scylla.
 *     We do NOT use the DSL for reads: the DSL reads/writes the *target* store,
 *     while the source is a real Cassandra/Scylla cluster. The raw client uses the
 *     SAME encoding options as `@pkgs/cassandra/src/Client` so bigints/sets/maps
 *     decode identically. Reads are read-only (SELECT with LOCAL_ONE + paging).
 *   - WRITE the target by reusing the app's own writer, so key/value encoding can
 *     never drift: we init a Postgres pool, `ensurePostgresKvSchema(pool)`, then
 *     `setDatabaseQueryExecutor(new PostgresKvQueryExecutor(pool))`, and write each
 *     row through the target table's DSL upsert (`Tables.<X>.upsertAll(row)`), whose
 *     `.execute()` path now routes through the Postgres KV executor. This means the
 *     writer handles bigint-tagging, dates, buffers, sets/maps, and the 2-segment
 *     messages partition key for us — we never hand-encode row_key/partition_key/row_data.
 *
 * Usage:
 *   pnpm --filter fluxer_api exec tsx scripts/MigrateScyllaToPostgres.ts [flags]
 *
 * Env (source):
 *   MIGRATE_SCYLLA_CONTACT_POINTS   comma-separated host list (required)
 *   MIGRATE_SCYLLA_PORT             default 9042
 *   MIGRATE_SCYLLA_LOCAL_DC         default datacenter1
 *   MIGRATE_SCYLLA_KEYSPACE         default fluxer
 *   MIGRATE_SCYLLA_USERNAME         optional
 *   MIGRATE_SCYLLA_PASSWORD         optional
 *
 * Env (target):
 *   MIGRATE_PG_URL                  full connection string (takes precedence), OR
 *   MIGRATE_PG_HOST / MIGRATE_PG_PORT / MIGRATE_PG_DATABASE / MIGRATE_PG_USER / MIGRATE_PG_PASSWORD
 *   MIGRATE_PG_KV_TABLE             default fluxer_kv
 *
 * Flags:
 *   --dry-run            read + count source rows, do NOT write
 *   --only <t[,t]>       restrict to these tables (repeatable and/or comma-separated)
 *   --limit <n>          cap rows per table (for testing)
 *   --verbose            per-row / progress logging
 */

import {
	BatchBuilder,
	setDatabaseQueryExecutor,
} from '@app/api/database/CassandraQueryExecution';
import {ensurePostgresKvSchema, PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import * as Tables from '@app/api/Tables';
import {getDefaultPostgresClient, initPostgres, shutdownPostgres} from '@pkgs/postgres/src/Client';
import cassandra from 'cassandra-driver';
import {parseArgs} from 'node:util';

// ---------------------------------------------------------------------------
// Table lists
// ---------------------------------------------------------------------------

/**
 * Source tables to migrate, from a live prod inventory of non-empty tables.
 * Each name is matched (by CQL table name) to the same-named target `Tables.*`
 * object. Any entry without a matching target object is skipped with a warning
 * (schema diverged) rather than crashing the run.
 */
const MIGRATE_TABLES: ReadonlyArray<string> = [
	'channels',
	'channels_by_guild_id',
	'channel_state',
	'channel_message_buckets',
	'channel_empty_buckets',
	'channel_pins',
	'messages',
	'messages_by_author_id',
	'messages_by_author_id_v2',
	'message_reactions',
	'users',
	'users_by_username',
	'users_by_email',
	'users_by_stripe_customer_id',
	'user_settings',
	'user_guild_settings',
	'user_dm_history',
	'guilds',
	'guild_members',
	'guild_members_by_user_id',
	'guild_roles',
	'guild_audit_logs_v2',
	'guild_audit_logs_v2_by_user',
	'guild_audit_logs_v2_by_action',
	'guild_audit_logs_v2_by_user_action',
	'guild_scheduled_event_users',
	'guild_discovery',
	'thread_members',
	'thread_members_by_user',
	'active_threads_by_guild',
	'read_states',
	'invites',
	'invites_by_channel_id',
	'invites_by_guild_id',
	'private_channels',
	'dm_states',
	'relationships',
	'relationships_by_target',
	'recent_mentions',
	'recent_mentions_by_guild',
	'attachment_lookup',
	'attachment_decay_by_id',
	'attachment_decay_by_expiry',
	'webhooks',
	'webhooks_by_channel_id',
	'webhooks_by_guild_id',
	'voice_regions',
	'voice_servers',
	'payments',
	'payments_by_user',
	'oauth_clients',
	'applications',
	'applications_by_owner',
	'admin_audit_logs',
	'instance_configuration',
];

/**
 * Tables that must NEVER be migrated. Decision: users re-authenticate after
 * cutover, so all auth/session/token/credential/device tables are dropped; plus
 * non-application (Cassandra system / migration) tables. Applied both to the
 * migrate list and to any table passed via `--only`.
 */
const SKIP_TABLES: ReadonlySet<string> = new Set<string>([
	'auth_sessions',
	'auth_sessions_by_user_id',
	'authorized_ips',
	'authorized_ips_v2',
	'webauthn_credentials',
	'webauthn_credential_lookup',
	'push_devices',
	'push_subscriptions',
	'schema_migrations',
]);

/** System / non-app keyspaces that must never be read from. */
const SYSTEM_KEYSPACE_PREFIXES: ReadonlyArray<string> = ['system', 'system_schema', 'system_auth'];

/**
 * Pattern-based skips (evaluated in addition to SKIP_TABLES): any *_tokens
 * table, beta code tables, oauth2 token tables, and migration bookkeeping.
 */
function isSkippedTable(name: string): boolean {
	if (SKIP_TABLES.has(name)) return true;
	if (name.endsWith('_tokens')) return true;
	if (name.startsWith('beta_codes')) return true;
	if (name.startsWith('oauth2_') && name.includes('token')) return true;
	if (name.includes('schema_migration')) return true;
	if (SYSTEM_KEYSPACE_PREFIXES.some((prefix) => name.startsWith(`${prefix}.`))) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Target table lookup (by CQL name) built from the exported Tables.* objects
// ---------------------------------------------------------------------------

/** Structural view of a DSL table object; enough for the migration write path. */
interface TargetTable {
	name: string;
	columns: ReadonlyArray<string>;
	primaryKey: ReadonlyArray<string>;
	partitionKey: ReadonlyArray<string>;
	upsertAll(row: Record<string, unknown>): PreparedQuery;
}

function isTargetTable(value: unknown): value is TargetTable {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<TargetTable>;
	return (
		typeof candidate.name === 'string' &&
		Array.isArray(candidate.columns) &&
		Array.isArray(candidate.primaryKey) &&
		typeof candidate.upsertAll === 'function'
	);
}

function buildTargetTableLookup(): Map<string, TargetTable> {
	const lookup = new Map<string, TargetTable>();
	for (const exported of Object.values(Tables)) {
		if (isTargetTable(exported)) {
			lookup.set(exported.name, exported);
		}
	}
	return lookup;
}

// ---------------------------------------------------------------------------
// CLI + env config
// ---------------------------------------------------------------------------

interface CliOptions {
	dryRun: boolean;
	only: ReadonlyArray<string> | null;
	limit: number | null;
	verbose: boolean;
}

function parseCliOptions(): CliOptions {
	const {values} = parseArgs({
		args: process.argv.slice(2),
		options: {
			'dry-run': {type: 'boolean', default: false},
			only: {type: 'string', multiple: true},
			limit: {type: 'string'},
			verbose: {type: 'boolean', default: false},
		},
		allowPositionals: false,
	});
	let only: Array<string> | null = null;
	if (values.only && values.only.length > 0) {
		only = values.only
			.flatMap((entry) => entry.split(','))
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	let limit: number | null = null;
	if (typeof values.limit === 'string') {
		const parsed = Number.parseInt(values.limit, 10);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new Error(`--limit must be a positive integer, got ${JSON.stringify(values.limit)}`);
		}
		limit = parsed;
	}
	return {
		dryRun: values['dry-run'] === true,
		only,
		limit,
		verbose: values.verbose === true,
	};
}

interface ScyllaConfig {
	contactPoints: Array<string>;
	port: number;
	localDc: string;
	keyspace: string;
	username?: string;
	password?: string;
}

function readScyllaConfig(): ScyllaConfig {
	const raw = process.env.MIGRATE_SCYLLA_CONTACT_POINTS ?? '';
	const contactPoints = raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (contactPoints.length === 0) {
		throw new Error('MIGRATE_SCYLLA_CONTACT_POINTS is required (comma-separated host list).');
	}
	const portRaw = process.env.MIGRATE_SCYLLA_PORT;
	const port = portRaw ? Number.parseInt(portRaw, 10) : 9042;
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`MIGRATE_SCYLLA_PORT must be a positive integer, got ${JSON.stringify(portRaw)}`);
	}
	return {
		contactPoints,
		port,
		localDc: process.env.MIGRATE_SCYLLA_LOCAL_DC ?? 'datacenter1',
		keyspace: process.env.MIGRATE_SCYLLA_KEYSPACE ?? 'fluxer',
		username: process.env.MIGRATE_SCYLLA_USERNAME || undefined,
		password: process.env.MIGRATE_SCYLLA_PASSWORD || undefined,
	};
}

interface PostgresConfigResolved {
	url?: string;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	kvTable?: string;
}

function readPostgresConfig(): PostgresConfigResolved {
	const kvTable = process.env.MIGRATE_PG_KV_TABLE || undefined;
	const url = process.env.MIGRATE_PG_URL;
	if (url && url.length > 0) {
		return {url, kvTable};
	}
	const host = process.env.MIGRATE_PG_HOST;
	if (!host) {
		throw new Error('Set MIGRATE_PG_URL, or the discrete MIGRATE_PG_HOST/PORT/DATABASE/USER/PASSWORD vars.');
	}
	const portRaw = process.env.MIGRATE_PG_PORT;
	const port = portRaw ? Number.parseInt(portRaw, 10) : 5432;
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`MIGRATE_PG_PORT must be a positive integer, got ${JSON.stringify(portRaw)}`);
	}
	return {
		host,
		port,
		database: process.env.MIGRATE_PG_DATABASE || undefined,
		username: process.env.MIGRATE_PG_USER || undefined,
		password: process.env.MIGRATE_PG_PASSWORD || undefined,
		kvTable,
	};
}

// ---------------------------------------------------------------------------
// Migration engine
// ---------------------------------------------------------------------------

const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 200;

interface TableResult {
	table: string;
	status: 'migrated' | 'dry-run' | 'skipped' | 'no-target' | 'errored';
	sourceRows: number;
	written: number;
	droppedColumns: Array<string>;
	error?: string;
}

const CQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function assertSafeIdentifier(value: string): string {
	if (!CQL_IDENTIFIER.test(value)) {
		throw new Error(`Unsafe CQL identifier: ${JSON.stringify(value)}`);
	}
	return value;
}

function rowToObject(row: cassandra.types.Row, columnNames: ReadonlyArray<string>): Record<string, unknown> {
	const object: Record<string, unknown> = {};
	for (const name of columnNames) {
		object[name] = row.get(name) as unknown;
	}
	return object;
}

/**
 * Project a raw source row onto the columns the target table declares:
 *   - drop any source-only column (record it so we can warn once);
 *   - never invent values for target-only columns — leave them absent so the
 *     upsert's own defaults (e.g. NULL_THREAD_FIELDS) apply.
 * Values (including explicit nulls) are passed through untouched; the writer
 * handles all encoding.
 */
function projectRow(
	source: Record<string, unknown>,
	targetColumns: ReadonlySet<string>,
	droppedColumns: Set<string>,
): Record<string, unknown> {
	const projected: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (!targetColumns.has(key)) {
			droppedColumns.add(key);
			continue;
		}
		if (value === undefined) continue;
		projected[key] = value;
	}
	return projected;
}

async function migrateTable(
	client: cassandra.Client,
	keyspace: string,
	table: TargetTable,
	options: CliOptions,
): Promise<TableResult> {
	const targetColumns = new Set(table.columns);
	const droppedColumns = new Set<string>();
	let sourceRows = 0;
	let written = 0;

	const query = `SELECT * FROM ${assertSafeIdentifier(keyspace)}.${assertSafeIdentifier(table.name)}`;
	let pageState: string | undefined;
	let batch = new BatchBuilder();
	let pending = 0;

	const flush = async (): Promise<void> => {
		if (pending === 0) return;
		await batch.execute(false);
		batch = new BatchBuilder();
		pending = 0;
	};

	scan: do {
		const result = await client.execute(query, [], {
			prepare: false,
			fetchSize: PAGE_SIZE,
			pageState,
			consistency: cassandra.types.consistencies.localOne,
		});
		const columnNames = result.columns.map((column) => column.name);
		for (const row of result.rows) {
			if (options.limit !== null && sourceRows >= options.limit) {
				pageState = undefined;
				break scan;
			}
			sourceRows += 1;
			const source = rowToObject(row, columnNames);
			const projected = projectRow(source, targetColumns, droppedColumns);
			if (options.verbose) {
				console.log(`  [${table.name}] row ${sourceRows}: ${Object.keys(projected).length} target columns`);
			}
			if (!options.dryRun) {
				batch.addPrepared(table.upsertAll(projected));
				pending += 1;
				written += 1;
				if (pending >= WRITE_BATCH_SIZE) {
					await flush();
				}
			}
		}
		pageState = result.pageState ?? undefined;
	} while (pageState);

	if (!options.dryRun) {
		await flush();
	}

	if (droppedColumns.size > 0) {
		console.warn(
			`  [${table.name}] dropped ${droppedColumns.size} source-only column(s): ${[...droppedColumns].sort().join(', ')}`,
		);
	}

	return {
		table: table.name,
		status: options.dryRun ? 'dry-run' : 'migrated',
		sourceRows,
		written,
		droppedColumns: [...droppedColumns].sort(),
	};
}

function selectTables(options: CliOptions): Array<string> {
	if (!options.only) return [...MIGRATE_TABLES];
	const requested = new Set(options.only);
	const selected = MIGRATE_TABLES.filter((table) => requested.has(table));
	for (const table of options.only) {
		if (!MIGRATE_TABLES.includes(table)) {
			console.warn(`--only "${table}" is not in the migrate list; ignoring.`);
		}
	}
	return selected;
}

function printSummary(results: ReadonlyArray<TableResult>): void {
	console.log('\n=== Migration summary ===');
	const nameWidth = Math.max(5, ...results.map((result) => result.table.length));
	const header = `${'table'.padEnd(nameWidth)}  ${'status'.padEnd(10)}  ${'source'.padStart(9)}  ${'written'.padStart(9)}`;
	console.log(header);
	console.log('-'.repeat(header.length));
	for (const result of results) {
		console.log(
			`${result.table.padEnd(nameWidth)}  ${result.status.padEnd(10)}  ${String(result.sourceRows).padStart(9)}  ${String(result.written).padStart(9)}`,
		);
	}
	const totalSource = results.reduce((sum, result) => sum + result.sourceRows, 0);
	const totalWritten = results.reduce((sum, result) => sum + result.written, 0);
	console.log('-'.repeat(header.length));
	console.log(
		`${'TOTAL'.padEnd(nameWidth)}  ${''.padEnd(10)}  ${String(totalSource).padStart(9)}  ${String(totalWritten).padStart(9)}`,
	);
}

async function main(): Promise<void> {
	const options = parseCliOptions();
	const scyllaConfig = readScyllaConfig();
	const postgresConfig = readPostgresConfig();

	console.log(
		`Source Scylla: ${scyllaConfig.contactPoints.join(',')}:${scyllaConfig.port} keyspace=${scyllaConfig.keyspace} dc=${scyllaConfig.localDc}`,
	);
	console.log(`Target Postgres: ${postgresConfig.url ? postgresConfig.url : `${postgresConfig.host}:${postgresConfig.port ?? 5432}`}`);
	console.log(options.dryRun ? 'Mode: DRY RUN (no writes)\n' : 'Mode: WRITE\n');

	const authProvider = scyllaConfig.username
		? new cassandra.auth.PlainTextAuthProvider(scyllaConfig.username, scyllaConfig.password ?? '')
		: undefined;
	const sourceClient = new cassandra.Client({
		contactPoints: scyllaConfig.contactPoints,
		localDataCenter: scyllaConfig.localDc,
		keyspace: scyllaConfig.keyspace,
		protocolOptions: {port: scyllaConfig.port},
		queryOptions: {consistency: cassandra.types.consistencies.localOne},
		// Match @pkgs/cassandra/src/Client encoding so bigints/varints/sets/maps
		// decode to the exact JS shapes the KV writer expects.
		encoding: {
			map: Map,
			set: Set,
			useBigIntAsLong: true,
			useBigIntAsVarint: true,
		},
		...(authProvider ? {authProvider} : {}),
	});

	let postgresInitialized = false;
	const results: Array<TableResult> = [];
	let anyErrored = false;

	try {
		await sourceClient.connect();
		console.log('Connected to source Scylla.');

		// Init the target Postgres pool and route the app's DSL writes to it.
		await initPostgres({
			url: postgresConfig.url,
			host: postgresConfig.host,
			port: postgresConfig.port,
			database: postgresConfig.database,
			username: postgresConfig.username,
			password: postgresConfig.password,
			kvTable: postgresConfig.kvTable,
		});
		postgresInitialized = true;
		const postgresClient = getDefaultPostgresClient();
		if (!options.dryRun) {
			await ensurePostgresKvSchema(postgresClient);
			setDatabaseQueryExecutor(new PostgresKvQueryExecutor(postgresClient));
			console.log(`Ensured Postgres KV schema on table "${postgresClient.kvTable()}".`);
		}
		console.log('');

		const targetLookup = buildTargetTableLookup();
		const tables = selectTables(options);

		for (const tableName of tables) {
			if (isSkippedTable(tableName)) {
				console.warn(`- ${tableName}: SKIPPED (skip list).`);
				results.push({table: tableName, status: 'skipped', sourceRows: 0, written: 0, droppedColumns: []});
				continue;
			}
			const target = targetLookup.get(tableName);
			if (!target) {
				console.warn(`- ${tableName}: NO matching target Tables.* object (schema diverged); skipping.`);
				results.push({table: tableName, status: 'no-target', sourceRows: 0, written: 0, droppedColumns: []});
				continue;
			}
			console.log(`- ${tableName}: migrating...`);
			try {
				const result = await migrateTable(sourceClient, scyllaConfig.keyspace, target, options);
				console.log(`  [${tableName}] source=${result.sourceRows} written=${result.written}`);
				results.push(result);
			} catch (error) {
				anyErrored = true;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`  [${tableName}] ERROR: ${message}`);
				results.push({
					table: tableName,
					status: 'errored',
					sourceRows: 0,
					written: 0,
					droppedColumns: [],
					error: message,
				});
			}
		}
	} finally {
		setDatabaseQueryExecutor(null);
		await sourceClient.shutdown().catch(() => {});
		if (postgresInitialized) {
			await shutdownPostgres().catch(() => {});
		}
	}

	printSummary(results);

	if (anyErrored) {
		console.error('\nOne or more tables errored.');
		process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(`Migration failed: ${message}`);
	process.exitCode = 1;
});
