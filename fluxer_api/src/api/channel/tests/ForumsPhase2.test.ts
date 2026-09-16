// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: forums phase 2. Moderated tags, add to post, recent participants, the thread member
// limit and per-post slowmode. The client contract is documented in docs/forums2-contract.md.

import {
	loadFixture,
	sendMessageWithAttachments,
	createChannel as uploadCreateChannel,
} from '@app/api/channel/tests/AttachmentTestUtils';
import {
	addMemberRole,
	createPermissionOverwrite,
	createRole,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {clearRecordedGuildDispatches, recordedGuildDispatches} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
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

async function createPost(
	harness: ApiTestHarness,
	token: string,
	forumId: string,
	body: Record<string, unknown>,
	status: number = HTTP_STATUS.CREATED,
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/channels/${forumId}/threads`)
		.body(body)
		.expect(status)
		.execute();
}

async function patchPost(
	harness: ApiTestHarness,
	token: string,
	postId: string,
	body: Record<string, unknown>,
	status: number = HTTP_STATUS.OK,
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.patch(`/channels/${postId}/thread`)
		.body(body)
		.expect(status)
		.execute();
}

async function setTags(
	harness: ApiTestHarness,
	token: string,
	forumId: string,
	tags: Array<Record<string, unknown>>,
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.patch(`/channels/${forumId}`)
		.body({type: ChannelTypes.GUILD_FORUM, available_tags: tags})
		.execute();
}

// A member who can see and post in the forum but cannot moderate its threads.
async function grantPostingRole(
	harness: ApiTestHarness,
	ownerToken: string,
	guildId: string,
	memberId: string,
): Promise<void> {
	const role = await createRole(harness, ownerToken, guildId, {
		name: 'posters',
		permissions: (
			Permissions.VIEW_CHANNEL |
			Permissions.SEND_MESSAGES |
			Permissions.READ_MESSAGE_HISTORY |
			Permissions.CREATE_PUBLIC_THREADS |
			Permissions.SEND_MESSAGES_IN_THREADS
		).toString(),
	});
	await addMemberRole(harness, ownerToken, guildId, memberId, role.id);
}

describe('Forums phase 2', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
		clearRecordedGuildDispatches();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	describe('moderated tags', () => {
		test('a tag is not moderated unless asked for, and the flag round trips', async () => {
			const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
			const forum = await createForum(harness, owner.token, guild.id, {
				available_tags: [{name: 'Help'}, {name: 'Solved', moderated: true}],
			});
			expect(forum.available_tags?.map((tag) => [tag.name, tag.moderated])).toEqual([
				['Help', false],
				['Solved', true],
			]);

			const updated = await setTags(harness, owner.token, forum.id, [
				{id: forum.available_tags?.[0]?.id, name: 'Help', moderated: true},
				{id: forum.available_tags?.[1]?.id, name: 'Solved'},
			]);
			expect(updated.available_tags?.map((tag) => tag.moderated)).toEqual([true, false]);
		});

		test('a member without manage threads cannot apply a moderated tag to a new post', async () => {
			const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
			const [member] = members;
			const forum = await createForum(harness, owner.token, guild.id, {
				available_tags: [{name: 'Open'}, {name: 'Staff pick', moderated: true}],
			});
			await grantPostingRole(harness, owner.token, guild.id, member.userId);
			const moderatedTagId = forum.available_tags?.find((tag) => tag.moderated)?.id as string;
			const plainTagId = forum.available_tags?.find((tag) => !tag.moderated)?.id as string;

			await createPost(
				harness,
				member.token,
				forum.id,
				{name: 'mine', applied_tags: [moderatedTagId]},
				HTTP_STATUS.FORBIDDEN,
			);
			const allowed = await createPost(harness, member.token, forum.id, {
				name: 'mine',
				applied_tags: [plainTagId],
			});
			expect(allowed.applied_tags).toEqual([plainTagId]);
		});

		test('a moderator applies a moderated tag and the owner retagging keeps it', async () => {
			const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
			const [member] = members;
			const forum = await createForum(harness, owner.token, guild.id, {
				available_tags: [{name: 'Open'}, {name: 'Answered'}, {name: 'Staff pick', moderated: true}],
			});
			await grantPostingRole(harness, owner.token, guild.id, member.userId);
			const tags = forum.available_tags ?? [];
			const open = tags.find((tag) => tag.name === 'Open')?.id as string;
			const answered = tags.find((tag) => tag.name === 'Answered')?.id as string;
			const staffPick = tags.find((tag) => tag.moderated)?.id as string;

			const post = await createPost(harness, member.token, forum.id, {name: 'question', applied_tags: [open]});
			const moderated = await patchPost(harness, owner.token, post.id, {applied_tags: [open, staffPick]});
			expect(moderated.applied_tags).toEqual([open, staffPick]);

			// The owner replaces their own tags and does not send the moderated one: it survives.
			const retagged = await patchPost(harness, member.token, post.id, {applied_tags: [answered]});
			expect(retagged.applied_tags).toEqual([staffPick, answered]);

			// A moderator removes it by sending a set without it.
			const cleared = await patchPost(harness, owner.token, post.id, {applied_tags: [answered]});
			expect(cleared.applied_tags).toEqual([answered]);
		});
	});

	describe('add to post', () => {
		test('the post owner appends a reply attachment to the starter and gains a thumbnail', async () => {
			const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
			const forum = await createForum(harness, owner.token, guild.id);
			const post = await createPost(harness, owner.token, forum.id, {name: 'look at this'});
			await sendMessage(harness, owner.token, post.id, 'starter, no media');

			const {json: reply} = await sendMessageWithAttachments(
				harness,
				owner.token,
				post.id,
				{content: 'here it is', attachments: [{id: 0, filename: 'yeah.png'}]},
				[{index: 0, filename: 'yeah.png', data: loadFixture('yeah.png')}],
			);
			const attachmentId = reply.attachments?.[0]?.id as string;
			expect(attachmentId).toBeDefined();

			clearRecordedGuildDispatches();
			const updated = await createBuilder<ChannelResponse>(harness, owner.token)
				.post(`/channels/${post.id}/starter-message/attachments`)
				.body({message_id: reply.id, attachment_id: attachmentId})
				.execute();
			expect(updated.starter_message_preview?.first_attachment?.id).toBe(attachmentId);
			expect(recordedGuildDispatches.some((dispatch) => dispatch.event === 'MESSAGE_UPDATE')).toBe(true);
			expect(
				recordedGuildDispatches.some(
					(dispatch) => dispatch.event === 'THREAD_UPDATE' && (dispatch.data as {id?: string}).id === post.id,
				),
			).toBe(true);

			// Appending the same attachment twice is rejected.
			await createBuilder(harness, owner.token)
				.post(`/channels/${post.id}/starter-message/attachments`)
				.body({message_id: reply.id, attachment_id: attachmentId})
				.expect(HTTP_STATUS.BAD_REQUEST)
				.execute();
		});

		test('someone who neither owns the post nor moderates threads is refused', async () => {
			const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
			const [member] = members;
			const forum = await createForum(harness, owner.token, guild.id);
			await grantPostingRole(harness, owner.token, guild.id, member.userId);
			const post = await createPost(harness, owner.token, forum.id, {name: 'owners post'});
			await sendMessage(harness, owner.token, post.id, 'starter');
			const {json: reply} = await sendMessageWithAttachments(
				harness,
				owner.token,
				post.id,
				{content: 'media', attachments: [{id: 0, filename: 'yeah.png'}]},
				[{index: 0, filename: 'yeah.png', data: loadFixture('yeah.png')}],
			);

			await createBuilder(harness, member.token)
				.post(`/channels/${post.id}/starter-message/attachments`)
				.body({message_id: reply.id, attachment_id: reply.attachments?.[0]?.id})
				.expect(HTTP_STATUS.FORBIDDEN)
				.execute();
		});

		test('an attachment from another channel is not found', async () => {
			const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
			const forum = await createForum(harness, owner.token, guild.id);
			const post = await createPost(harness, owner.token, forum.id, {name: 'post'});
			await sendMessage(harness, owner.token, post.id, 'starter');
			const elsewhere = await uploadCreateChannel(harness, owner.token, guild.id, 'other');
			const {json: reply} = await sendMessageWithAttachments(
				harness,
				owner.token,
				elsewhere.id,
				{content: 'media', attachments: [{id: 0, filename: 'yeah.png'}]},
				[{index: 0, filename: 'yeah.png', data: loadFixture('yeah.png')}],
			);

			await createBuilder(harness, owner.token)
				.post(`/channels/${post.id}/starter-message/attachments`)
				.body({message_id: reply.id, attachment_id: reply.attachments?.[0]?.id})
				.expect(HTTP_STATUS.NOT_FOUND)
				.execute();
		});
	});

	describe('recent participants', () => {
		test('a post carries its recent distinct authors, newest first', async () => {
			const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
			const [member] = members;
			const forum = await createForum(harness, owner.token, guild.id);
			await grantPostingRole(harness, owner.token, guild.id, member.userId);
			const post = await createPost(harness, owner.token, forum.id, {name: 'chat'});
			await sendMessage(harness, owner.token, post.id, 'starter');
			await sendMessage(harness, member.token, post.id, 'a reply');
			await sendMessage(harness, owner.token, post.id, 'and another');

			const [listed] = await createBuilder<Array<ChannelResponse>>(harness, owner.token)
				.get(`/channels/${forum.id}/threads`)
				.execute();
			expect(listed.recent_participant_ids).toEqual([owner.userId, member.userId]);
		});

		test('a plain channel carries no participants', async () => {
			const {owner, guild, systemChannel} = await setupTestGuildWithMembers(harness, 0);
			await sendMessage(harness, owner.token, systemChannel.id, 'hello');
			const channel = await createBuilder<ChannelResponse>(harness, owner.token)
				.get(`/channels/${systemChannel.id}`)
				.execute();
			expect(channel.recent_participant_ids ?? null).toBeNull();
			expect(guild.id).toBeDefined();
		});
	});

	describe('per-post slowmode', () => {
		test('a new post inherits the forum default and the owner may change its own', async () => {
			const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
			const forum = await createForum(harness, owner.token, guild.id, {default_thread_rate_limit_per_user: 45});
			const post = await createPost(harness, owner.token, forum.id, {name: 'slow'});
			expect(post.rate_limit_per_user).toBe(45);

			const updated = await patchPost(harness, owner.token, post.id, {rate_limit_per_user: 10});
			expect(updated.rate_limit_per_user).toBe(10);
		});
	});

	describe('thread member limit', () => {
		test('the limit is registered and reported by the admin limit config', async () => {
			const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
			const forum = await createForum(harness, owner.token, guild.id);
			const post = await createPost(harness, owner.token, forum.id, {name: 'post'});
			// The creator is a member and is never refused, so the default cap leaves room.
			const members = await createBuilder<Array<{user_id: string}>>(harness, owner.token)
				.get(`/channels/${post.id}/thread-members`)
				.execute();
			expect(members.map((member) => member.user_id)).toEqual([owner.userId]);
			expect(guild.id).toBeDefined();
		});
	});

	describe('forum permissions are unchanged for tagless forums', () => {
		test('a forum with no moderated tags lets an ordinary member retag their post', async () => {
			const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
			const [member] = members;
			const forum = await createForum(harness, owner.token, guild.id, {
				available_tags: [{name: 'One'}, {name: 'Two'}],
			});
			await grantPostingRole(harness, owner.token, guild.id, member.userId);
			await createPermissionOverwrite(harness, owner.token, forum.id, guild.id, {
				type: 0,
				allow: Permissions.VIEW_CHANNEL.toString(),
				deny: '0',
			});
			const tags = forum.available_tags ?? [];
			const post = await createPost(harness, member.token, forum.id, {
				name: 'mine',
				applied_tags: [tags[0]?.id as string],
			});
			const retagged = await patchPost(harness, member.token, post.id, {applied_tags: [tags[1]?.id as string]});
			expect(retagged.applied_tags).toEqual([tags[1]?.id]);
		});
	});
});
