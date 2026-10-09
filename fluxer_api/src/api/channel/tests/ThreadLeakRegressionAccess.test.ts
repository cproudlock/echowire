// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: port of the September thread access regression tests (ThreadAccessControl and
// ThreadAccessReview) onto upstream's thread implementation. A thread takes its access from its
// parent channel, and a private thread is further limited to its members and thread moderators.
// Nothing about a thread a viewer cannot see may leak through any read route, whichever refusal
// code upstream picks.

import {addMemberRole, createChannel, deleteChannel, leaveGuild} from '@app/api/channel/tests/ChannelTestUtils';
import {
	createViewRole,
	hideChannelFromEveryone,
	joinGuild,
	type LeakWorld,
	post,
	resetChannelThreadsConfig,
	setupLeakWorld,
	startPrivateThread,
	startThread,
	statusOf,
} from '@app/api/channel/tests/ThreadLeakRegressionUtils';
import {threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ThreadPermissionFlags} from '@fluxer/constants/src/ThreadPermissionUtils';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const SECRET = 'tangerine-secret-plans';

describe('thread leak regression: access', () => {
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

	// Every route a user client has for reading or touching one thread. Each must refuse a viewer
	// who cannot see the thread and must never echo the thread content back.
	async function expectThreadClosed(token: string, threadId: string, messageId: string): Promise<void> {
		const probes: Array<[string, 'get' | 'post' | 'put' | 'patch' | 'delete', string, unknown?]> = [
			['channel', 'get', `/channels/${threadId}`],
			['messages', 'get', `/channels/${threadId}/messages`],
			['message by id', 'get', `/channels/${threadId}/messages/${messageId}`],
			['pins', 'get', `/channels/${threadId}/messages/pins`],
			['join', 'put', `/channels/${threadId}/thread-members/@me`],
			['send', 'post', `/channels/${threadId}/messages`, {content: 'should not land'}],
			['pin', 'put', `/channels/${threadId}/pins/${messageId}`],
			['pins ack', 'post', `/channels/${threadId}/pins/ack`],
			['react', 'put', `/channels/${threadId}/messages/${messageId}/reactions/%F0%9F%91%8D/@me`],
			['rename', 'patch', `/channels/${threadId}`, {name: 'renamed'}],
			['delete', 'delete', `/channels/${threadId}`],
			['typing', 'post', `/channels/${threadId}/typing`],
		];
		for (const [label, method, path, body] of probes) {
			const {status, text} = await statusOf(harness, token, method, path, body);
			expect(status, `${label}: ${method} ${path} answered ${status}: ${text}`).toBeGreaterThanOrEqual(400);
			expect(status, `${label}: ${method} ${path}`).not.toBe(500);
			expect(text, label).not.toContain(SECRET);
		}
		const bulk = await statusOf(harness, token, 'post', '/channels/messages/bulk', {
			requests: [{channel_id: threadId, limit: 10}],
		});
		expect(bulk.text, 'bulk fetch').not.toContain(SECRET);
	}

	async function threadReadable(token: string, threadId: string): Promise<boolean> {
		const channel = await statusOf(harness, token, 'get', `/channels/${threadId}`);
		const messages = await statusOf(harness, token, 'get', `/channels/${threadId}/messages`);
		return channel.status === 200 && messages.status === 200;
	}

	describe('private threads', () => {
		it('hide every route from a guild member who is not in the thread, and stay open to members', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			const secret = await post(harness, w.creator.token, thread.id, SECRET);

			await expectThreadClosed(w.outsider.token, thread.id, secret.id);

			const own = await threadsRequest<Array<MessageResponse>>(harness, w.creator.token)
				.get(`/channels/${thread.id}/messages`)
				.execute();
			expect(own.map((message) => message.content)).toContain(SECRET);
		});

		it('open to a user who was added by a member, and closed again once they leave', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			await post(harness, w.creator.token, thread.id, SECRET);
			expect(await threadReadable(w.outsider.token, thread.id)).toBe(false);

			await threadsRequest(harness, w.creator.token)
				.put(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
				.expect(204)
				.execute();
			expect(await threadReadable(w.outsider.token, thread.id)).toBe(true);

			await threadsRequest(harness, w.outsider.token)
				.delete(`/channels/${thread.id}/thread-members/@me`)
				.expect(204)
				.execute();
			expect(await threadReadable(w.outsider.token, thread.id)).toBe(false);
		});

		it('are open to a thread moderator who is not a member, which upstream decides on the parent permission', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			// The thread permission bits only survive on a request that carries the thread capability.
			const role = await threadsRequest<{id: string}>(harness, w.owner.token)
				.post(`/guilds/${w.guildId}/roles`)
				.body({name: 'thread mods', permissions: ThreadPermissionFlags.MANAGE_THREADS.toString()})
				.execute();
			expect(await threadReadable(w.outsider.token, thread.id)).toBe(false);
			await addMemberRole(harness, w.owner.token, w.guildId, w.outsider.userId, role.id);
			expect(await threadReadable(w.outsider.token, thread.id)).toBe(true);
		});

		it('are absent from the public archived list for everyone but the members and moderators', async () => {
			const w = await setupLeakWorld(harness);
			const privateThread = await startPrivateThread(harness, w.creator.token, w.channelId);
			const publicThread = await startThread(harness, w.creator.token, w.channelId, {name: 'open'});
			for (const thread of [privateThread, publicThread]) {
				await threadsRequest(harness, w.creator.token).patch(`/channels/${thread.id}`).body({archived: true}).execute();
			}
			const outsiderPublic = await threadsRequest<{threads: Array<{id: string}>}>(harness, w.outsider.token)
				.get(`/channels/${w.channelId}/threads/archived/public`)
				.execute();
			expect(outsiderPublic.threads.map((thread) => thread.id)).toEqual([publicThread.id]);
			const outsiderJoined = await threadsRequest<{threads: Array<{id: string}>}>(harness, w.outsider.token)
				.get(`/channels/${w.channelId}/users/@me/threads/archived/private`)
				.execute();
			expect(outsiderJoined.threads).toEqual([]);
			const outsiderAll = await statusOf(
				harness,
				w.outsider.token,
				'get',
				`/channels/${w.channelId}/threads/archived/private`,
			);
			expect(outsiderAll.status).toBe(403);
			expect(outsiderAll.text).not.toContain(privateThread.id);
		});
	});

	describe('threads under a hidden parent', () => {
		it('are reachable only through a role that can view the parent', async () => {
			const w = await setupLeakWorld(harness);
			const staff = await createChannel(harness, w.owner.token, w.guildId, 'staff');
			await hideChannelFromEveryone(harness, w.owner.token, w.guildId, staff.id);
			const role = await createViewRole(harness, w.owner.token, w.guildId, staff.id, 'staff');
			await addMemberRole(harness, w.owner.token, w.guildId, w.creator.userId, role.id);
			const thread = await startThread(harness, w.owner.token, staff.id, {name: 'staff only'});
			const secret = await post(harness, w.owner.token, thread.id, SECRET);

			await expectThreadClosed(w.outsider.token, thread.id, secret.id);
			for (const path of [
				`/channels/${staff.id}/threads/archived/public`,
				`/channels/${staff.id}/users/@me/threads/archived/private`,
			]) {
				const {status, text} = await statusOf(harness, w.outsider.token, 'get', path);
				expect(status, path).toBeGreaterThanOrEqual(400);
				expect(text).not.toContain(thread.id);
			}
			const sneaky = await statusOf(harness, w.outsider.token, 'post', `/channels/${staff.id}/threads`, {
				name: 'sneaky',
				type: 11,
			});
			expect(sneaky.status).toBeGreaterThanOrEqual(400);

			expect(await threadReadable(w.creator.token, thread.id)).toBe(true);
			await threadsRequest(harness, w.creator.token)
				.put(`/channels/${thread.id}/thread-members/@me`)
				.expect(204)
				.execute();
		});

		it('are closed to a thread member the moment they lose the parent, public or private', async () => {
			const w = await setupLeakWorld(harness);
			const publicThread = await startThread(harness, w.creator.token, w.channelId, {name: 'open'});
			const privateThread = await startPrivateThread(harness, w.creator.token, w.channelId);
			await threadsRequest(harness, w.creator.token)
				.put(`/channels/${privateThread.id}/thread-members/${w.outsider.userId}`)
				.expect(204)
				.execute();
			await threadsRequest(harness, w.outsider.token)
				.put(`/channels/${publicThread.id}/thread-members/@me`)
				.expect(204)
				.execute();
			await post(harness, w.creator.token, publicThread.id, SECRET);
			await post(harness, w.creator.token, privateThread.id, SECRET);
			expect(await threadReadable(w.outsider.token, publicThread.id)).toBe(true);
			expect(await threadReadable(w.outsider.token, privateThread.id)).toBe(true);

			await hideChannelFromEveryone(harness, w.owner.token, w.guildId, w.channelId);

			expect(await threadReadable(w.outsider.token, publicThread.id)).toBe(false);
			expect(await threadReadable(w.outsider.token, privateThread.id)).toBe(false);
			const sent = await statusOf(harness, w.outsider.token, 'post', `/channels/${privateThread.id}/messages`, {
				content: 'still here?',
			});
			expect(sent.status).toBeGreaterThanOrEqual(400);
		});

		it('are closed to a member who left the guild and stay closed after they rejoin without the thread', async () => {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			await threadsRequest(harness, w.creator.token)
				.put(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
				.expect(204)
				.execute();
			await post(harness, w.creator.token, thread.id, SECRET);
			expect(await threadReadable(w.outsider.token, thread.id)).toBe(true);

			await leaveGuild(harness, w.outsider.token, w.guildId);
			expect(await threadReadable(w.outsider.token, thread.id)).toBe(false);
		});

		it('do not survive the deletion of their parent for anyone', async () => {
			const w = await setupLeakWorld(harness);
			const staff = await createChannel(harness, w.owner.token, w.guildId, 'staff');
			await hideChannelFromEveryone(harness, w.owner.token, w.guildId, staff.id);
			const thread = await startThread(harness, w.owner.token, staff.id, {name: 'staff secrets'});
			await post(harness, w.owner.token, thread.id, SECRET);
			expect(await threadReadable(w.owner.token, thread.id)).toBe(true);

			await deleteChannel(harness, w.owner.token, staff.id);

			for (const account of [w.outsider, w.owner]) {
				const messages = await statusOf(harness, account.token, 'get', `/channels/${thread.id}/messages`);
				expect(messages.status).toBeGreaterThanOrEqual(400);
				expect(messages.text).not.toContain(SECRET);
				const channel = await statusOf(harness, account.token, 'get', `/channels/${thread.id}`);
				expect(channel.status).toBeGreaterThanOrEqual(400);
			}
		});
	});

	it('applies the parent READ_MESSAGE_HISTORY denial to single message reads in a thread', async () => {
		const w = await setupLeakWorld(harness);
		const forum = await threadsRequest<{id: string}>(harness, w.owner.token)
			.post(`/guilds/${w.guildId}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		const forumPost = await threadsRequest<{id: string}>(harness, w.owner.token)
			.post(`/channels/${forum.id}/threads`)
			.body({name: 'secret body', message: {content: SECRET}})
			.expect(201)
			.execute();
		const text = await startThread(harness, w.owner.token, w.channelId, {name: 'plain thread'});
		const textMessage = await post(harness, w.owner.token, text.id, SECRET);
		const readable = async (threadId: string, messageId: string) =>
			(await statusOf(harness, w.outsider.token, 'get', `/channels/${threadId}/messages/${messageId}`)).status === 200;
		// A forum post shares its id with its starter message.
		expect(await readable(forumPost.id, forumPost.id)).toBe(true);
		expect(await readable(text.id, textMessage.id)).toBe(true);

		for (const parentId of [forum.id, w.channelId]) {
			await threadsRequest(harness, w.owner.token)
				.put(`/channels/${parentId}/permissions/${w.guildId}`)
				.body({type: 0, allow: '0', deny: Permissions.READ_MESSAGE_HISTORY.toString()})
				.expect(204)
				.execute();
		}

		expect(await readable(forumPost.id, forumPost.id)).toBe(false);
		expect(await readable(text.id, textMessage.id)).toBe(false);
	});

	it('does not let a late joiner read a thread started before they could see the parent', async () => {
		const w: LeakWorld = await setupLeakWorld(harness);
		const staff = await createChannel(harness, w.owner.token, w.guildId, 'staff');
		await hideChannelFromEveryone(harness, w.owner.token, w.guildId, staff.id);
		const thread = await startThread(harness, w.owner.token, staff.id, {name: 'before you came'});
		await post(harness, w.owner.token, thread.id, SECRET);
		const late = await joinGuild(harness, w.owner, w.channelId);
		expect(await threadReadable(late.token, thread.id)).toBe(false);
	});
});
