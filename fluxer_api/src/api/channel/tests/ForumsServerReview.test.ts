// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: regressions from the review of the forums server branch: thread writes must not roll
// back concurrent state, counts must stay exact, and previews must respect message history access.

import {type ChannelID, createChannelID, createMessageID} from '@app/api/BrandedTypes';
import {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {sendMessage} from '@app/api/message/tests/MessageTestUtils';
import type {Channel} from '@app/api/models/Channel';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

async function createThread(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	body: Record<string, unknown>,
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/channels/${parentId}/threads`)
		.body(body)
		.expect(HTTP_STATUS.CREATED)
		.execute();
}

async function getThread(harness: ApiTestHarness, token: string, threadId: string): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token).get(`/channels/${threadId}`).execute();
}

describe('Forums server review fixes', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
	});

	test('a thread PATCH does not roll back a message sent after the thread was read', async () => {
		const {owner, systemChannel} = await setupTestGuildWithMembers(harness, 0);
		const thread = await createThread(harness, owner.token, systemChannel.id, {name: 'busy'});
		const first = await sendMessage(harness, owner.token, thread.id, 'one');
		expect((await getThread(harness, owner.token, thread.id)).message_count).toBe(1);

		// Interleave: after updateThread reads the thread, a send lands before it writes.
		const threadId: ChannelID = createChannelID(BigInt(thread.id));
		const laterMessageId = createMessageID(BigInt(first.id) + 1_000_000n);
		const originalFindUnique = ChannelDataRepository.prototype.findUnique;
		let armed = true;
		vi.spyOn(ChannelDataRepository.prototype, 'findUnique').mockImplementation(async function (
			this: ChannelDataRepository,
			channelId: ChannelID,
		): Promise<Channel | null> {
			const result = await originalFindUnique.call(this, channelId);
			if (armed && channelId === threadId) {
				armed = false;
				await new ChannelDataRepository().updateLastMessageId(threadId, laterMessageId);
			}
			return result;
		});

		await createBuilder<ChannelResponse>(harness, owner.token)
			.patch(`/channels/${thread.id}/thread`)
			.body({name: 'renamed while busy'})
			.execute();
		vi.restoreAllMocks();

		const after = await getThread(harness, owner.token, thread.id);
		expect(after.name).toBe('renamed while busy');
		expect(after.message_count).toBe(2);
		expect(after.last_message_id).toBe(laterMessageId.toString());
	});
});
