// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the thread maintenance sweeps used raw SQL only Postgres could answer, so on Cassandra
// they did nothing at all. They now walk guilds and their channels, which both backends serve. The
// enumeration is what was missing, so it is what these cover: the walk itself, and each sweep
// driven through its handler with fake repositories.

import {type ChannelID, createChannelID, createGuildID, createUserID, type GuildID} from '@app/api/BrandedTypes';
import {scanGuildThreads} from '@app/api/channel/services/ThreadSweepScan';
import {Channel} from '@app/api/models/Channel';
import archiveInactiveThreads, {isThreadInactive} from '@app/api/worker/tasks/ArchiveInactiveThreads';
import backfillThreadMembersByUser from '@app/api/worker/tasks/BackfillThreadMembersByUser';
import purgeOrphanedThreads, {isOrphanedThread} from '@app/api/worker/tasks/PurgeOrphanedThreads';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

interface FakeMembership {
	threadId: ChannelID;
	userId: ReturnType<typeof createUserID>;
	joinTimestamp: Date;
	flags: number;
}

// The handlers construct ThreadMemberRepository themselves, so the fake is installed at module
// level and its state reset per test.
const memberState: {members: Array<FakeMembership>; indexed: Array<FakeMembership>; writes: number} = {
	members: [],
	indexed: [],
	writes: 0,
};

vi.mock('@app/api/channel/repositories/ThreadMemberRepository', () => ({
	ThreadMemberRepository: class {
		async listMembers() {
			return memberState.members;
		}
		async listMembershipsForUser(userId: unknown) {
			return memberState.indexed.filter((row) => String(row.userId) === String(userId));
		}
		async writeByUserRow(params: FakeMembership) {
			memberState.indexed.push(params);
			memberState.writes += 1;
		}
		async removeAllMembers() {
			memberState.members = [];
		}
	},
}));

const GUILD = createGuildID(100n);

const warnings: Array<unknown> = [];

function helpers(): WorkerTaskHelpers {
	return {
		logger: {
			info: vi.fn(),
			warn: (...args: Array<unknown>) => {
				warnings.push(args[0]);
			},
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
			fatal: vi.fn(),
		},
		jobId: 1n,
		addJob: vi.fn(),
		reportProgress: vi.fn(),
		shouldCancel: vi.fn().mockResolvedValue(false),
		setContextLink: vi.fn(),
	} as unknown as WorkerTaskHelpers;
}

function channel(overrides: Record<string, unknown>): Channel {
	return new Channel({
		channel_id: createChannelID(1n),
		guild_id: GUILD,
		type: ChannelTypes.GUILD_TEXT,
		name: null,
		topic: null,
		icon_hash: null,
		url: null,
		parent_id: null,
		position: null,
		owner_id: null,
		recipient_ids: null,
		nsfw: null,
		content_warning_level: null,
		content_warning_text: null,
		rate_limit_per_user: null,
		bitrate: null,
		user_limit: null,
		voice_connection_limit: null,
		rtc_region: null,
		last_message_id: null,
		last_pin_timestamp: null,
		permission_overwrites: null,
		nicks: null,
		soft_deleted: false,
		indexed_at: null,
		version: 1,
		...overrides,
	} as never);
}

function thread(id: bigint, parentId: bigint | null, extra: Record<string, unknown> = {}): Channel {
	return channel({
		channel_id: createChannelID(id),
		type: ChannelTypes.PUBLIC_THREAD,
		parent_id: parentId === null ? null : createChannelID(parentId),
		thread_archived: false,
		thread_auto_archive_duration: 60,
		thread_create_timestamp: new Date('2026-09-14T00:00:00.000Z'),
		...extra,
	});
}

function guildSource(guildIds: Array<bigint>) {
	return {
		listAllGuildsPaginated: async (limit: number, lastGuildId?: GuildID) => {
			const all = guildIds.map((id) => ({id: createGuildID(id)}));
			const start = lastGuildId ? all.findIndex((g) => String(g.id) === String(lastGuildId)) + 1 : 0;
			return all.slice(start, start + limit);
		},
	};
}

beforeEach(() => {
	memberState.members = [];
	memberState.indexed = [];
	memberState.writes = 0;
	warnings.length = 0;
});

afterEach(() => {
	clearWorkerDependencies();
	// The sweeps catch per-thread failures and carry on, so an unnoticed warning would let a
	// broken sweep look like a passing test.
	expect(warnings).toEqual([]);
});

describe('scanGuildThreads', () => {
	test('yields only thread channels, archived ones included, and carries the guild channel set', async () => {
		const text = channel({channel_id: createChannelID(1n)});
		const open = thread(2n, 1n);
		const archived = thread(3n, 1n, {thread_archived: true});
		const pages = [];
		for await (const page of scanGuildThreads(guildSource([100n]), {
			listGuildChannels: async () => [text, open, archived],
		})) {
			pages.push(page);
		}
		expect(pages).toHaveLength(1);
		expect(pages[0].threads.map((t) => String(t.id))).toEqual(['2', '3']);
		// The parent is in the set, so the orphan sweep resolves it without another read.
		expect(pages[0].channelsById.get('1')).toBe(text);
	});

	test('skips guilds with no threads and walks past a full page of guilds', async () => {
		const guildIds = Array.from({length: 101}, (_, i) => BigInt(200 + i));
		const seen: Array<string> = [];
		for await (const page of scanGuildThreads(guildSource(guildIds), {
			listGuildChannels: async (guildId) =>
				String(guildId) === '250' ? [thread(2n, 1n), channel({channel_id: createChannelID(1n)})] : [],
		})) {
			seen.push(String(page.guildId));
		}
		expect(seen).toEqual(['250']);
	});
});

describe('archiveInactiveThreads', () => {
	test('archives an inactive thread and dispatches THREAD_UPDATE', async () => {
		const inactive = thread(2n, 1n, {thread_create_timestamp: new Date('2020-01-01T00:00:00.000Z')});
		const active = thread(3n, 1n, {thread_create_timestamp: new Date()});
		const patchThreadFields = vi.fn().mockResolvedValue(undefined);
		const dispatchGuild = vi.fn().mockResolvedValue(undefined);
		setWorkerDependenciesForTest({
			guildRepository: guildSource([100n]) as never,
			channelRepository: {
				channelData: {listGuildChannels: async () => [inactive, active], patchThreadFields},
				findUnique: async (id: ChannelID) => (String(id) === '2' ? inactive : null),
			} as never,
			gatewayService: {dispatchGuild} as never,
			userCacheService: {getUsers: async () => [], getUser: async () => null} as never,
		});
		await archiveInactiveThreads({}, helpers());
		expect(patchThreadFields).toHaveBeenCalledTimes(1);
		expect(String(patchThreadFields.mock.calls[0][0])).toBe('2');
		expect(patchThreadFields.mock.calls[0][1]).toMatchObject({thread_archived: true});
		expect(dispatchGuild).toHaveBeenCalledTimes(1);
		expect(dispatchGuild.mock.calls[0][0]).toMatchObject({event: 'THREAD_UPDATE'});
	});

	test('leaves an already archived thread alone', async () => {
		const archived = thread(2n, 1n, {
			thread_archived: true,
			thread_create_timestamp: new Date('2020-01-01T00:00:00.000Z'),
		});
		const patchThreadFields = vi.fn();
		setWorkerDependenciesForTest({
			guildRepository: guildSource([100n]) as never,
			channelRepository: {
				channelData: {listGuildChannels: async () => [archived], patchThreadFields},
				findUnique: async () => archived,
			} as never,
			gatewayService: {dispatchGuild: vi.fn()} as never,
			userCacheService: {} as never,
		});
		await archiveInactiveThreads({}, helpers());
		expect(patchThreadFields).not.toHaveBeenCalled();
	});
});

describe('purgeOrphanedThreads', () => {
	test('purges a thread whose parent is gone and keeps one whose parent lives', async () => {
		const parent = channel({channel_id: createChannelID(1n)});
		const kept = thread(2n, 1n);
		const orphan = thread(3n, 9n);
		const deleteChannelRow = vi.fn().mockResolvedValue(undefined);
		setWorkerDependenciesForTest({
			guildRepository: guildSource([100n]) as never,
			channelRepository: {
				channelData: {listGuildChannels: async () => [parent, kept, orphan], delete: deleteChannelRow},
				messages: {deleteAllChannelMessages: vi.fn().mockResolvedValue(undefined), listMessages: async () => []},
			} as never,
			gatewayService: {dispatchGuild: vi.fn().mockResolvedValue(undefined)} as never,
			storageService: {} as never,
			purgeQueue: {} as never,
		});
		await purgeOrphanedThreads({}, helpers());
		expect(deleteChannelRow).toHaveBeenCalledTimes(1);
		expect(String(deleteChannelRow.mock.calls[0][0])).toBe('3');
	});
});

describe('backfillThreadMembersByUser', () => {
	test('writes a missing index row once and does nothing on a second run', async () => {
		memberState.members = [
			{
				threadId: createChannelID(2n),
				userId: createUserID(7n),
				joinTimestamp: new Date('2026-09-14T00:00:00.000Z'),
				flags: 0,
			},
		];
		setWorkerDependenciesForTest({
			guildRepository: guildSource([100n]) as never,
			channelRepository: {channelData: {listGuildChannels: async () => [thread(2n, 1n)]}} as never,
		});
		await backfillThreadMembersByUser({}, helpers());
		expect(memberState.writes).toBe(1);
		await backfillThreadMembersByUser({}, helpers());
		expect(memberState.writes).toBe(1);
	});
});

describe('the pure predicates the sweeps decide with', () => {
	test('isThreadInactive and isOrphanedThread still hold', () => {
		const now = Date.parse('2026-09-14T12:00:00.000Z');
		expect(isThreadInactive(thread(2n, 1n, {thread_create_timestamp: new Date('2026-09-14T10:00:00.000Z')}), now)).toBe(
			true,
		);
		expect(isThreadInactive(thread(2n, 1n, {thread_create_timestamp: new Date('2026-09-14T11:30:00.000Z')}), now)).toBe(
			false,
		);
		expect(isOrphanedThread({type: ChannelTypes.PUBLIC_THREAD, parentId: null}, () => null)).toBe(true);
	});
});
