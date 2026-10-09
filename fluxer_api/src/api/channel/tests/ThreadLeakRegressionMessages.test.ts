// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: message-level thread leak regressions, ported from the September ThreadAccessReview
// (create-from-message must not reveal a private thread, a private thread must not announce
// itself in the parent) and extended to the paths that reuse a message outside its channel:
// forwards, replies, mentions and read state.

import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import {addMemberRole, createChannel} from '@app/api/channel/tests/ChannelTestUtils';
import {
	createViewRole,
	hideChannelFromEveryone,
	post,
	resetChannelThreadsConfig,
	setupLeakWorld,
	startPrivateThread,
	startThread,
	statusOf,
} from '@app/api/channel/tests/ThreadLeakRegressionUtils';
import {threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import {sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {getChannelRepository, getReadStateRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {ChannelTypes, MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const SECRET = 'tangerine-secret-plans';

describe('thread leak regression: messages', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		resetChannelThreadsConfig();
	});

	afterAll(async () => {
		resetChannelThreadsConfig();
		await harness.shutdown();
	});

	const memberOf = (threadId: string, userId: string) =>
		getChannelRepository().threads.getMember(createChannelID(BigInt(threadId)), createUserID(BigInt(userId)));

	describe('reusing a private thread message elsewhere', () => {
		it('refuses a forward into the parent from a user who is not in the thread', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			const secret = await post(harness, w.creator.token, thread.id, SECRET);

			const forward = await statusOf(harness, w.outsider.token, 'post', `/channels/${w.channelId}/messages`, {
				message_reference: {type: 1, channel_id: thread.id, message_id: secret.id},
			});

			expect(forward.status).toBeGreaterThanOrEqual(400);
			expect(forward.text).not.toContain(SECRET);
			const parent = await threadsRequest<Array<MessageResponse>>(harness, w.creator.token)
				.get(`/channels/${w.channelId}/messages`)
				.execute();
			expect(JSON.stringify(parent)).not.toContain(SECRET);
		});

		it('refuses a cross-channel reply to a private thread message, and a thread started on it', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			const secret = await post(harness, w.creator.token, thread.id, SECRET);

			const reply = await statusOf(harness, w.outsider.token, 'post', `/channels/${w.channelId}/messages`, {
				content: 'replying',
				message_reference: {channel_id: thread.id, message_id: secret.id},
			});
			expect(reply.status).toBeGreaterThanOrEqual(400);
			expect(reply.text).not.toContain(SECRET);

			const nested = await statusOf(
				harness,
				w.outsider.token,
				'post',
				`/channels/${thread.id}/messages/${secret.id}/threads`,
				{name: 'probe'},
			);
			expect(nested.status).toBeGreaterThanOrEqual(400);
			expect(nested.text).not.toContain(SECRET);
		});

		it('never lets a message point at a private thread through the start-from-message route', async () => {
			const w = await setupLeakWorld(harness);
			const source = await sendMessage(harness, w.creator.token, w.channelId, 'start here');
			const untouched = await sendMessage(harness, w.creator.token, w.channelId, 'nothing here');

			// Asking for a private thread on a message still yields a public one that shares the message id.
			const started = await threadsRequest<{id: string; type: number}>(harness, w.creator.token)
				.post(`/channels/${w.channelId}/messages/${source.id}/threads`)
				.body({name: 'private branch', type: ChannelTypes.PRIVATE_THREAD})
				.expect(201)
				.execute();
			expect(started.type).toBe(ChannelTypes.PUBLIC_THREAD);
			expect(started.id).toBe(source.id);

			const privateThread = await startPrivateThread(harness, w.creator.token, w.channelId);
			expect([source.id, untouched.id]).not.toContain(privateThread.id);

			// A second thread on the same message is refused with the same answer whoever asks, so the
			// route cannot be used to find which messages carry a hidden thread.
			const again = await statusOf(
				harness,
				w.outsider.token,
				'post',
				`/channels/${w.channelId}/messages/${source.id}/threads`,
				{name: 'probe'},
			);
			expect(again.status).toBe(400);
			const fresh = await statusOf(
				harness,
				w.outsider.token,
				'post',
				`/channels/${w.channelId}/messages/${untouched.id}/threads`,
				{name: 'control'},
			);
			expect(fresh.status).toBe(201);
		});

		it('keeps the parent history free of private thread activity', async () => {
			const w = await setupLeakWorld(harness);
			await sendMessage(harness, w.creator.token, w.channelId, 'anchor');
			const parentIds = async () =>
				(
					await threadsRequest<Array<MessageResponse>>(harness, w.outsider.token)
						.get(`/channels/${w.channelId}/messages`)
						.execute()
				).map((message) => message.id);
			const before = await parentIds();

			const thread = await startPrivateThread(harness, w.creator.token, w.channelId, 'hush hush');
			await threadsRequest(harness, w.creator.token)
				.put(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
				.expect(204)
				.execute();
			await threadsRequest(harness, w.creator.token)
				.delete(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
				.expect(204)
				.execute();
			await post(harness, w.creator.token, thread.id, SECRET);
			await threadsRequest(harness, w.creator.token)
				.patch(`/channels/${thread.id}`)
				.body({name: 'renamed hush'})
				.execute();
			await threadsRequest(harness, w.creator.token).patch(`/channels/${thread.id}`).body({archived: true}).execute();

			expect(await parentIds()).toEqual(before);
			const publicThread = await startThread(harness, w.creator.token, w.channelId, {name: 'open'});
			const after = await threadsRequest<Array<MessageResponse>>(harness, w.outsider.token)
				.get(`/channels/${w.channelId}/messages`)
				.execute();
			const announced = after.filter((message) => message.type === MessageTypes.THREAD_CREATED);
			expect(publicThread.name).toBe('open');
			expect(announced.map((message) => message.content)).toEqual(['open']);
			expect(JSON.stringify(after)).not.toContain('hush');
		});
	});

	describe('mentions', () => {
		it('add a mentioned user who can see the parent to an invitable private thread', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			await post(harness, w.creator.token, thread.id, `hello <@${w.outsider.userId}>`);

			expect(await memberOf(thread.id, w.outsider.userId)).not.toBeNull();
		});

		it('do not add anyone to a private thread that is not invitable', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			await threadsRequest(harness, w.creator.token)
				.patch(`/channels/${thread.id}`)
				.body({invitable: false})
				.expect(200)
				.execute();
			await threadsRequest(harness, w.creator.token)
				.put(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
				.expect(403)
				.execute();

			await post(harness, w.creator.token, thread.id, `hello <@${w.outsider.userId}> ${SECRET}`);

			expect(await memberOf(thread.id, w.outsider.userId)).toBeNull();
			const read = await statusOf(harness, w.outsider.token, 'get', `/channels/${thread.id}/messages`);
			expect(read.status).toBeGreaterThanOrEqual(400);
			expect(read.text).not.toContain(SECRET);
		});

		it('do not add a mentioned user who cannot see the parent', async () => {
			const w = await setupLeakWorld(harness);
			const staff = await createChannel(harness, w.owner.token, w.guildId, 'staff');
			await hideChannelFromEveryone(harness, w.owner.token, w.guildId, staff.id);
			const role = await createViewRole(harness, w.owner.token, w.guildId, staff.id, 'staff');
			await addMemberRole(harness, w.owner.token, w.guildId, w.creator.userId, role.id);
			const thread = await startPrivateThread(harness, w.creator.token, staff.id);

			await post(harness, w.creator.token, thread.id, `hello <@${w.outsider.userId}> ${SECRET}`);

			expect(await memberOf(thread.id, w.outsider.userId)).toBeNull();
			const read = await statusOf(harness, w.outsider.token, 'get', `/channels/${thread.id}/messages`);
			expect(read.status).toBeGreaterThanOrEqual(400);
			expect(read.text).not.toContain(SECRET);
		});

		it('never pull a role mention into a private thread', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);

			await post(harness, w.creator.token, thread.id, `@everyone ${SECRET}`);

			expect(await memberOf(thread.id, w.outsider.userId)).toBeNull();
		});
	});

	describe('read state', () => {
		const readStateRow = (userId: string, threadId: string) =>
			getReadStateRepository().getReadState(createUserID(BigInt(userId)), createChannelID(BigInt(threadId)));

		it('records an ack for a private thread the user is in', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			const message = await post(harness, w.creator.token, thread.id, 'hello');

			await threadsRequest(harness, w.creator.token)
				.post(`/channels/${thread.id}/messages/${message.id}/ack`)
				.body({})
				.expect(204)
				.execute();

			expect(await readStateRow(w.creator.userId, thread.id)).not.toBeNull();
		});

		// KNOWN GAP, found while porting the September tests. POST /channels/{id}/messages/{id}/ack and
		// POST /read-states/ack-bulk never check that the caller can view the channel, so acking a
		// private thread the caller is not in writes a read state row stamped with the thread flags
		// and guild id. The response is a flat 204 and the row only echoes what the caller sent, so
		// no content is exposed, but it does confirm that a snowflake is a thread. `it.fails` keeps
		// this honest: it passes while the gap exists and fails, prompting its removal, once the
		// ack routes refuse threads the caller cannot view.
		it.fails('writes no read state when a user who cannot view the private thread acks it', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			const message = await post(harness, w.creator.token, thread.id, 'hello');

			await threadsRequest(harness, w.outsider.token)
				.post(`/channels/${thread.id}/messages/${message.id}/ack`)
				.body({})
				.execute();
			await threadsRequest(harness, w.outsider.token)
				.post('/read-states/ack-bulk')
				.body({read_states: [{channel_id: thread.id, message_id: message.id}]})
				.execute();

			expect(await readStateRow(w.outsider.userId, thread.id)).toBeNull();
		});
	});
});
