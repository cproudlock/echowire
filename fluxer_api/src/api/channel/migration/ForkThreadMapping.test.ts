// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID} from '@app/api/BrandedTypes';
import {
	buildForumConfig,
	buildMemberIdsPreview,
	decodeBigint,
	decodeDate,
	indexKey,
	isLegacyByUserRow,
	LEGACY_LAYOUT_TO_UPSTREAM,
	type LegacyChannel,
	type LegacyMember,
	MIGRATED_STATE_VERSION,
	type MigrationInput,
	mapAutoArchiveDuration,
	mapForumTags,
	mapLayout,
	mapSortOrder,
	parseLegacyChannel,
	parseLegacyMember,
	planMigration,
	rowsEqual,
} from '@app/api/channel/migration/ForkThreadMapping';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {
	ChannelFlags,
	DEFAULT_THREAD_AUTO_ARCHIVE_DURATION,
	ForumLayoutTypes,
	ForumSortOrderTypes,
	THREAD_MEMBER_IDS_PREVIEW_SIZE,
	ThreadMemberFlags,
} from '@fluxer/constants/src/ThreadConstants';
import {describe, expect, it} from 'vitest';

const GUILD = 100n;
const TEXT = 200n;
const FORUM = 300n;
const T0 = new Date('2026-09-01T00:00:00.000Z');
const T1 = new Date('2026-09-02T00:00:00.000Z');

function big(value: bigint) {
	return {value: value.toString(), __fluxer_type: 'bigint'};
}

function date(value: Date) {
	return {value: value.toISOString(), __fluxer_type: 'date'};
}

function channel(overrides: Partial<LegacyChannel> & {id: bigint; type: number}): LegacyChannel {
	return {
		guildId: GUILD,
		parentId: null,
		ownerId: 1n,
		softDeleted: false,
		archived: false,
		autoArchiveDuration: null,
		archiveTimestamp: null,
		locked: false,
		invitable: null,
		createTimestamp: null,
		memberCount: null,
		messageCount: null,
		recentParticipantIds: [],
		pinned: false,
		availableTags: [],
		appliedTags: [],
		defaultReactionEmoji: null,
		defaultSortOrder: null,
		forumDefaultAutoArchiveDuration: null,
		forumRequireTag: false,
		defaultForumLayout: null,
		defaultThreadRateLimitPerUser: null,
		...overrides,
	};
}

const textParent = channel({id: TEXT, type: ChannelTypes.GUILD_TEXT});
const forumParent = channel({
	id: FORUM,
	type: ChannelTypes.GUILD_FORUM,
	availableTags: [
		{id: 11n, name: 'news', moderated: false, emojiName: 'N'},
		{id: 12n, name: 'staff', moderated: true, emojiName: null},
	],
});

function member(threadId: bigint, userId: bigint, joined: Date | null = T0, flags = 0): LegacyMember {
	return {threadId, userId, joinTimestamp: joined, flags};
}

function input(overrides: Partial<MigrationInput> & Pick<MigrationInput, 'channels'>): MigrationInput {
	return {members: [], starterThreadIds: new Set(), ...overrides};
}

function only(plan: ReturnType<typeof planMigration>, threadId: bigint) {
	const found = plan.threads.find((thread) => thread.threadId === threadId);
	if (!found) throw new Error(`thread ${threadId} not planned`);
	return found;
}

describe('constants confirmed against upstream', () => {
	it('keeps the fork layout numbers: 0 not set, 1 list, 2 gallery is upstream GRID', () => {
		expect(ForumLayoutTypes).toEqual({DEFAULT: 0, LIST: 1, GRID: 2});
		expect(LEGACY_LAYOUT_TO_UPSTREAM).toEqual({0: 0, 1: 1, 2: 2});
	});

	it('uses upstream flag bits: pinned 1<<1 and require_tag 1<<4', () => {
		expect(ChannelFlags.PINNED).toBe(2);
		expect(ChannelFlags.REQUIRE_TAG).toBe(16);
	});
});

describe('decoding raw jsonb', () => {
	it('decodes tagged bigints and dates and plain values', () => {
		expect(decodeBigint(big(5n))).toBe(5n);
		expect(decodeBigint('7')).toBe(7n);
		expect(decodeBigint(null)).toBeNull();
		expect(decodeBigint('x')).toBeNull();
		expect(decodeDate(date(T0))?.getTime()).toBe(T0.getTime());
		expect(decodeDate('nope')).toBeNull();
	});

	it('parses a thread row with missing and null fields without throwing', () => {
		const parsed = parseLegacyChannel({
			channel_id: big(9n),
			type: 11,
			guild_id: big(GUILD),
			parent_id: big(TEXT),
			soft_deleted: false,
			thread_archived: null,
			thread_locked: true,
			applied_tags: null,
		});
		expect(parsed).toMatchObject({
			id: 9n,
			locked: true,
			archived: false,
			pinned: false,
			appliedTags: [],
			memberCount: null,
		});
		expect(parseLegacyChannel({type: 11})).toBeNull();
		expect(parseLegacyChannel('x')).toBeNull();
	});

	it('parses forum tags, dropping malformed and duplicate ids', () => {
		const parsed = parseLegacyChannel({
			channel_id: big(FORUM),
			type: 15,
			available_tags: [
				{id: '5', name: 'a', moderated: true, emoji_name: 'x'},
				{id: '5', name: 'dup'},
				{id: 'bad', name: 'b'},
				{name: 'no id'},
			],
			default_reaction_emoji: {emoji_id: '77', emoji_name: null},
		});
		expect(parsed?.availableTags).toEqual([{id: 5n, name: 'a', moderated: true, emojiName: 'x'}]);
		expect(parsed?.defaultReactionEmoji).toEqual({emojiId: 77n, emojiName: null});
	});

	it('parses members and detects the fork shape of a by-user row', () => {
		expect(parseLegacyMember({thread_id: big(1n), user_id: big(2n), join_timestamp: date(T0), flags: 0})).toEqual({
			threadId: 1n,
			userId: 2n,
			joinTimestamp: T0,
			flags: 0,
		});
		expect(parseLegacyMember({thread_id: big(1n)})).toBeNull();
		expect(isLegacyByUserRow({user_id: big(2n), thread_id: big(1n), guild_id: big(3n), flags: 0})).toBe(true);
		expect(
			isLegacyByUserRow({
				user_id: big(2n),
				guild_id: big(3n),
				parent_id: big(4n),
				is_private: false,
				thread_id: big(1n),
			}),
		).toBe(false);
	});
});

describe('field mappers', () => {
	it('maps tags to the upstream UDT shape with a null emoji_id', () => {
		expect(mapForumTags(forumParent.availableTags)).toEqual([
			{id: 11n, name: 'news', moderated: false, emoji_id: null, emoji_name: 'N'},
			{id: 12n, name: 'staff', moderated: true, emoji_id: null, emoji_name: null},
		]);
	});

	it('maps layout, sort order and auto archive, rejecting values upstream does not have', () => {
		expect(mapLayout(null)).toBeNull();
		expect(mapLayout(1)).toBe(ForumLayoutTypes.LIST);
		expect(mapLayout(2)).toBe(ForumLayoutTypes.GRID);
		expect(mapLayout(9)).toBeNull();
		expect(mapSortOrder(0)).toBe(ForumSortOrderTypes.LATEST_ACTIVITY);
		expect(mapSortOrder(1)).toBe(ForumSortOrderTypes.CREATION_TIME);
		expect(mapSortOrder(5)).toBeNull();
		expect(mapAutoArchiveDuration(1440)).toBe(1440);
		expect(mapAutoArchiveDuration(0)).toBeNull();
		expect(mapAutoArchiveDuration(null)).toBeNull();
	});

	it('builds the forum config: require_tag bit, reaction emoji id and name, tags, layout, no tag setting', () => {
		const warnings: Array<string> = [];
		const config = buildForumConfig(
			channel({
				id: FORUM,
				type: ChannelTypes.GUILD_FORUM,
				forumRequireTag: true,
				availableTags: forumParent.availableTags,
				defaultReactionEmoji: {emojiId: 5n, emojiName: 'pepe'},
				defaultSortOrder: 1,
				defaultForumLayout: 2,
				forumDefaultAutoArchiveDuration: 10080,
				defaultThreadRateLimitPerUser: 30,
			}),
			true,
			warnings,
		);
		expect(config.flags).toBe(ChannelFlags.REQUIRE_TAG);
		expect(config.default_reaction_emoji_id).toBe(5n);
		expect(config.default_reaction_emoji_name).toBe('pepe');
		expect(config.available_tags).toHaveLength(2);
		expect(config.default_sort_order).toBe(1);
		expect(config.default_forum_layout).toBe(ForumLayoutTypes.GRID);
		expect(config.default_auto_archive_duration).toBe(10080);
		expect(config.default_thread_rate_limit_per_user).toBe(30);
		expect(config.default_tag_setting).toBeNull();
		expect(config.has_threads).toBe(true);
		expect(warnings).toEqual([]);
	});

	it('leaves a forum with nothing set as flags 0 and everything else null', () => {
		const config = buildForumConfig(channel({id: FORUM, type: ChannelTypes.GUILD_FORUM}), false);
		expect(config.flags).toBe(0);
		expect(config.available_tags).toBeNull();
		expect(config.default_forum_layout).toBeNull();
		expect(config.has_threads).toBeNull();
	});

	it('warns on an unknown layout instead of guessing', () => {
		const warnings: Array<string> = [];
		const config = buildForumConfig(
			channel({id: FORUM, type: ChannelTypes.GUILD_FORUM, defaultForumLayout: 7}),
			false,
			warnings,
		);
		expect(config.default_forum_layout).toBeNull();
		expect(warnings.join()).toContain('unknown default_forum_layout 7');
	});
});

describe('member_ids_preview', () => {
	it('puts recent authors first, then fills with members newest-join first, deduped', () => {
		const members = [member(1n, 10n, T0), member(1n, 11n, T1), member(1n, 12n, new Date('2026-08-01T00:00:00Z'))];
		expect(buildMemberIdsPreview([12n], members)).toEqual([12n, 11n, 10n]);
		expect(buildMemberIdsPreview([], members)).toEqual([11n, 10n, 12n]);
		expect(buildMemberIdsPreview([], [])).toEqual([]);
	});

	it('is capped at the upstream preview size', () => {
		const many = Array.from({length: 20}, (_, index) => BigInt(index + 1));
		expect(buildMemberIdsPreview(many, [])).toHaveLength(THREAD_MEMBER_IDS_PREVIEW_SIZE);
	});

	it('is stable when members share a join timestamp', () => {
		const members = [member(1n, 5n), member(1n, 9n), member(1n, 7n)];
		expect(buildMemberIdsPreview([], members)).toEqual(buildMemberIdsPreview([], [...members].reverse()));
	});
});

describe('planMigration: plain threads under a text channel', () => {
	const base = channel({id: 1000n, type: ChannelTypes.PUBLIC_THREAD, parentId: TEXT, memberCount: 2, messageCount: 7});

	it('maps an active thread: state, stats, indexes, no flags, no tags', () => {
		const plan = planMigration(
			input({
				channels: [textParent, base],
				members: [member(1000n, 1n), member(1000n, 2n, T1)],
				starterThreadIds: new Set([1000n]),
			}),
		);
		const thread = only(plan, 1000n);
		expect(thread.state).toMatchObject({
			type: ChannelTypes.PUBLIC_THREAD,
			archived: false,
			locked: false,
			invitable: null,
			flags: 0,
			applied_tags: null,
			member_count: 2,
			has_starter: true,
			state_version: MIGRATED_STATE_VERSION,
			auto_archive_duration: DEFAULT_THREAD_AUTO_ARCHIVE_DURATION,
		});
		expect(thread.stats).toMatchObject({message_count: 7, total_message_sent: 7});
		expect(thread.active).not.toBeNull();
		expect(thread.archived).toBeNull();
		expect(thread.byParent).toMatchObject({parent_id: TEXT, thread_id: 1000n, guild_id: GUILD});
		expect(thread.forumPin).toBeNull();
		expect(plan.parents).toHaveLength(1);
		expect(plan.parents[0]).toMatchObject({isThreadOnly: false, threadCount: 1});
		expect(plan.parents[0]?.config.has_threads).toBe(true);
		expect(plan.threadOnly).toEqual([]);
	});

	it('has_starter is false unless the thread id is a message in the parent', () => {
		const plan = planMigration(input({channels: [textParent, base]}));
		expect(only(plan, 1000n).state.has_starter).toBe(false);
	});

	it('maps archived and locked and puts the thread in the archive index, not the active one', () => {
		const archived = {...base, archived: true, locked: true, archiveTimestamp: T1, autoArchiveDuration: 1440};
		const thread = only(planMigration(input({channels: [textParent, archived]})), 1000n);
		expect(thread.state).toMatchObject({archived: true, locked: true, auto_archive_duration: 1440});
		expect(thread.state.archive_timestamp).toEqual(T1);
		expect(thread.active).toBeNull();
		expect(thread.archived).toMatchObject({
			parent_id: TEXT,
			is_private: false,
			archive_timestamp: T1,
			thread_id: 1000n,
			guild_id: GUILD,
		});
	});

	it('keeps invitable only for private threads, defaulting to true when unset', () => {
		const privateThread = {...base, id: 1001n, type: ChannelTypes.PRIVATE_THREAD, invitable: null};
		const publicThread = {...base, id: 1002n, invitable: false};
		const plan = planMigration(
			input({
				channels: [textParent, privateThread, publicThread],
				members: [member(1001n, 5n)],
			}),
		);
		expect(only(plan, 1001n).state.invitable).toBe(true);
		expect(only(plan, 1001n).byUser[0]?.is_private).toBe(true);
		expect(only(plan, 1001n).archived).toBeNull();
		expect(only(plan, 1002n).state.invitable).toBeNull();
	});

	it('falls back to snowflake time and creation time when timestamps are missing', () => {
		const thread = only(planMigration(input({channels: [textParent, {...base, archived: true}]})), 1000n);
		expect(thread.state.created_at).toBeInstanceOf(Date);
		expect(thread.state.archive_timestamp).toEqual(thread.state.created_at);
		expect(thread.archived?.archive_timestamp).toEqual(thread.state.created_at);
	});

	it('uses the recorded creation time when there is one', () => {
		const thread = only(planMigration(input({channels: [textParent, {...base, createTimestamp: T1}]})), 1000n);
		expect(thread.state.created_at).toEqual(T1);
	});

	it('treats missing counts as zero and negative counts as zero', () => {
		const thread = only(
			planMigration(input({channels: [textParent, {...base, memberCount: null, messageCount: -4}]})),
			1000n,
		);
		expect(thread.stats.message_count).toBe(0);
		expect(thread.state.member_count).toBe(0);
	});

	it('uses the member row count when the old count column is absent', () => {
		const thread = only(
			planMigration(
				input({
					channels: [textParent, {...base, memberCount: null}],
					members: [member(1000n, 1n), member(1000n, 2n)],
				}),
			),
			1000n,
		);
		expect(thread.state.member_count).toBe(2);
	});

	it('warns on a member count that disagrees with the rows but keeps the column', () => {
		const plan = planMigration(
			input({channels: [textParent, {...base, memberCount: 5}], members: [member(1000n, 1n)]}),
		);
		expect(only(plan, 1000n).state.member_count).toBe(5);
		expect(plan.warnings.join()).toContain('thread_member_count 5 differs from 1');
	});

	it('replaces an auto archive duration upstream does not have and says so', () => {
		const plan = planMigration(input({channels: [textParent, {...base, autoArchiveDuration: 0}]}));
		expect(only(plan, 1000n).state.auto_archive_duration).toBe(DEFAULT_THREAD_AUTO_ARCHIVE_DURATION);
		expect(plan.warnings.join()).toContain('auto archive duration 0');
	});

	it('drops applied_tags on a thread under a text channel', () => {
		const plan = planMigration(input({channels: [textParent, {...base, appliedTags: [1n]}]}));
		expect(only(plan, 1000n).state.applied_tags).toBeNull();
		expect(plan.warnings.join()).toContain('applied_tags on a thread under a text channel');
	});
});

describe('planMigration: forum posts', () => {
	const post = channel({
		id: 2000n,
		type: ChannelTypes.PUBLIC_THREAD,
		parentId: FORUM,
		appliedTags: [11n],
		recentParticipantIds: [7n],
		memberCount: 1,
		messageCount: 3,
	});

	it('is always has_starter and keeps applied tags, with the preview built from authors', () => {
		const plan = planMigration(input({channels: [forumParent, post], members: [member(2000n, 8n)]}));
		const thread = only(plan, 2000n);
		expect(thread.state.has_starter).toBe(true);
		expect(thread.state.applied_tags).toEqual([11n]);
		expect(thread.state.member_ids_preview).toEqual([7n, 8n]);
		expect(plan.threadOnly).toEqual([{guild_id: GUILD, channel_id: FORUM}]);
		expect(plan.parents[0]).toMatchObject({isThreadOnly: true, threadCount: 1});
	});

	it('keeps a tag that is no longer on the forum but warns', () => {
		const plan = planMigration(input({channels: [forumParent, {...post, appliedTags: [99n]}]}));
		expect(only(plan, 2000n).state.applied_tags).toEqual([99n]);
		expect(plan.warnings.join()).toContain('not on the forum any more');
	});

	it('caps applied tags at the upstream maximum', () => {
		const plan = planMigration(input({channels: [forumParent, {...post, appliedTags: [1n, 2n, 3n, 4n, 5n, 6n, 7n]}]}));
		expect(only(plan, 2000n).state.applied_tags).toEqual([1n, 2n, 3n, 4n, 5n]);
	});

	it('sets the PINNED bit and forum_pinned_thread for an active pinned post', () => {
		const plan = planMigration(input({channels: [forumParent, {...post, pinned: true}]}));
		const thread = only(plan, 2000n);
		expect(thread.state.flags).toBe(ChannelFlags.PINNED);
		expect(thread.forumPin).toEqual({parent_id: FORUM, thread_id: 2000n});
	});

	it('drops a pin on an archived post, as upstream clears PINNED on archive', () => {
		const plan = planMigration(input({channels: [forumParent, {...post, pinned: true, archived: true}]}));
		expect(only(plan, 2000n).state.flags).toBe(0);
		expect(only(plan, 2000n).forumPin).toBeNull();
		expect(plan.warnings.join()).toContain('pin dropped');
	});

	it('drops a pin on a thread under a text channel', () => {
		const plan = planMigration(
			input({
				channels: [textParent, channel({id: 3000n, type: ChannelTypes.PUBLIC_THREAD, parentId: TEXT, pinned: true})],
			}),
		);
		expect(only(plan, 3000n).state.flags).toBe(0);
	});

	it('keeps only the newest pin when a forum has several', () => {
		const plan = planMigration(
			input({channels: [forumParent, {...post, pinned: true}, {...post, id: 2001n, pinned: true}]}),
		);
		expect(only(plan, 2000n).forumPin).toBeNull();
		expect(only(plan, 2001n).forumPin).not.toBeNull();
		expect(only(plan, 2000n).state.flags).toBe(0);
		expect(only(plan, 2001n).state.flags).toBe(ChannelFlags.PINNED);
	});

	it('plans a config and a thread-only row for a forum that has no posts yet', () => {
		const plan = planMigration(input({channels: [forumParent]}));
		expect(plan.threads).toEqual([]);
		expect(plan.parents[0]?.config.has_threads).toBeNull();
		expect(plan.threadOnly).toHaveLength(1);
		expect(plan.guildMarkers).toHaveLength(1);
	});
});

describe('planMigration: members and orphans', () => {
	const thread = channel({id: 4000n, type: ChannelTypes.PUBLIC_THREAD, parentId: TEXT});

	it('writes thread_member with guild, parent and muted=false, and the by-user row with the new key', () => {
		const plan = planMigration(
			input({channels: [textParent, thread], members: [member(4000n, 5n, T1, ThreadMemberFlags.HAS_INTERACTED)]}),
		);
		const row = only(plan, 4000n).members[0];
		expect(row).toEqual({
			thread_id: 4000n,
			user_id: 5n,
			guild_id: GUILD,
			parent_id: TEXT,
			join_timestamp: T1,
			flags: ThreadMemberFlags.HAS_INTERACTED,
			muted: false,
			mute_config: null,
		});
		expect(only(plan, 4000n).byUser[0]).toEqual({
			user_id: 5n,
			guild_id: GUILD,
			parent_id: TEXT,
			is_private: false,
			thread_id: 4000n,
		});
	});

	it('masks unknown member flag bits and defaults a missing join time to the thread creation time', () => {
		const plan = planMigration(input({channels: [textParent, thread], members: [member(4000n, 5n, null, 1 << 20)]}));
		const row = only(plan, 4000n).members[0];
		expect(row?.flags).toBe(0);
		expect(row?.join_timestamp).toEqual(only(plan, 4000n).state.created_at);
	});

	it('skips member groups whose thread row no longer exists and counts them', () => {
		const plan = planMigration(
			input({
				channels: [textParent, thread],
				members: [member(4000n, 5n), member(999n, 1n), member(999n, 2n), member(998n, 3n)],
			}),
		);
		expect(plan.skippedMemberGroups).toEqual([
			{id: 998n, reason: 'orphan_member_group', count: 1},
			{id: 999n, reason: 'orphan_member_group', count: 2},
		]);
		expect(plan.threads.flatMap((t) => t.members)).toHaveLength(1);
	});

	it('skips members of a soft-deleted thread and a thread whose parent is gone', () => {
		const deleted = {...thread, id: 4001n, softDeleted: true};
		const parentless = channel({id: 4002n, type: ChannelTypes.PUBLIC_THREAD, parentId: 12345n});
		const plan = planMigration(
			input({
				channels: [textParent, thread, deleted, parentless],
				members: [member(4001n, 1n), member(4002n, 1n)],
			}),
		);
		expect(plan.threads.map((t) => t.threadId)).toEqual([4000n]);
		expect(plan.skippedThreads.map((s) => [s.id, s.reason])).toEqual([
			[4001n, 'soft_deleted'],
			[4002n, 'missing_parent'],
		]);
		expect(plan.skippedMemberGroups.map((g) => g.id)).toEqual([4001n, 4002n]);
	});

	it('skips a thread whose parent is soft-deleted', () => {
		const plan = planMigration(input({channels: [{...textParent, softDeleted: true}, thread]}));
		expect(plan.threads).toEqual([]);
		expect(plan.skippedThreads[0]?.reason).toBe('parent_deleted');
	});
});

describe('planMigration: markers and idempotency', () => {
	it('creates one guild marker per guild with threads or forums and leaves perms_seeded_at null', () => {
		const channels = [
			textParent,
			forumParent,
			channel({id: 5000n, type: ChannelTypes.PUBLIC_THREAD, parentId: TEXT, createTimestamp: T0}),
			channel({id: 5001n, type: ChannelTypes.PUBLIC_THREAD, parentId: TEXT, createTimestamp: T1}),
			channel({id: 7000n, type: ChannelTypes.GUILD_TEXT, guildId: 555n}),
		];
		const plan = planMigration(input({channels}));
		expect(plan.guildMarkers).toHaveLength(1);
		expect(plan.guildMarkers[0]).toMatchObject({guild_id: GUILD, perms_seeded_at: null, search_backfilled_at: null});
		expect(plan.guildMarkers[0]?.first_active_at?.getTime()).toBeLessThanOrEqual(T0.getTime());
	});

	it('plans a forum-only guild marker from the forum creation time, not from the clock', () => {
		const plan = planMigration(input({channels: [forumParent]}));
		const again = planMigration(input({channels: [forumParent]}));
		expect(plan.guildMarkers).toEqual(again.guildMarkers);
	});

	it('plans identically twice, whatever the input order, so a second apply derives the same keys', () => {
		const channels = [
			textParent,
			forumParent,
			channel({id: 6000n, type: ChannelTypes.PUBLIC_THREAD, parentId: FORUM, appliedTags: [11n], pinned: true}),
			channel({id: 6001n, type: ChannelTypes.PUBLIC_THREAD, parentId: TEXT, archived: true, archiveTimestamp: T1}),
		];
		const members = [member(6000n, 1n), member(6001n, 2n), member(6001n, 3n)];
		const first = planMigration(input({channels, members}));
		const second = planMigration(input({channels: [...channels].reverse(), members: [...members].reverse()}));
		expect(rowsEqual(first, second)).toBe(true);
		const keys = (plan: typeof first) =>
			plan.threads.flatMap((t) => [
				indexKey([t.state.parent_id, t.threadId]),
				...t.byUser.map((row) => indexKey([row.user_id, row.guild_id, row.parent_id, row.is_private, row.thread_id])),
				...(t.archived
					? [indexKey([t.archived.parent_id, t.archived.is_private, t.archived.archive_timestamp, t.threadId])]
					: []),
			]);
		expect(keys(first)).toEqual(keys(second));
		expect(new Set(keys(first)).size).toBe(keys(first).length);
	});
});

describe('rowsEqual', () => {
	it('ignores key order, null versus undefined versus empty list, compares dates by instant and bigints by value', () => {
		const left = {a: 1n, b: null, c: [], d: new Date(5), e: [1n, 2n]};
		const right = {e: [1n, 2n], d: new Date(5), a: 1n, c: null};
		expect(rowsEqual(left, right)).toBe(true);
		expect(rowsEqual({a: 1n}, {a: 2n})).toBe(false);
		expect(rowsEqual({a: new Date(1)}, {a: new Date(2)})).toBe(false);
		expect(rowsEqual({e: [1n, 2n]}, {e: [2n, 1n]})).toBe(false);
	});

	it('treats branded ids as plain bigints', () => {
		expect(rowsEqual({id: createChannelID(5n)}, {id: 5n})).toBe(true);
	});
});
