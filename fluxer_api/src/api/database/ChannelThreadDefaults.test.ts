// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the thread and forum columns are optional on ChannelRow, and the Channels table fills
// the absent ones at the write boundary. These tests pin the claim ADR 0005 rests on: a channel row
// literal that says nothing about threads still stores exactly what spelling all 17 columns out
// would have stored.

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {CHANNEL_COLUMNS, type ChannelRow} from '@app/api/database/types/ChannelTypes';
import {Channels} from '@app/api/Tables';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, test} from 'vitest';

const THREAD_COLUMNS = [
	'thread_archived',
	'thread_auto_archive_duration',
	'thread_archive_timestamp',
	'thread_locked',
	'thread_invitable',
	'thread_create_timestamp',
	'thread_member_count',
	'thread_message_count',
	'thread_pinned',
	'available_tags',
	'applied_tags',
	'default_reaction_emoji',
	'default_sort_order',
	'forum_default_auto_archive_duration',
	'forum_require_tag',
	'default_forum_layout',
	'default_thread_rate_limit_per_user',
] as const satisfies ReadonlyArray<keyof ChannelRow>;

// A guild text channel, written the way a call site now writes one: no thread state at all.
function textChannelRow(): ChannelRow {
	return {
		channel_id: createChannelID(1000n),
		guild_id: createGuildID(2000n),
		type: ChannelTypes.GUILD_TEXT,
		name: 'general',
		topic: null,
		icon_hash: null,
		url: null,
		parent_id: null,
		position: 0,
		owner_id: null,
		recipient_ids: null,
		nsfw: false,
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
		version: 0,
	};
}

describe('channel thread column defaults', () => {
	test('a row that omits thread state still writes every column', () => {
		const query = Channels.insert(textChannelRow());
		for (const column of CHANNEL_COLUMNS) {
			expect(Object.hasOwn(query.params, column), `missing column ${column}`).toBe(true);
		}
		for (const column of THREAD_COLUMNS) {
			expect(query.params[column], `expected null for ${column}`).toBeNull();
		}
	});

	test('omitting thread state matches spelling every column out', () => {
		const implicit = Channels.insert(textChannelRow());
		const explicit = Channels.insert({
			...textChannelRow(),
			...Object.fromEntries(THREAD_COLUMNS.map((column) => [column, null])),
		} as ChannelRow);
		expect(implicit.cql).toBe(explicit.cql);
		expect(implicit.params).toEqual(explicit.params);
	});

	test('thread state set by a thread site survives the boundary', () => {
		const query = Channels.upsertAll({
			...textChannelRow(),
			type: ChannelTypes.PUBLIC_THREAD,
			parent_id: createChannelID(1000n),
			thread_archived: false,
			thread_locked: true,
			thread_message_count: 7,
			applied_tags: ['tag-1'],
		});
		expect(query.params.thread_locked).toBe(true);
		expect(query.params.thread_message_count).toBe(7);
		expect(query.params.applied_tags).toEqual(['tag-1']);
		// The columns this thread does not use are still written, as null.
		expect(query.params.available_tags).toBeNull();
		expect(query.params.default_forum_layout).toBeNull();
	});
});
