// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: regressions from the review of the thread access-control hotfix. Threads must never
// outlive their parent channel, private threads must not announce themselves in the parent, and
// the create-from-message path must not reveal which messages carry a private thread.

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {
	allowPrivateThreads,
	createChannel,
	createGuild,
	createPermissionOverwrite,
	deleteChannel,
	setupTestGuildWithMembers,
	updateChannel,
} from '@app/api/channel/tests/ChannelTestUtils';
import {markChannelAsIndexed, markGuildChannelsAsIndexed, sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {isOrphanedThread} from '@app/api/worker/tasks/PurgeOrphanedThreads';
import {ChannelTypes, MessageTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

async function createThread(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	body: {name: string; type?: number; message_id?: string},
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/channels/${parentId}/threads`)
		.body(body)
		.expect(HTTP_STATUS.CREATED)
		.execute();
}

describe('Thread access review fixes', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('deleting a hidden parent channel takes its threads with it', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [outsider] = members;
		const staff = await createChannel(harness, owner.token, guild.id, 'staff');
		await createPermissionOverwrite(harness, owner.token, staff.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.VIEW_CHANNEL.toString(),
		});
		const thread = await createThread(harness, owner.token, staff.id, {name: 'staff secrets'});
		await sendMessage(harness, owner.token, thread.id, 'confidential');

		await createBuilder(harness, outsider.token)
			.get(`/channels/${thread.id}/messages`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();

		await deleteChannel(harness, owner.token, staff.id);

		for (const account of [outsider, owner]) {
			await createBuilder(harness, account.token)
				.get(`/channels/${thread.id}/messages`)
				.expect(HTTP_STATUS.NOT_FOUND)
				.execute();
			await createBuilder(harness, account.token).get(`/channels/${thread.id}`).expect(HTTP_STATUS.NOT_FOUND).execute();
		}
	});

	test('a thread whose parent row is missing is inaccessible to everyone', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [outsider] = members;
		const staff = await createChannel(harness, owner.token, guild.id, 'staff');
		await createPermissionOverwrite(harness, owner.token, staff.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.VIEW_CHANNEL.toString(),
		});
		const thread = await createThread(harness, owner.token, staff.id, {name: 'left behind'});
		await sendMessage(harness, owner.token, thread.id, 'still here');

		// Simulate an orphan written before parent deletion purged threads.
		await new ChannelDataRepository().delete(createChannelID(BigInt(staff.id)), createGuildID(BigInt(guild.id)));

		for (const account of [outsider, owner]) {
			await createBuilder(harness, account.token)
				.get(`/channels/${thread.id}/messages`)
				.expect(HTTP_STATUS.NOT_FOUND)
				.execute();
		}
		const active = await createBuilder<{threads: Array<ChannelResponse>}>(harness, outsider.token)
			.get(`/guilds/${guild.id}/threads/active`)
			.execute();
		expect(active.threads.map((t) => t.id)).not.toContain(thread.id);
	});

	test('creating a private thread posts no THREAD_CREATED message in the parent', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator] = members;
		const privateThread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'hush',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		const publicThread = await createThread(harness, creator.token, systemChannel.id, {name: 'open'});
		const messages = await createBuilder<Array<MessageResponse>>(harness, owner.token)
			.get(`/channels/${systemChannel.id}/messages`)
			.execute();
		const announced = messages.filter((m) => m.type === MessageTypes.THREAD_CREATED).map((m) => m.content);
		expect(announced).toContain(publicThread.id);
		expect(announced).not.toContain(privateThread.id);
	});

	test('the create-from-message path does not reveal a private thread to a non-member', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator, outsider] = members;
		const withPrivate = await sendMessage(harness, creator.token, systemChannel.id, 'start here');
		const withoutPrivate = await sendMessage(harness, creator.token, systemChannel.id, 'nothing here');
		const privateThread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'private branch',
			type: ChannelTypes.PRIVATE_THREAD,
			message_id: withPrivate.id,
		});
		// A private thread never adopts the message ID, so the message cannot point at it.
		expect(privateThread.id).not.toBe(withPrivate.id);
		// The probe gets the same answer whether or not a private thread was started there.
		const probed = await createThread(harness, outsider.token, systemChannel.id, {
			name: 'probe',
			message_id: withPrivate.id,
		});
		const control = await createThread(harness, outsider.token, systemChannel.id, {
			name: 'control',
			message_id: withoutPrivate.id,
		});
		expect(probed.id).toBe(withPrivate.id);
		expect(probed.type).toBe(ChannelTypes.PUBLIC_THREAD);
		expect(control.id).toBe(withoutPrivate.id);
	});

	test('a thread takes its age gate from the parent and the parent category at check time', async () => {
		const minor = await createTestAccount(harness, {dateOfBirth: '2010-01-01'});
		const guild = await createGuild(harness, minor.token, 'Age Gate Guild');
		const category = await createChannel(harness, minor.token, guild.id, 'after dark', ChannelTypes.GUILD_CATEGORY);
		const text = await createBuilder<ChannelResponse>(harness, minor.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'lounge', type: ChannelTypes.GUILD_TEXT, parent_id: category.id})
			.execute();
		const inCategory = await createThread(harness, minor.token, text.id, {name: 'under the category'});
		const plain = await createChannel(harness, minor.token, guild.id, 'plain');
		const underPlain = await createThread(harness, minor.token, plain.id, {name: 'under a later nsfw parent'});
		await createBuilder(harness, minor.token).get(`/channels/${inCategory.id}/messages`).execute();
		await createBuilder(harness, minor.token).get(`/channels/${underPlain.id}/messages`).execute();

		await updateChannel(harness, minor.token, category.id, {nsfw: true});
		await updateChannel(harness, minor.token, plain.id, {nsfw: true});

		const status = async (channelId: string) =>
			(await createBuilder(harness, minor.token).get(`/channels/${channelId}/messages`).executeRaw()).response.status;
		// The parent that was switched to nsfw is gated, and so is its thread despite the stale copy.
		expect(await status(plain.id)).toBe(HTTP_STATUS.FORBIDDEN);
		expect(await status(underPlain.id)).toBe(HTTP_STATUS.FORBIDDEN);
		// A thread always matches its parent, which inherits (or not) from the category.
		expect(await status(inCategory.id)).toBe(await status(text.id));
	});
});

describe('orphaned thread detection', () => {
	const live = {isSoftDeleted: false};
	const gone = {isSoftDeleted: true};
	test('flags threads with a missing, soft-deleted or absent parent and nothing else', async () => {
		const parentId = createChannelID(1n);
		expect(await isOrphanedThread({type: ChannelTypes.PUBLIC_THREAD, parentId}, async () => live)).toBe(false);
		expect(await isOrphanedThread({type: ChannelTypes.PUBLIC_THREAD, parentId}, async () => null)).toBe(true);
		expect(await isOrphanedThread({type: ChannelTypes.PRIVATE_THREAD, parentId}, async () => gone)).toBe(true);
		expect(await isOrphanedThread({type: ChannelTypes.PUBLIC_THREAD, parentId: null}, async () => live)).toBe(true);
		expect(await isOrphanedThread({type: ChannelTypes.GUILD_TEXT, parentId: null}, async () => null)).toBe(false);
	});
});

describe('private thread members in gateway-derived paths', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness({search: 'enabled'});
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('a private thread member finds its messages in guild search; an outsider does not', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator, outsider] = members;
		const thread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'hideout',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		await sendMessage(harness, creator.token, thread.id, 'tangerine hideout plans');
		await markGuildChannelsAsIndexed(harness, owner.token, guild.id);
		await markChannelAsIndexed(harness, thread.id);
		const search = async (token: string) =>
			createBuilder<{messages?: Array<{channel_id: string}>}>(harness, token)
				.post('/search/messages')
				.body({content: 'tangerine', context_guild_id: guild.id})
				.execute();
		const mine = await search(creator.token);
		expect(mine).toHaveProperty('messages');
		expect(mine.messages?.map((m) => m.channel_id)).toContain(thread.id);
		const theirs = await search(outsider.token);
		expect(theirs.messages?.map((m) => m.channel_id) ?? []).not.toContain(thread.id);
	});
});
