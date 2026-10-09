// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure mapping from the echowire fork's thread storage to upstream's.
 *
 * The fork kept thread and forum state as columns on the channel row (read here from the RAW
 * `row_data` jsonb, because the typed ChannelRow no longer has them) plus `thread_members` and
 * `thread_members_by_user`. Upstream keeps it in thread_state, thread_stats, threads_by_parent,
 * active_threads_by_guild, archived_threads_by_parent, thread_parent_config, forum_pinned_thread,
 * thread_only_channels_by_guild, guild_thread_state, thread_members and thread_members_by_user
 * (new key). See docs/adr/0012-adopt-upstream-threads-and-forums.md, Phase 3.
 *
 * Nothing here touches a database. scripts/MigrateForkThreads.ts does the reading, diffing and
 * writing and calls into this module, so every decision is unit-testable.
 */

import {type ChannelID, createChannelID, createGuildID, createUserID, type GuildID} from '@app/api/BrandedTypes';
import type {
	ActiveThreadsByGuildRow,
	ArchivedThreadsByParentRow,
	ForumPinnedThreadRow,
	ForumTagUdt,
	GuildThreadStateRow,
	ThreadMemberRow,
	ThreadMembersByUserRow,
	ThreadOnlyChannelsByGuildRow,
	ThreadParentConfigRow,
	ThreadStateRow,
	ThreadStatsRow,
	ThreadsByParentRow,
} from '@app/api/database/types/ThreadTypes';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {
	ChannelFlags,
	DEFAULT_THREAD_AUTO_ARCHIVE_DURATION,
	ForumLayoutTypes,
	ForumSortOrderTypes,
	isThreadAutoArchiveDuration,
	MAX_APPLIED_TAGS_PER_THREAD,
	THREAD_CHANNEL_TYPES,
	THREAD_MEMBER_IDS_PREVIEW_SIZE,
	THREAD_ONLY_CHANNEL_TYPES,
	THREAD_PARENT_CHANNEL_TYPES,
	ThreadMemberFlags,
} from '@fluxer/constants/src/ThreadConstants';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';

/** thread_state.state_version a freshly migrated row starts at. Upstream's create() also starts at 1. */
export const MIGRATED_STATE_VERSION = 1;

/**
 * The fork stored ForumLayout as 0 not set, 1 list, 2 gallery. Upstream calls value 2 GRID. The
 * numbers are identical, so the map is the identity; it is spelled out so a change on either side
 * fails a test instead of silently shifting every forum's layout.
 */
export const LEGACY_LAYOUT_TO_UPSTREAM: Readonly<Record<number, number>> = {
	0: ForumLayoutTypes.DEFAULT,
	1: ForumLayoutTypes.LIST,
	2: ForumLayoutTypes.GRID,
};

const KNOWN_MEMBER_FLAG_MASK =
	ThreadMemberFlags.HAS_INTERACTED |
	ThreadMemberFlags.ALL_MESSAGES |
	ThreadMemberFlags.ONLY_MENTIONS |
	ThreadMemberFlags.NO_MESSAGES;

// ---------------------------------------------------------------------------
// Decoding the raw jsonb the KV layer stores
// ---------------------------------------------------------------------------

function isTagged(value: unknown): value is {__fluxer_type: string; value: unknown} {
	return typeof value === 'object' && value !== null && '__fluxer_type' in value && 'value' in value;
}

export function decodeBigint(value: unknown): bigint | null {
	if (value === null || value === undefined) return null;
	if (isTagged(value)) return decodeBigint(value.value);
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
	if (typeof value === 'string' && /^-?[0-9]+$/u.test(value)) return BigInt(value);
	return null;
}

export function decodeDate(value: unknown): Date | null {
	if (value === null || value === undefined) return null;
	if (isTagged(value)) return decodeDate(value.value);
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === 'string' || typeof value === 'number') {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}
	return null;
}

function decodeInt(value: unknown): number | null {
	if (isTagged(value)) return decodeInt(value.value);
	return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function decodeBool(value: unknown): boolean | null {
	if (isTagged(value)) return decodeBool(value.value);
	return typeof value === 'boolean' ? value : null;
}

function decodeString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function decodeList(value: unknown): Array<unknown> | null {
	if (isTagged(value)) return decodeList(value.value);
	return Array.isArray(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Legacy shapes
// ---------------------------------------------------------------------------

export interface LegacyTag {
	id: bigint;
	name: string;
	moderated: boolean;
	emojiName: string | null;
}

export interface LegacyChannel {
	id: bigint;
	guildId: bigint | null;
	parentId: bigint | null;
	type: number;
	ownerId: bigint | null;
	softDeleted: boolean;
	archived: boolean;
	autoArchiveDuration: number | null;
	archiveTimestamp: Date | null;
	locked: boolean;
	invitable: boolean | null;
	createTimestamp: Date | null;
	memberCount: number | null;
	messageCount: number | null;
	recentParticipantIds: Array<bigint>;
	pinned: boolean;
	availableTags: Array<LegacyTag>;
	appliedTags: Array<bigint>;
	defaultReactionEmoji: {emojiId: bigint | null; emojiName: string | null} | null;
	defaultSortOrder: number | null;
	forumDefaultAutoArchiveDuration: number | null;
	forumRequireTag: boolean;
	defaultForumLayout: number | null;
	defaultThreadRateLimitPerUser: number | null;
}

export interface LegacyMember {
	threadId: bigint;
	userId: bigint;
	joinTimestamp: Date | null;
	flags: number;
}

function parseLegacyTags(raw: unknown): Array<LegacyTag> {
	const list = decodeList(raw) ?? [];
	const seen = new Set<bigint>();
	const tags: Array<LegacyTag> = [];
	for (const entry of list) {
		if (typeof entry !== 'object' || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const id = decodeBigint(record['id']);
		const name = decodeString(record['name']);
		if (id === null || name === null || seen.has(id)) continue;
		seen.add(id);
		tags.push({
			id,
			name,
			moderated: decodeBool(record['moderated']) === true,
			emojiName: decodeString(record['emoji_name']),
		});
	}
	return tags;
}

function parseBigintList(raw: unknown): Array<bigint> {
	const list = decodeList(raw) ?? [];
	const result: Array<bigint> = [];
	for (const entry of list) {
		const id = decodeBigint(entry);
		if (id !== null && !result.includes(id)) result.push(id);
	}
	return result;
}

/** Reads the old thread and forum columns out of a raw channels `row_data`. Returns null if it has no channel id. */
export function parseLegacyChannel(rowData: unknown): LegacyChannel | null {
	if (typeof rowData !== 'object' || rowData === null) return null;
	const row = rowData as Record<string, unknown>;
	const id = decodeBigint(row['channel_id']);
	const type = decodeInt(row['type']);
	if (id === null || type === null) return null;
	const reaction = row['default_reaction_emoji'];
	let defaultReactionEmoji: LegacyChannel['defaultReactionEmoji'] = null;
	if (typeof reaction === 'object' && reaction !== null) {
		const record = reaction as Record<string, unknown>;
		defaultReactionEmoji = {
			emojiId: decodeBigint(record['emoji_id']),
			emojiName: decodeString(record['emoji_name']),
		};
	}
	return {
		id,
		guildId: decodeBigint(row['guild_id']),
		parentId: decodeBigint(row['parent_id']),
		type,
		ownerId: decodeBigint(row['owner_id']),
		softDeleted: decodeBool(row['soft_deleted']) === true,
		archived: decodeBool(row['thread_archived']) === true,
		autoArchiveDuration: decodeInt(row['thread_auto_archive_duration']),
		archiveTimestamp: decodeDate(row['thread_archive_timestamp']),
		locked: decodeBool(row['thread_locked']) === true,
		invitable: decodeBool(row['thread_invitable']),
		createTimestamp: decodeDate(row['thread_create_timestamp']),
		memberCount: decodeInt(row['thread_member_count']),
		messageCount: decodeInt(row['thread_message_count']),
		recentParticipantIds: parseBigintList(row['thread_recent_participant_ids']),
		pinned: decodeBool(row['thread_pinned']) === true,
		availableTags: parseLegacyTags(row['available_tags']),
		appliedTags: parseBigintList(row['applied_tags']),
		defaultReactionEmoji,
		defaultSortOrder: decodeInt(row['default_sort_order']),
		forumDefaultAutoArchiveDuration: decodeInt(row['forum_default_auto_archive_duration']),
		forumRequireTag: decodeBool(row['forum_require_tag']) === true,
		defaultForumLayout: decodeInt(row['default_forum_layout']),
		defaultThreadRateLimitPerUser: decodeInt(row['default_thread_rate_limit_per_user']),
	};
}

export function parseLegacyMember(rowData: unknown): LegacyMember | null {
	if (typeof rowData !== 'object' || rowData === null) return null;
	const row = rowData as Record<string, unknown>;
	const threadId = decodeBigint(row['thread_id']);
	const userId = decodeBigint(row['user_id']);
	if (threadId === null || userId === null) return null;
	return {
		threadId,
		userId,
		joinTimestamp: decodeDate(row['join_timestamp']),
		flags: decodeInt(row['flags']) ?? 0,
	};
}

/**
 * Upstream's thread_members_by_user shares its table name with the fork's but has a different key
 * (user_id, guild_id, parent_id, is_private, thread_id). A row written by the fork has no parent_id.
 */
export function isLegacyByUserRow(rowData: unknown): boolean {
	if (typeof rowData !== 'object' || rowData === null) return false;
	const row = rowData as Record<string, unknown>;
	return decodeBigint(row['parent_id']) === null || row['is_private'] === undefined || row['is_private'] === null;
}

// ---------------------------------------------------------------------------
// Field mappers
// ---------------------------------------------------------------------------

/** Tag shape: fork {id, name, moderated, emoji_name} -> upstream UDT {id, name, moderated, emoji_id, emoji_name}. */
export function mapForumTags(tags: ReadonlyArray<LegacyTag>): Array<ForumTagUdt> {
	return tags.map((tag) => ({
		id: tag.id,
		name: tag.name,
		moderated: tag.moderated,
		// The fork had unicode emoji only; custom emoji ids did not exist on tags.
		emoji_id: null,
		emoji_name: tag.emojiName,
	}));
}

export function mapLayout(value: number | null): number | null {
	if (value === null) return null;
	return LEGACY_LAYOUT_TO_UPSTREAM[value] ?? null;
}

export function mapSortOrder(value: number | null): number | null {
	if (value === ForumSortOrderTypes.LATEST_ACTIVITY || value === ForumSortOrderTypes.CREATION_TIME) return value;
	return null;
}

export function mapAutoArchiveDuration(value: number | null): number | null {
	return value !== null && isThreadAutoArchiveDuration(value) ? value : null;
}

function nonNegative(value: number | null): number | null {
	return value === null ? null : Math.max(0, value);
}

/**
 * thread_recent_participant_ids is the fork's rolling window of the last distinct message AUTHORS,
 * most recent first. Upstream's member_ids_preview is the most recently JOINED MEMBERS, newest
 * first, capped at THREAD_MEMBER_IDS_PREVIEW_SIZE, and clients render it as the avatar stack on a
 * forum card. Decision: keep the authors first, in the fork's order (that is what the fork's cards
 * showed), then fill the remaining slots with members newest-join first, so a thread that has
 * members but no recorded authors still shows someone. Duplicates removed, capped at the preview
 * size. The old column is left on the channel row, so a re-added "participant avatars" extra can
 * keep reading real authors.
 */
export function buildMemberIdsPreview(
	participants: ReadonlyArray<bigint>,
	members: ReadonlyArray<LegacyMember>,
): Array<bigint> {
	const byJoinDesc = [...members].sort((a, b) => {
		const left = a.joinTimestamp?.getTime() ?? 0;
		const right = b.joinTimestamp?.getTime() ?? 0;
		if (left !== right) return right - left;
		return a.userId < b.userId ? 1 : a.userId > b.userId ? -1 : 0;
	});
	const preview: Array<bigint> = [];
	for (const id of [...participants, ...byJoinDesc.map((member) => member.userId)]) {
		if (preview.length >= THREAD_MEMBER_IDS_PREVIEW_SIZE) break;
		if (!preview.includes(id)) preview.push(id);
	}
	return preview;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface MigrationInput {
	/** Every channels row (soft-deleted included) decoded with parseLegacyChannel. */
	channels: ReadonlyArray<LegacyChannel>;
	members: ReadonlyArray<LegacyMember>;
	/** Ids of text-parent threads whose id is also a message id in the parent: the thread was started from that message. */
	starterThreadIds: ReadonlySet<bigint>;
}

export type SkipReason =
	| 'soft_deleted'
	| 'missing_guild'
	| 'missing_parent'
	| 'parent_deleted'
	| 'parent_not_thread_parent'
	| 'orphan_member_group';

export interface Skipped {
	id: bigint;
	reason: SkipReason;
	count: number;
}

export interface PlannedThread {
	threadId: bigint;
	state: ThreadStateRow;
	stats: ThreadStatsRow;
	byParent: ThreadsByParentRow;
	/** Exactly one of these is set: where the thread sits in the derived index tables. */
	active: ActiveThreadsByGuildRow | null;
	archived: ArchivedThreadsByParentRow | null;
	members: Array<ThreadMemberRow>;
	byUser: Array<ThreadMembersByUserRow>;
	forumPin: ForumPinnedThreadRow | null;
}

export interface PlannedParent {
	channelId: bigint;
	guildId: bigint;
	isThreadOnly: boolean;
	/** Fields to write. For a text parent only has_threads is set, because the fork stored nothing else for it. */
	config: ThreadParentConfigRow;
	threadCount: number;
}

export interface MigrationPlan {
	threads: Array<PlannedThread>;
	parents: Array<PlannedParent>;
	threadOnly: Array<ThreadOnlyChannelsByGuildRow>;
	guildMarkers: Array<GuildThreadStateRow>;
	skippedThreads: Array<Skipped>;
	skippedMemberGroups: Array<Skipped>;
	warnings: Array<string>;
}

function emptyConfig(guildId: GuildID, channelId: ChannelID): ThreadParentConfigRow {
	return {
		guild_id: guildId,
		channel_id: channelId,
		flags: null,
		default_auto_archive_duration: null,
		default_thread_rate_limit_per_user: null,
		available_tags: null,
		default_reaction_emoji_id: null,
		default_reaction_emoji_name: null,
		default_sort_order: null,
		default_forum_layout: null,
		default_tag_setting: null,
		has_threads: null,
	};
}

/** thread_parent_config for a forum (or media) channel. default_tag_setting has no fork source and stays null. */
export function buildForumConfig(
	forum: LegacyChannel,
	hasThreads: boolean,
	warnings: Array<string> = [],
): ThreadParentConfigRow {
	const guildId = createGuildID(forum.guildId!);
	const row = emptyConfig(guildId, createChannelID(forum.id));
	const tags = mapForumTags(forum.availableTags);
	const layout = mapLayout(forum.defaultForumLayout);
	if (forum.defaultForumLayout !== null && layout === null) {
		warnings.push(`forum ${forum.id}: unknown default_forum_layout ${forum.defaultForumLayout}, left unset`);
	}
	const autoArchive = mapAutoArchiveDuration(forum.forumDefaultAutoArchiveDuration);
	if (forum.forumDefaultAutoArchiveDuration !== null && autoArchive === null) {
		warnings.push(
			`forum ${forum.id}: forum_default_auto_archive_duration ${forum.forumDefaultAutoArchiveDuration} is not an upstream duration, left unset`,
		);
	}
	return {
		...row,
		flags: forum.forumRequireTag ? ChannelFlags.REQUIRE_TAG : 0,
		default_auto_archive_duration: autoArchive,
		default_thread_rate_limit_per_user: nonNegative(forum.defaultThreadRateLimitPerUser),
		available_tags: tags.length > 0 ? tags : null,
		default_reaction_emoji_id: forum.defaultReactionEmoji?.emojiId ?? null,
		default_reaction_emoji_name: forum.defaultReactionEmoji?.emojiName ?? null,
		default_sort_order: mapSortOrder(forum.defaultSortOrder),
		default_forum_layout: layout,
		has_threads: hasThreads ? true : null,
	};
}

function pickPinnedPerForum(candidates: ReadonlyArray<LegacyChannel>): Map<bigint, bigint> {
	// Upstream allows one pinned thread per forum (MAX_PINNED_THREADS_PER_FORUM = 1, forum_pinned_thread is keyed by
	// parent_id). If the fork somehow had several, the newest wins.
	const winners = new Map<bigint, bigint>();
	for (const thread of candidates) {
		const current = winners.get(thread.parentId!);
		if (current === undefined || thread.id > current) winners.set(thread.parentId!, thread.id);
	}
	return winners;
}

export function planMigration(input: MigrationInput): MigrationPlan {
	const warnings: Array<string> = [];
	const skippedThreads: Array<Skipped> = [];
	const skippedMemberGroups: Array<Skipped> = [];

	const liveChannels = new Map<bigint, LegacyChannel>();
	const guildIds = new Set<bigint>();
	for (const channel of input.channels) {
		if (!channel.softDeleted) liveChannels.set(channel.id, channel);
	}
	for (const channel of liveChannels.values()) {
		if (channel.guildId !== null) guildIds.add(channel.guildId);
	}

	const candidates: Array<LegacyChannel> = [];
	for (const channel of input.channels) {
		if (!THREAD_CHANNEL_TYPES.has(channel.type)) continue;
		if (channel.softDeleted) {
			skippedThreads.push({id: channel.id, reason: 'soft_deleted', count: 1});
			continue;
		}
		if (channel.guildId === null) {
			skippedThreads.push({id: channel.id, reason: 'missing_guild', count: 1});
			continue;
		}
		if (channel.parentId === null) {
			skippedThreads.push({id: channel.id, reason: 'missing_parent', count: 1});
			continue;
		}
		const parent = liveChannels.get(channel.parentId);
		if (!parent) {
			const deleted = input.channels.some((other) => other.id === channel.parentId);
			skippedThreads.push({id: channel.id, reason: deleted ? 'parent_deleted' : 'missing_parent', count: 1});
			continue;
		}
		if (!THREAD_PARENT_CHANNEL_TYPES.has(parent.type)) {
			skippedThreads.push({id: channel.id, reason: 'parent_not_thread_parent', count: 1});
			continue;
		}
		candidates.push(channel);
	}

	const membersByThread = new Map<bigint, Array<LegacyMember>>();
	for (const member of input.members) {
		const list = membersByThread.get(member.threadId) ?? [];
		list.push(member);
		membersByThread.set(member.threadId, list);
	}
	const migratedIds = new Set(candidates.map((thread) => thread.id));
	for (const [threadId, list] of [...membersByThread.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		if (!migratedIds.has(threadId)) {
			skippedMemberGroups.push({id: threadId, reason: 'orphan_member_group', count: list.length});
		}
	}

	const pinCandidates = candidates.filter((thread) => {
		if (!thread.pinned) return false;
		const parent = liveChannels.get(thread.parentId!)!;
		if (!THREAD_ONLY_CHANNEL_TYPES.has(parent.type) || thread.type !== ChannelTypes.PUBLIC_THREAD || thread.archived) {
			warnings.push(
				`thread ${thread.id}: thread_pinned is set but upstream only pins active public forum posts, pin dropped`,
			);
			return false;
		}
		return true;
	});
	const pinWinners = pickPinnedPerForum(pinCandidates);

	const threads: Array<PlannedThread> = [];
	const threadCountByParent = new Map<bigint, number>();
	const earliestByGuild = new Map<bigint, Date>();
	for (const thread of [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		const parent = liveChannels.get(thread.parentId!)!;
		const guildId = createGuildID(thread.guildId!);
		const parentId = createChannelID(thread.parentId!);
		const threadId = createChannelID(thread.id);
		const isPrivate = thread.type === ChannelTypes.PRIVATE_THREAD;
		const isForumPost = THREAD_ONLY_CHANNEL_TYPES.has(parent.type);
		const members = (membersByThread.get(thread.id) ?? []).sort((a, b) => (a.userId < b.userId ? -1 : 1));

		if (parent.type === ChannelTypes.GUILD_ANNOUNCEMENT && thread.type !== ChannelTypes.ANNOUNCEMENT_THREAD) {
			warnings.push(
				`thread ${thread.id}: sits under an announcement channel with type ${thread.type}; upstream expects ANNOUNCEMENT_THREAD (10). Type kept.`,
			);
		}

		const createdAt = thread.createTimestamp ?? snowflakeToDate(thread.id);
		const autoArchive = mapAutoArchiveDuration(thread.autoArchiveDuration);
		if (thread.autoArchiveDuration !== null && autoArchive === null) {
			warnings.push(
				`thread ${thread.id}: auto archive duration ${thread.autoArchiveDuration} is not an upstream duration, using ${DEFAULT_THREAD_AUTO_ARCHIVE_DURATION}`,
			);
		}
		let archiveTimestamp = thread.archiveTimestamp;
		if (archiveTimestamp === null) {
			archiveTimestamp = createdAt;
			if (thread.archived) {
				warnings.push(`thread ${thread.id}: archived without an archive timestamp, using the creation time`);
			}
		}

		const flags = pinWinners.get(thread.parentId!) === thread.id ? ChannelFlags.PINNED : 0;
		const appliedTags = isForumPost ? thread.appliedTags.slice(0, MAX_APPLIED_TAGS_PER_THREAD) : [];
		if (isForumPost) {
			const live = new Set(parent.availableTags.map((tag) => tag.id));
			const dangling = appliedTags.filter((tag) => !live.has(tag));
			if (dangling.length > 0) {
				warnings.push(`thread ${thread.id}: applied tag(s) ${dangling.join(',')} are not on the forum any more, kept`);
			}
		} else if (thread.appliedTags.length > 0) {
			warnings.push(`thread ${thread.id}: applied_tags on a thread under a text channel, dropped`);
		}

		const memberCount = nonNegative(thread.memberCount) ?? members.length;
		if (thread.memberCount !== null && thread.memberCount !== members.length) {
			warnings.push(
				`thread ${thread.id}: thread_member_count ${thread.memberCount} differs from ${members.length} thread_members row(s), count kept`,
			);
		}
		const preview = buildMemberIdsPreview(thread.recentParticipantIds, members);
		const hasStarter = isForumPost ? true : input.starterThreadIds.has(thread.id);

		const state: ThreadStateRow = {
			thread_id: threadId,
			guild_id: guildId,
			parent_id: parentId,
			type: thread.type,
			archived: thread.archived,
			locked: thread.locked,
			invitable: isPrivate ? (thread.invitable ?? true) : null,
			auto_archive_duration: autoArchive ?? DEFAULT_THREAD_AUTO_ARCHIVE_DURATION,
			archive_timestamp: archiveTimestamp,
			created_at: createdAt,
			flags,
			applied_tags: appliedTags.length > 0 ? appliedTags : null,
			member_count: memberCount,
			member_ids_preview: preview.length > 0 ? preview.map((id) => createUserID(id)) : null,
			has_starter: hasStarter,
			state_version: MIGRATED_STATE_VERSION,
		};
		const messageCount = nonNegative(thread.messageCount) ?? 0;
		const memberRows: Array<ThreadMemberRow> = members.map((member) => ({
			thread_id: threadId,
			user_id: createUserID(member.userId),
			guild_id: guildId,
			parent_id: parentId,
			join_timestamp: member.joinTimestamp ?? createdAt,
			flags: member.flags & KNOWN_MEMBER_FLAG_MASK,
			muted: false,
			mute_config: null,
		}));
		threads.push({
			threadId: thread.id,
			state,
			stats: {thread_id: threadId, message_count: messageCount, total_message_sent: messageCount},
			byParent: {parent_id: parentId, thread_id: threadId, guild_id: guildId, type: thread.type},
			active: thread.archived ? null : {guild_id: guildId, thread_id: threadId, parent_id: parentId, type: thread.type},
			archived: thread.archived
				? {
						parent_id: parentId,
						is_private: isPrivate,
						archive_timestamp: archiveTimestamp,
						thread_id: threadId,
						guild_id: guildId,
					}
				: null,
			members: memberRows,
			byUser: memberRows.map((row) => ({
				user_id: row.user_id,
				guild_id: guildId,
				parent_id: parentId,
				is_private: isPrivate,
				thread_id: threadId,
			})),
			forumPin: flags === ChannelFlags.PINNED ? {parent_id: parentId, thread_id: threadId} : null,
		});
		threadCountByParent.set(thread.parentId!, (threadCountByParent.get(thread.parentId!) ?? 0) + 1);
		const earliest = earliestByGuild.get(thread.guildId!);
		if (earliest === undefined || createdAt < earliest) earliestByGuild.set(thread.guildId!, createdAt);
	}

	const parents: Array<PlannedParent> = [];
	const threadOnly: Array<ThreadOnlyChannelsByGuildRow> = [];
	const markerGuilds = new Set<bigint>(earliestByGuild.keys());
	for (const channel of [...liveChannels.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		if (channel.guildId === null) continue;
		const count = threadCountByParent.get(channel.id) ?? 0;
		if (THREAD_ONLY_CHANNEL_TYPES.has(channel.type)) {
			threadOnly.push({guild_id: createGuildID(channel.guildId), channel_id: createChannelID(channel.id)});
			parents.push({
				channelId: channel.id,
				guildId: channel.guildId,
				isThreadOnly: true,
				config: buildForumConfig(channel, count > 0, warnings),
				threadCount: count,
			});
			markerGuilds.add(channel.guildId);
			// A guild with a forum but no thread yet: first_active_at falls back to the forum's own creation time.
			const forumCreated = snowflakeToDate(channel.id);
			const known = earliestByGuild.get(channel.guildId);
			if (known === undefined || forumCreated < known) earliestByGuild.set(channel.guildId, forumCreated);
		} else if (count > 0) {
			parents.push({
				channelId: channel.id,
				guildId: channel.guildId,
				isThreadOnly: false,
				config: {...emptyConfig(createGuildID(channel.guildId), createChannelID(channel.id)), has_threads: true},
				threadCount: count,
			});
		}
	}

	const guildMarkers: Array<GuildThreadStateRow> = [...markerGuilds]
		.filter((guildId) => guildIds.has(guildId))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((guildId) => ({
			guild_id: createGuildID(guildId),
			// Deterministic so a re-plan produces the same row. perms_seeded_at stays null on purpose: ADR 0012 runs
			// upstream's SeedThreadPermissions job. search_backfilled_at stays null so thread search backfills itself.
			first_active_at: earliestByGuild.get(guildId)!,
			perms_seeded_at: null,
			search_backfilled_at: null,
		}));

	return {threads, parents, threadOnly, guildMarkers, skippedThreads, skippedMemberGroups, warnings};
}

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

function normalise(value: unknown): unknown {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) return `d:${value.getTime()}`;
	if (typeof value === 'bigint') return `b:${value.toString()}`;
	if (Array.isArray(value)) return value.length === 0 ? null : value.map(normalise);
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.map(([key, inner]) => [key, normalise(inner)] as const)
			.filter(([, inner]) => inner !== null)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Object.fromEntries(entries);
	}
	return value;
}

/** Order-insensitive over keys, null equals undefined equals an empty list, dates by instant, bigints by value. */
export function rowsEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(normalise(left)) === JSON.stringify(normalise(right));
}

/** The stable identity of an index row, so two plans over the same data derive identical keys. */
export function indexKey(parts: ReadonlyArray<bigint | number | boolean | Date | string>): string {
	return parts.map((part) => (part instanceof Date ? part.getTime().toString() : String(part))).join(':');
}
