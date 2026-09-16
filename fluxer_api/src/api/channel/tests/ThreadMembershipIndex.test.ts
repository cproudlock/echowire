// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: thread membership is written twice, partitioned by thread and by user. The by-user
// index is what lets a session be told which threads it belongs to without walking every thread of
// every guild. These tests hold the two sides in step: whatever joins or leaves through the api
// must appear in, or disappear from, the index.

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {createChannel, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {sendMessage} from '@app/api/message/tests/MessageTestUtils';
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

describe('thread membership by-user index', () => {
	let harness: ApiTestHarness;
	const repository = new ThreadMemberRepository();

	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('creating a thread indexes the creator, with the guild it belongs to', async () => {
		const {owner, guild, systemChannel} = await setupTestGuildWithMembers(harness, 0);
		const thread = await createThread(harness, owner.token, systemChannel.id, 'indexed on create');

		const memberships = await repository.listMembershipsForUser(createUserID(BigInt(owner.userId)));
		const entry = memberships.find((membership) => membership.threadId.toString() === thread.id);
		expect(entry).toBeDefined();
		expect(entry?.guildId?.toString()).toBe(guild.id);
		expect(entry?.userId.toString()).toBe(owner.userId);
	});

	test('sending the first message indexes the author, and leaving removes them', async () => {
		const {owner, members, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [joiner] = members;
		const thread = await createThread(harness, owner.token, systemChannel.id, 'indexed on send');

		await sendMessage(harness, joiner.token, thread.id, 'auto joins me');
		const afterSend = await repository.listMembershipsForUser(createUserID(BigInt(joiner.userId)));
		expect(afterSend.map((membership) => membership.threadId.toString())).toContain(thread.id);

		await createBuilder(harness, joiner.token)
			.delete(`/channels/${thread.id}/thread-members/@me`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const afterLeave = await repository.listMembershipsForUser(createUserID(BigInt(joiner.userId)));
		expect(afterLeave.map((membership) => membership.threadId.toString())).not.toContain(thread.id);
	});

	test('the index only ever lists that user, across two guilds', async () => {
		const first = await setupTestGuildWithMembers(harness, 0);
		const second = await setupTestGuildWithMembers(harness, 0);
		const firstThread = await createThread(harness, first.owner.token, first.systemChannel.id, 'first guild');
		const secondThread = await createThread(harness, second.owner.token, second.systemChannel.id, 'second guild');

		const firstMemberships = await repository.listMembershipsForUser(createUserID(BigInt(first.owner.userId)));
		const firstThreadIds = firstMemberships.map((membership) => membership.threadId.toString());
		expect(firstThreadIds).toContain(firstThread.id);
		expect(firstThreadIds).not.toContain(secondThread.id);
	});

	test('deleting a thread clears its rows from the index', async () => {
		const {owner, systemChannel} = await setupTestGuildWithMembers(harness, 0);
		const thread = await createThread(harness, owner.token, systemChannel.id, 'deleted later');
		expect(
			(await repository.listMembershipsForUser(createUserID(BigInt(owner.userId)))).map((m) => m.threadId.toString()),
		).toContain(thread.id);

		await createBuilder(harness, owner.token)
			.delete(`/channels/${thread.id}/thread`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const afterDelete = await repository.listMembershipsForUser(createUserID(BigInt(owner.userId)));
		expect(afterDelete.map((membership) => membership.threadId.toString())).not.toContain(thread.id);
	});

	test('a channel with no threads leaves the index empty for a fresh account', async () => {
		const account = await createTestAccount(harness);
		expect(await repository.listMembershipsForUser(createUserID(BigInt(account.userId)))).toEqual([]);
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		await createChannel(harness, owner.token, guild.id, 'no threads here');
		expect(await repository.listMembershipsForUser(createUserID(BigInt(account.userId)))).toEqual([]);
	});
});
