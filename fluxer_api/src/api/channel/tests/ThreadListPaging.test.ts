// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the thread list endpoints returned every visible thread with no way to page. Both now
// take Discord-style `before` and `limit`, newest first, and still return the whole list when
// neither parameter is given, which is what clients built against the unpaged endpoints expect.

import {createChannel, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

async function createThread(
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

async function listThreads(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	query = '',
): Promise<Array<ChannelResponse>> {
	return createBuilder<Array<ChannelResponse>>(harness, token).get(`/channels/${parentId}/threads${query}`).execute();
}

describe('thread list paging', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('returns newest first, pages with before and limit, and returns everything unpaged', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		const created: Array<string> = [];
		for (let index = 0; index < 5; index += 1) {
			const thread = await createThread(harness, owner.token, parent.id, `thread ${index}`);
			created.push(thread.id);
		}
		const newestFirst = [...created].reverse();

		const all = await listThreads(harness, owner.token, parent.id);
		expect(all.map((thread) => thread.id)).toEqual(newestFirst);

		const firstPage = await listThreads(harness, owner.token, parent.id, '?limit=2');
		expect(firstPage.map((thread) => thread.id)).toEqual(newestFirst.slice(0, 2));

		const secondPage = await listThreads(harness, owner.token, parent.id, `?limit=2&before=${firstPage[1].id}`);
		expect(secondPage.map((thread) => thread.id)).toEqual(newestFirst.slice(2, 4));

		const tail = await listThreads(harness, owner.token, parent.id, `?before=${newestFirst[3]}`);
		expect(tail.map((thread) => thread.id)).toEqual([newestFirst[4]]);
	});

	test('paging works on the archived list too', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		const archived: Array<string> = [];
		for (let index = 0; index < 3; index += 1) {
			const thread = await createThread(harness, owner.token, parent.id, `old ${index}`);
			await createBuilder(harness, owner.token).patch(`/channels/${thread.id}/thread`).body({archived: true}).execute();
			archived.push(thread.id);
		}

		const page = await createBuilder<Array<ChannelResponse>>(harness, owner.token)
			.get(`/channels/${parent.id}/threads/archived?limit=1`)
			.execute();

		expect(page.map((thread) => thread.id)).toEqual([archived[2]]);
	});

	test('rejects a limit outside the documented range', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createChannel(harness, owner.token, guild.id, 'general');

		await createBuilder(harness, owner.token)
			.get(`/channels/${parent.id}/threads?limit=500`)
			.expect(HTTP_STATUS.BAD_REQUEST)
			.execute();
	});
});
