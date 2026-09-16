// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: deleting a thread has to remove what belongs to it. The user-facing route used to drop
// the channel row only, leaving the thread's messages, attachments and search documents behind,
// while the parent-channel delete and the orphan sweep purged them properly.

import {createChannelID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {createChannel, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {ensureSessionStarted, sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

describe('thread delete purges the thread', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('deleting a thread removes its messages and membership, not just the channel row', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		const thread = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/channels/${parent.id}/threads`)
			.body({name: 'doomed'})
			.expect(HTTP_STATUS.CREATED)
			.execute();
		await ensureSessionStarted(harness, owner.token);
		await sendMessage(harness, owner.token, thread.id, 'first');
		await sendMessage(harness, owner.token, thread.id, 'second');

		const channelRepository = new ChannelRepository();
		const threadId = createChannelID(BigInt(thread.id));
		expect(await channelRepository.messages.listMessages(threadId, undefined, 50)).toHaveLength(2);

		await createBuilder(harness, owner.token)
			.delete(`/channels/${thread.id}/thread`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(await channelRepository.messages.listMessages(threadId, undefined, 50)).toEqual([]);
		expect(await channelRepository.findUnique(threadId)).toBeNull();
		expect(await new ThreadMemberRepository().listMembers(threadId)).toEqual([]);
	});
});
