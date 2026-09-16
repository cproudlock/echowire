// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: server behaviour behind forum and thread parity with Discord. The client contract is
// documented in docs/forums-contract.md.

import {createChannelID} from '@app/api/BrandedTypes';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {
	addMemberRole,
	allowPrivateThreads,
	createChannel,
	createPermissionOverwrite,
	createRole,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {ensureSessionStarted, sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {clearRecordedGuildDispatches, recordedGuildDispatches} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {isThreadInactive} from '@app/api/worker/tasks/ArchiveInactiveThreads';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse, GuildActiveThreadsResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

async function createForum(
	harness: ApiTestHarness,
	token: string,
	guildId: string,
	body: Record<string, unknown> = {},
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/guilds/${guildId}/channels`)
		.body({name: 'forum', type: ChannelTypes.GUILD_FORUM, ...body})
		.execute();
}

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

async function patchThread(
	harness: ApiTestHarness,
	token: string,
	threadId: string,
	body: Record<string, unknown>,
	status: number = HTTP_STATUS.OK,
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.patch(`/channels/${threadId}/thread`)
		.body(body)
		.expect(status)
		.execute();
}

function dispatchesFor(event: string, id: string): Array<Record<string, unknown>> {
	return recordedGuildDispatches
		.filter((dispatch) => dispatch.event === event && (dispatch.data as {id?: string}).id === id)
		.map((dispatch) => dispatch.data as Record<string, unknown>);
}

describe('Forum and thread server parity', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
		clearRecordedGuildDispatches();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('forum defaults and tags are settable through the channel PATCH', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const forum = await createForum(harness, owner.token, guild.id, {default_forum_layout: 2});
		expect(forum.default_forum_layout).toBe(2);

		const updated = await createBuilder<ChannelResponse>(harness, owner.token)
			.patch(`/channels/${forum.id}`)
			.body({
				type: ChannelTypes.GUILD_FORUM,
				available_tags: [{name: 'Help'}, {name: 'Solved', emoji_name: '✅'}],
				default_forum_layout: 1,
				default_thread_rate_limit_per_user: 30,
				default_sort_order: 1,
				require_tag: true,
				rate_limit_per_user: 10,
			})
			.execute();
		expect(updated.available_tags?.map((tag) => tag.name)).toEqual(['Help', 'Solved']);
		expect(updated.available_tags?.[1]?.emoji_name).toBe('✅');
		expect(updated.default_forum_layout).toBe(1);
		expect(updated.default_thread_rate_limit_per_user).toBe(30);
		expect(updated.default_sort_order).toBe(1);
		expect(updated.require_tag).toBe(true);
		expect(updated.rate_limit_per_user).toBe(10);
	});

	test('new posts inherit the per-post slowmode and the forum slowmode limits post creation', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const forum = await createForum(harness, owner.token, guild.id, {
			default_thread_rate_limit_per_user: 45,
			rate_limit_per_user: 60,
		});
		const post = await createThread(harness, member.token, forum.id, {name: 'first post'});
		expect(post.rate_limit_per_user).toBe(45);

		await createBuilder(harness, member.token)
			.post(`/channels/${forum.id}/threads`)
			.body({name: 'second post too soon'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.SLOWMODE_RATE_LIMITED)
			.execute();
		await createThread(harness, owner.token, forum.id, {name: 'owner bypasses slowmode'});
		await createThread(harness, owner.token, forum.id, {name: 'owner again'});
	});

	test('message_count ignores a forum starter message and follows sends and deletes', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const forum = await createForum(harness, owner.token, guild.id);
		const post = await createThread(harness, member.token, forum.id, {name: 'a post'});
		await sendMessage(harness, member.token, post.id, 'starter body');
		expect((await getThread(harness, member.token, post.id)).message_count).toBe(0);
		const reply = await sendMessage(harness, owner.token, post.id, 'first reply');
		await sendMessage(harness, member.token, post.id, 'second reply');
		const afterReplies = await getThread(harness, member.token, post.id);
		expect(afterReplies.message_count).toBe(2);
		expect(afterReplies.last_message_id).toBeTruthy();

		await createBuilder(harness, owner.token)
			.delete(`/channels/${post.id}/messages/${reply.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect((await getThread(harness, member.token, post.id)).message_count).toBe(1);

		const textThread = await createThread(harness, member.token, systemChannel.id, {name: 'text thread'});
		await sendMessage(harness, member.token, textThread.id, 'counts from the first message');
		expect((await getThread(harness, member.token, textThread.id)).message_count).toBe(1);
	});

	test('a message into an archived thread reopens it and dispatches THREAD_UPDATE', async () => {
		const {owner, members, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const thread = await createThread(harness, owner.token, systemChannel.id, {name: 'sleepy'});
		await patchThread(harness, owner.token, thread.id, {archived: true});
		expect((await getThread(harness, member.token, thread.id)).thread_metadata?.archived).toBe(true);
		clearRecordedGuildDispatches();

		await sendMessage(harness, member.token, thread.id, 'wake up');
		expect((await getThread(harness, member.token, thread.id)).thread_metadata?.archived).toBe(false);
		const updates = dispatchesFor('THREAD_UPDATE', thread.id);
		expect(updates.length).toBeGreaterThan(0);
		expect((updates.at(-1)?.thread_metadata as {archived: boolean}).archived).toBe(false);
	});

	test('a locked archived thread rejects member sends but reopens for a moderator and stays locked', async () => {
		const {owner, members, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const thread = await createThread(harness, owner.token, systemChannel.id, {name: 'closed'});
		await patchThread(harness, owner.token, thread.id, {locked: true, archived: true});
		await ensureSessionStarted(harness, member.token);
		await createBuilder(harness, member.token)
			.post(`/channels/${thread.id}/messages`)
			.body({content: 'let me in'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		await sendMessage(harness, owner.token, thread.id, 'moderator note');
		const after = await getThread(harness, owner.token, thread.id);
		expect(after.thread_metadata?.archived).toBe(false);
		expect(after.thread_metadata?.locked).toBe(true);
	});

	test('creating a thread dispatches THREAD_MEMBERS_UPDATE for the creator', async () => {
		const {members, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const thread = await createThread(harness, member.token, systemChannel.id, {name: 'mine'});
		const [membersUpdate] = dispatchesFor('THREAD_MEMBERS_UPDATE', thread.id);
		expect(membersUpdate).toBeDefined();
		expect(membersUpdate.member_count).toBe(1);
		const added = membersUpdate.added_members as Array<{user_id: string; join_timestamp: string; id: string}>;
		expect(added[0]?.user_id).toBe(member.userId);
		expect(added[0]?.id).toBe(thread.id);
		expect(added[0]?.join_timestamp).toBeTruthy();
	});

	test('owners manage their own thread, but lock, pin and locked archive state are for moderators', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		const [creator, moderator] = members;
		const modRole = await createRole(harness, owner.token, guild.id, {
			name: 'Mods',
			permissions: Permissions.MANAGE_CHANNELS.toString(),
		});
		await addMemberRole(harness, owner.token, guild.id, moderator.userId, modRole.id);
		const thread = await createThread(harness, creator.token, systemChannel.id, {name: 'draft'});

		const renamed = await patchThread(harness, creator.token, thread.id, {name: 'final title'});
		expect(renamed.name).toBe('final title');
		await patchThread(harness, creator.token, thread.id, {locked: true}, HTTP_STATUS.FORBIDDEN);
		await patchThread(harness, creator.token, thread.id, {pinned: true}, HTTP_STATUS.FORBIDDEN);
		await patchThread(harness, creator.token, thread.id, {archived: true});
		await patchThread(harness, creator.token, thread.id, {archived: false});

		await patchThread(harness, moderator.token, thread.id, {locked: true, archived: true});
		await patchThread(harness, creator.token, thread.id, {archived: false}, HTTP_STATUS.FORBIDDEN);
		// A locked thread is frozen for its owner: no rename, retag or auto-archive change either.
		await patchThread(harness, creator.token, thread.id, {name: 'sneaky rename'}, HTTP_STATUS.FORBIDDEN);
		await patchThread(harness, creator.token, thread.id, {auto_archive_duration: 60}, HTTP_STATUS.FORBIDDEN);
		expect((await getThread(harness, moderator.token, thread.id)).name).toBe('final title');
		const reopened = await patchThread(harness, moderator.token, thread.id, {archived: false});
		expect(reopened.thread_metadata?.archived).toBe(false);
	});

	test('a forum keeps a single pinned post', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const forum = await createForum(harness, owner.token, guild.id);
		const first = await createThread(harness, owner.token, forum.id, {name: 'rules'});
		const second = await createThread(harness, owner.token, forum.id, {name: 'faq'});
		await patchThread(harness, owner.token, first.id, {pinned: true});
		clearRecordedGuildDispatches();
		await patchThread(harness, owner.token, second.id, {pinned: true});

		expect((await getThread(harness, owner.token, first.id)).pinned).toBeFalsy();
		expect((await getThread(harness, owner.token, second.id)).pinned).toBe(true);
		const unpin = dispatchesFor('THREAD_UPDATE', first.id);
		expect(unpin.length).toBe(1);
		expect(unpin[0]?.pinned).toBeFalsy();
	});

	test('deleting a thread removes its membership rows', async () => {
		const {owner, members, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const thread = await createThread(harness, owner.token, systemChannel.id, {name: 'temporary'});
		await createBuilder(harness, member.token)
			.put(`/channels/${thread.id}/thread-members/@me`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const repository = new ThreadMemberRepository();
		expect((await repository.listMembers(createChannelID(BigInt(thread.id)))).length).toBe(2);
		await createBuilder(harness, owner.token)
			.delete(`/channels/${thread.id}/thread`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await repository.listMembers(createChannelID(BigInt(thread.id)))).toEqual([]);
	});

	test('thread lists carry starter message previews', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const forum = await createForum(harness, owner.token, guild.id);
		const post = await createThread(harness, member.token, forum.id, {name: 'with body'});
		const longBody = `hello forum ${'x'.repeat(300)}`;
		await sendMessage(harness, member.token, post.id, longBody);
		await sendMessage(harness, owner.token, post.id, 'a reply that is not the starter');

		const forumPosts = await createBuilder<Array<ChannelResponse>>(harness, owner.token)
			.get(`/channels/${forum.id}/threads`)
			.execute();
		const preview = forumPosts.find((thread) => thread.id === post.id)?.starter_message_preview;
		expect(preview?.author?.id).toBe(member.userId);
		expect(preview?.content).toBe(longBody.slice(0, 200));
		expect(preview?.first_attachment).toBeNull();

		const source: MessageResponse = await sendMessage(harness, owner.token, systemChannel.id, 'start a thread here');
		const fromMessage = await createThread(harness, owner.token, systemChannel.id, {
			name: 'from a message',
			message_id: source.id,
		});
		const textThreads = await createBuilder<Array<ChannelResponse>>(harness, owner.token)
			.get(`/channels/${systemChannel.id}/threads`)
			.execute();
		const textPreview = textThreads.find((thread) => thread.id === fromMessage.id)?.starter_message_preview;
		expect(textPreview?.message_id).toBe(source.id);
		expect(textPreview?.content).toBe('start a thread here');
	});

	test('guild active threads list follows access rules and returns the caller memberships', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator, outsider] = members;
		const publicThread = await createThread(harness, creator.token, systemChannel.id, {name: 'public'});
		const privateThread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'private',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		const archived = await createThread(harness, creator.token, systemChannel.id, {name: 'archived'});
		await patchThread(harness, creator.token, archived.id, {archived: true});
		const forum = await createForum(harness, owner.token, guild.id);
		const post = await createThread(harness, owner.token, forum.id, {name: 'a post'});

		const creatorView = await createBuilder<GuildActiveThreadsResponse>(harness, creator.token)
			.get(`/guilds/${guild.id}/threads/active`)
			.execute();
		const creatorIds = creatorView.threads.map((thread) => thread.id);
		expect(creatorIds).toEqual(expect.arrayContaining([publicThread.id, privateThread.id, post.id]));
		expect(creatorIds).not.toContain(archived.id);
		expect(creatorView.members.map((member) => member.id)).toEqual(
			expect.arrayContaining([publicThread.id, privateThread.id]),
		);
		expect(creatorView.members.map((member) => member.id)).not.toContain(post.id);

		const outsiderView = await createBuilder<GuildActiveThreadsResponse>(harness, outsider.token)
			.get(`/guilds/${guild.id}/threads/active`)
			.execute();
		const outsiderIds = outsiderView.threads.map((thread) => thread.id);
		expect(outsiderIds).toContain(publicThread.id);
		expect(outsiderIds).not.toContain(privateThread.id);
		expect(outsiderView.members).toEqual([]);

		const hiddenForum = await createChannel(harness, owner.token, guild.id, 'staff-forum', ChannelTypes.GUILD_FORUM);
		await createPermissionOverwrite(harness, owner.token, hiddenForum.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.VIEW_CHANNEL.toString(),
		});
		const hiddenPost = await createThread(harness, owner.token, hiddenForum.id, {name: 'staff only'});
		const afterHiding = await createBuilder<GuildActiveThreadsResponse>(harness, outsider.token)
			.get(`/guilds/${guild.id}/threads/active`)
			.execute();
		expect(afterHiding.threads.map((thread) => thread.id)).not.toContain(hiddenPost.id);
	});

	test('private thread payloads to the gateway carry member ids', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator] = members;
		const privateThread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'secret',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		const [created] = dispatchesFor('THREAD_CREATE', privateThread.id);
		expect(created?.thread_member_ids).toEqual([creator.userId]);
		// thread_member_ids is gateway-internal and not part of the public schema.
		expect((privateThread as Record<string, unknown>).thread_member_ids).toBeUndefined();

		const publicThread = await createThread(harness, creator.token, systemChannel.id, {name: 'open'});
		const [publicCreated] = dispatchesFor('THREAD_CREATE', publicThread.id);
		expect(publicCreated?.thread_member_ids).toBeUndefined();
	});
});

describe('isThreadInactive', () => {
	const now = Date.parse('2026-09-14T12:00:00.000Z');
	test('uses the thread creation time when there are no messages', () => {
		expect(isThreadInactive({duration: '60', create_ts: '2026-09-14T10:30:00.000Z', last_message_id: null}, now)).toBe(
			true,
		);
		expect(isThreadInactive({duration: '60', create_ts: '2026-09-14T11:30:00.000Z', last_message_id: null}, now)).toBe(
			false,
		);
	});
	test('ignores invalid durations', () => {
		expect(isThreadInactive({duration: '0', create_ts: '2020-01-01T00:00:00.000Z', last_message_id: null}, now)).toBe(
			false,
		);
		expect(isThreadInactive({duration: 'nope', create_ts: null, last_message_id: null}, now)).toBe(false);
	});
});
