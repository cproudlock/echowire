// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: port of the September "private thread members in gateway-derived paths" search test
// onto upstream's thread search scope. Guild and cross-guild message search may return hits from a
// thread only for a user who can open that thread right now: a member of a private thread, or a
// thread moderator, and only while they can still view the parent channel.

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {
	hideChannelFromEveryone,
	post,
	resetChannelThreadsConfig,
	setupLeakWorld,
	startPrivateThread,
	startThread,
} from '@app/api/channel/tests/ThreadLeakRegressionUtils';
import {threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import {markChannelAsIndexed, markGuildChannelsAsIndexed} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {TEST_TIMEOUTS, wait} from '@app/api/test/TestConstants';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface SearchResult {
	messages: Array<{id: string; channel_id: string; content?: string}>;
}

const NEEDLE = 'tangerine';

describe('thread leak regression: search', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness({search: 'enabled'});
	});

	beforeEach(async () => {
		await harness.reset();
		resetChannelThreadsConfig();
	});

	afterAll(async () => {
		resetChannelThreadsConfig();
		await harness.shutdown();
	});

	async function search(
		account: TestAccount,
		body: Record<string, unknown>,
		options: {status?: number; expected?: number} = {},
	): Promise<SearchResult> {
		for (let attempt = 0; ; attempt++) {
			const {response, json} = await threadsRequest<SearchResult>(harness, account.token)
				.post('/search/messages')
				.body({content: NEEDLE, ...body})
				.executeRaw();
			if (options.status !== undefined) {
				expect(response.status).toBe(options.status);
				return json;
			}
			expect(response.status).toBe(200);
			if (attempt >= 20 || ('messages' in json && json.messages.length >= (options.expected ?? 1))) return json;
			await wait(TEST_TIMEOUTS.QUICK);
		}
	}

	async function setup() {
		const w = await setupLeakWorld(harness);
		await markGuildChannelsAsIndexed(harness, w.owner.token, w.guildId);
		const privateThread = await startPrivateThread(harness, w.creator.token, w.channelId);
		const publicThread = await startThread(harness, w.creator.token, w.channelId, {name: 'open'});
		await post(harness, w.creator.token, privateThread.id, `${NEEDLE} hideout plans`);
		await post(harness, w.creator.token, publicThread.id, `${NEEDLE} open plans`);
		await markChannelAsIndexed(harness, privateThread.id);
		await markChannelAsIndexed(harness, publicThread.id);
		return {w, privateThread, publicThread};
	}

	const channelsOf = (result: SearchResult) => result.messages.map((message) => message.channel_id);

	it('returns private thread hits to a member and never to a guild member outside the thread', async () => {
		const {w, privateThread, publicThread} = await setup();

		const mine = await search(w.creator, {context_guild_id: w.guildId}, {expected: 2});
		expect(channelsOf(mine)).toEqual(expect.arrayContaining([privateThread.id, publicThread.id]));

		// Searching as the member first has waited for the index, so the outsider sees a settled index.
		const theirs = await search(w.outsider, {context_guild_id: w.guildId}, {expected: 1});
		expect(channelsOf(theirs)).toContain(publicThread.id);
		expect(channelsOf(theirs)).not.toContain(privateThread.id);
		expect(JSON.stringify(theirs)).not.toContain('hideout');

		const everywhere = await search(w.outsider, {scope: 'all_guilds'}, {expected: 1});
		expect(channelsOf(everywhere)).not.toContain(privateThread.id);
	});

	it('refuses an explicit channel filter that names a private thread the user is not in', async () => {
		const {w, privateThread} = await setup();
		await search(w.creator, {context_guild_id: w.guildId, channel_ids: [privateThread.id]});

		const refused = await search(
			w.outsider,
			{context_guild_id: w.guildId, channel_ids: [privateThread.id]},
			{status: 403},
		);
		expect(JSON.stringify(refused)).not.toContain('hideout');
	});

	it('drops every thread hit once the user loses the parent channel, members included', async () => {
		const {w, privateThread, publicThread} = await setup();
		const before = await search(w.creator, {context_guild_id: w.guildId}, {expected: 2});
		expect(channelsOf(before)).toEqual(expect.arrayContaining([privateThread.id, publicThread.id]));

		await hideChannelFromEveryone(harness, w.owner.token, w.guildId, w.channelId);

		const after = await search(w.creator, {context_guild_id: w.guildId}, {expected: 0});
		expect(channelsOf(after)).not.toContain(privateThread.id);
		expect(channelsOf(after)).not.toContain(publicThread.id);
		const named = await search(
			w.creator,
			{context_guild_id: w.guildId, channel_ids: [privateThread.id]},
			{status: 403},
		);
		expect(JSON.stringify(named)).not.toContain('hideout');
	});
});
