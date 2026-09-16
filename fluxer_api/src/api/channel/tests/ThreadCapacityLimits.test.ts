// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads and forum posts are channel rows, so two things have to hold. They must not
// count against max_guild_channels, or a forum with enough posts would permanently block channel
// creation, and they need a ceiling of their own so the set the gateway and READY carry stays
// bounded. Only active (non-archived) threads count, so archiving frees room again.

import {createChannel, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

async function setLimits(limits: Partial<Record<LimitKey, number>>): Promise<void> {
	await getLimitConfigService().updateConfig({
		traitDefinitions: [],
		rules: [{id: 'thread-capacity-test', limits}],
	});
}

async function createForum(harness: ApiTestHarness, token: string, guildId: string, name = 'forum'): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/guilds/${guildId}/channels`)
		.body({name, type: ChannelTypes.GUILD_FORUM})
		.execute();
}

async function createPost(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	name: string,
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/channels/${parentId}/threads`)
		.body({name})
		.expect(HTTP_STATUS.CREATED)
		.execute();
}

async function expectThreadCapReached(harness: ApiTestHarness, token: string, parentId: string): Promise<void> {
	await createBuilder(harness, token)
		.post(`/channels/${parentId}/threads`)
		.body({name: 'over the cap'})
		.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MAX_ACTIVE_THREADS)
		.execute();
}

describe('thread capacity', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('forum posts stay creatable with many posts already under the forum', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const forum = await createForum(harness, owner.token, guild.id);

		for (let index = 0; index < 8; index += 1) {
			await createPost(harness, owner.token, forum.id, `post ${index}`);
		}
		const extraChannel = await createChannel(harness, owner.token, guild.id, 'still-room-for-channels');

		expect(extraChannel.type).toBe(ChannelTypes.GUILD_TEXT);
	});

	test('a channel refuses posts past its active thread cap, and archiving frees room', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const forum = await createForum(harness, owner.token, guild.id);
		await setLimits({max_active_threads_per_channel: 2});

		const first = await createPost(harness, owner.token, forum.id, 'first');
		await createPost(harness, owner.token, forum.id, 'second');
		await expectThreadCapReached(harness, owner.token, forum.id);

		await createBuilder(harness, owner.token).patch(`/channels/${first.id}/thread`).body({archived: true}).execute();

		const third = await createPost(harness, owner.token, forum.id, 'third after archiving');
		expect(third.name).toBe('third after archiving');
	});

	test('the per-channel cap is counted per parent, not across the guild', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const busy = await createForum(harness, owner.token, guild.id, 'busy');
		const quiet = await createForum(harness, owner.token, guild.id, 'quiet');
		await setLimits({max_active_threads_per_channel: 1});

		await createPost(harness, owner.token, busy.id, 'fills the busy forum');
		await expectThreadCapReached(harness, owner.token, busy.id);

		const elsewhere = await createPost(harness, owner.token, quiet.id, 'still fine here');
		expect(elsewhere.parent_id).toBe(quiet.id);
	});

	test('a guild refuses threads past its guild-wide active thread cap', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const forum = await createForum(harness, owner.token, guild.id);
		const text = await createChannel(harness, owner.token, guild.id, 'chat');
		await setLimits({max_active_threads_per_guild: 1});

		await createPost(harness, owner.token, forum.id, 'only one');
		await expectThreadCapReached(harness, owner.token, text.id);
	});
});
