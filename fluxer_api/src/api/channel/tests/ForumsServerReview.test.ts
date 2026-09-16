// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: regressions from the review of the forums server branch: thread writes must not roll
// back concurrent state, counts must stay exact, and previews must respect message history access.

import {type ChannelID, createChannelID, createMessageID} from '@app/api/BrandedTypes';
import {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {
	allowPrivateThreads,
	createPermissionOverwrite,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {ensureSessionStarted, sendMessage} from '@app/api/message/tests/MessageTestUtils';
import type {Channel} from '@app/api/models/Channel';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {clearRecordedGuildDispatches, recordedGuildDispatches} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
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

async function getMessagesIn(
	harness: ApiTestHarness,
	token: string,
	channelId: string,
): Promise<Array<MessageResponse>> {
	return createBuilder<Array<MessageResponse>>(harness, token).get(`/channels/${channelId}/messages`).execute();
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

	test('concurrent sends keep message_count exact, including a forum post starter race', async () => {
		const {owner, systemChannel, guild} = await setupTestGuildWithMembers(harness, 0);
		const thread = await createThread(harness, owner.token, systemChannel.id, {name: 'crowded'});
		await ensureSessionStarted(harness, owner.token);
		await Promise.all(
			Array.from({length: 12}, (_, index) =>
				createBuilder(harness, owner.token)
					.post(`/channels/${thread.id}/messages`)
					.body({content: `burst ${index}`})
					.execute(),
			),
		);
		expect((await getThread(harness, owner.token, thread.id)).message_count).toBe(12);

		const forum = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		const post = await createThread(harness, owner.token, forum.id, {name: 'racy post'});
		await Promise.all(
			Array.from({length: 6}, (_, index) =>
				createBuilder(harness, owner.token)
					.post(`/channels/${post.id}/messages`)
					.body({content: `opening ${index}`})
					.execute(),
			),
		);
		// Exactly one of the six is the starter; the other five count.
		expect((await getThread(harness, owner.token, post.id)).message_count).toBe(5);
	});

	test('deleting a forum post starter leaves message_count alone, singly and in bulk', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const forum = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();

		const single = await createThread(harness, owner.token, forum.id, {name: 'single'});
		const starter = await sendMessage(harness, owner.token, single.id, 'starter');
		await sendMessage(harness, owner.token, single.id, 'reply one');
		const replyTwo = await sendMessage(harness, owner.token, single.id, 'reply two');
		expect((await getThread(harness, owner.token, single.id)).message_count).toBe(2);
		await createBuilder(harness, owner.token)
			.delete(`/channels/${single.id}/messages/${starter.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect((await getThread(harness, owner.token, single.id)).message_count).toBe(2);
		// With the starter gone, the earliest remaining message is a counted reply.
		const replyOne = (await getMessagesIn(harness, owner.token, single.id)).find((m) => m.content === 'reply one');
		await createBuilder(harness, owner.token)
			.delete(`/channels/${single.id}/messages/${replyOne?.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect((await getThread(harness, owner.token, single.id)).message_count).toBe(1);
		expect(replyTwo.id).toBeTruthy();

		const bulk = await createThread(harness, owner.token, forum.id, {name: 'bulk'});
		const ids = [
			(await sendMessage(harness, owner.token, bulk.id, 'starter')).id,
			(await sendMessage(harness, owner.token, bulk.id, 'reply a')).id,
			(await sendMessage(harness, owner.token, bulk.id, 'reply b')).id,
		];
		await sendMessage(harness, owner.token, bulk.id, 'reply c');
		expect((await getThread(harness, owner.token, bulk.id)).message_count).toBe(3);
		await createBuilder(harness, owner.token)
			.post(`/channels/${bulk.id}/messages/bulk-delete`)
			.body({messages: ids})
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect((await getThread(harness, owner.token, bulk.id)).message_count).toBe(1);
	});

	test('starter previews are omitted without READ_MESSAGE_HISTORY on the parent', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [reader] = members;
		const forum = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		const post = await createThread(harness, owner.token, forum.id, {name: 'secret body'});
		await sendMessage(harness, owner.token, post.id, 'only for readers of history');

		const previewFor = async (token: string, path: string) => {
			const body = await createBuilder<Array<ChannelResponse> | {threads: Array<ChannelResponse>}>(harness, token)
				.get(path)
				.execute();
			const threads = Array.isArray(body) ? body : body.threads;
			return threads.find((thread) => thread.id === post.id)?.starter_message_preview;
		};
		expect((await previewFor(reader.token, `/channels/${forum.id}/threads`))?.content).toBe(
			'only for readers of history',
		);

		await createPermissionOverwrite(harness, owner.token, forum.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.READ_MESSAGE_HISTORY.toString(),
		});
		expect(await previewFor(reader.token, `/channels/${forum.id}/threads`)).toBeUndefined();
		expect(await previewFor(reader.token, `/guilds/${guild.id}/threads/active`)).toBeUndefined();
		expect((await previewFor(owner.token, `/channels/${forum.id}/threads`))?.content).toBe(
			'only for readers of history',
		);
	});

	test('a rejected forum post does not use up the post-creation slowmode window', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const forum = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		const configured = await createBuilder<ChannelResponse>(harness, owner.token)
			.patch(`/channels/${forum.id}`)
			.body({
				type: ChannelTypes.GUILD_FORUM,
				available_tags: [{name: 'Help'}],
				require_tag: true,
				rate_limit_per_user: 60,
			})
			.execute();
		const helpTag = configured.available_tags?.[0]?.id;
		expect(helpTag).toBeTruthy();

		await createBuilder(harness, member.token)
			.post(`/channels/${forum.id}/threads`)
			.body({name: 'forgot the tag'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		await createBuilder(harness, member.token)
			.post(`/channels/${forum.id}/threads`)
			.body({name: 'names a missing message', applied_tags: [helpTag], message_id: '1234567890123456789'})
			.expect(HTTP_STATUS.NOT_FOUND)
			.execute();
		await createThread(harness, member.token, forum.id, {name: 'tagged this time', applied_tags: [helpTag]});
		await createBuilder(harness, member.token)
			.post(`/channels/${forum.id}/threads`)
			.body({name: 'too soon', applied_tags: [helpTag]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.SLOWMODE_RATE_LIMITED)
			.execute();
	});

	test('THREAD_DELETE for a private thread tells the gateway who its members were', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator] = members;
		const thread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'short lived',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		clearRecordedGuildDispatches();
		await createBuilder(harness, creator.token)
			.delete(`/channels/${thread.id}/thread`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const deletes = recordedGuildDispatches.filter(
			(dispatch) => dispatch.event === 'THREAD_DELETE' && (dispatch.data as {id?: string}).id === thread.id,
		);
		expect(deletes).toHaveLength(1);
		expect((deletes[0]!.data as {thread_member_ids?: Array<string>}).thread_member_ids).toEqual([creator.userId]);
	});
});
