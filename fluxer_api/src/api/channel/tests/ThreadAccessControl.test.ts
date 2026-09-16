// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads and forum posts take their access from the parent channel, and private
// threads are limited to their members and to parent-channel managers.

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {
	addMemberRole,
	allowPrivateThreads,
	createChannel,
	createPermissionOverwrite,
	createRole,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

async function createThread(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	body: {name: string; type?: number},
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/channels/${parentId}/threads`)
		.body(body)
		.expect(HTTP_STATUS.CREATED)
		.execute();
}

async function listThreadIds(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	archived = false,
): Promise<Array<string>> {
	const threads = await createBuilder<Array<ChannelResponse>>(harness, token)
		.get(`/channels/${parentId}/threads${archived ? '/archived' : ''}`)
		.execute();
	return threads.map((thread) => thread.id);
}

async function expectThreadHidden(harness: ApiTestHarness, account: TestAccount, threadId: string): Promise<void> {
	await createBuilder(harness, account.token).get(`/channels/${threadId}`).expect(HTTP_STATUS.FORBIDDEN).execute();
	await createBuilder(harness, account.token)
		.get(`/channels/${threadId}/messages`)
		.expect(HTTP_STATUS.FORBIDDEN)
		.execute();
	await createBuilder(harness, account.token)
		.put(`/channels/${threadId}/thread-members/@me`)
		.expect(HTTP_STATUS.FORBIDDEN)
		.execute();
	await createBuilder(harness, account.token)
		.get(`/channels/${threadId}/thread-members`)
		.expect(HTTP_STATUS.FORBIDDEN)
		.execute();
}

async function expectThreadVisible(harness: ApiTestHarness, account: TestAccount, threadId: string): Promise<void> {
	const channel = await createBuilder<ChannelResponse>(harness, account.token).get(`/channels/${threadId}`).execute();
	expect(channel.id).toBe(threadId);
	await createBuilder(harness, account.token).get(`/channels/${threadId}/messages`).execute();
	await createBuilder(harness, account.token).get(`/channels/${threadId}/thread-members`).execute();
}

describe('Thread access control', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('a thread under a channel hidden from @everyone is only reachable by an allowed role', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 2);
		const [outsider, staffer] = members;
		const staff = await createChannel(harness, owner.token, guild.id, 'staff');
		await createPermissionOverwrite(harness, owner.token, staff.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.VIEW_CHANNEL.toString(),
		});
		const staffRole = await createRole(harness, owner.token, guild.id, {name: 'Staff'});
		await createPermissionOverwrite(harness, owner.token, staff.id, staffRole.id, {
			type: 0,
			allow: Permissions.VIEW_CHANNEL.toString(),
			deny: '0',
		});
		await addMemberRole(harness, owner.token, guild.id, staffer.userId, staffRole.id);
		const thread = await createThread(harness, owner.token, staff.id, {name: 'staff only'});

		await expectThreadHidden(harness, outsider, thread.id);
		await ensureSessionStarted(harness, outsider.token);
		await createBuilder(harness, outsider.token)
			.post(`/channels/${thread.id}/messages`)
			.body({content: 'should not land'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		await createBuilder(harness, outsider.token)
			.get(`/channels/${staff.id}/threads`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		await createBuilder(harness, outsider.token)
			.post(`/channels/${staff.id}/threads`)
			.body({name: 'sneaky'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();

		await expectThreadVisible(harness, staffer, thread.id);
		await createBuilder(harness, staffer.token)
			.put(`/channels/${thread.id}/thread-members/@me`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await listThreadIds(harness, staffer.token, staff.id)).toContain(thread.id);
	});

	test('a private thread is hidden from non-members and visible to members and managers', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 3);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator, outsider, manager] = members;
		const managerRole = await createRole(harness, owner.token, guild.id, {
			name: 'Channel Manager',
			permissions: Permissions.MANAGE_CHANNELS.toString(),
		});
		await addMemberRole(harness, owner.token, guild.id, manager.userId, managerRole.id);
		const thread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'private chat',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		expect(thread.type).toBe(ChannelTypes.PRIVATE_THREAD);

		await expectThreadVisible(harness, creator, thread.id);
		expect(await listThreadIds(harness, creator.token, systemChannel.id)).toContain(thread.id);

		await expectThreadHidden(harness, outsider, thread.id);
		expect(await listThreadIds(harness, outsider.token, systemChannel.id)).not.toContain(thread.id);
		await createBuilder(harness, outsider.token)
			.patch(`/channels/${thread.id}/thread`)
			.body({name: 'renamed'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();

		await expectThreadVisible(harness, manager, thread.id);
		expect(await listThreadIds(harness, manager.token, systemChannel.id)).toContain(thread.id);
		await createBuilder(harness, manager.token)
			.put(`/channels/${thread.id}/thread-members/@me`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
	});

	test('archived thread listings exclude private threads the caller cannot see', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		await allowPrivateThreads(harness, owner.token, guild.id);
		const [creator, outsider] = members;
		const privateThread = await createThread(harness, creator.token, systemChannel.id, {
			name: 'private archived',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		const publicThread = await createThread(harness, creator.token, systemChannel.id, {name: 'public archived'});
		for (const thread of [privateThread, publicThread]) {
			await createBuilder(harness, creator.token)
				.patch(`/channels/${thread.id}/thread`)
				.body({archived: true})
				.execute();
		}
		const creatorView = await listThreadIds(harness, creator.token, systemChannel.id, true);
		expect(creatorView).toEqual(expect.arrayContaining([privateThread.id, publicThread.id]));
		const outsiderView = await listThreadIds(harness, outsider.token, systemChannel.id, true);
		expect(outsiderView).toContain(publicThread.id);
		expect(outsiderView).not.toContain(privateThread.id);
	});

	test('sending in a thread honours SEND_MESSAGES_IN_THREADS overwrites on the parent', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		const [muted, speaker] = members;
		const speakers = await createRole(harness, owner.token, guild.id, {name: 'Speakers'});
		await addMemberRole(harness, owner.token, guild.id, speaker.userId, speakers.id);
		const thread = await createThread(harness, owner.token, systemChannel.id, {name: 'announcements talk'});
		await createPermissionOverwrite(harness, owner.token, systemChannel.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.SEND_MESSAGES_IN_THREADS.toString(),
		});
		await createPermissionOverwrite(harness, owner.token, systemChannel.id, speakers.id, {
			type: 0,
			allow: Permissions.SEND_MESSAGES_IN_THREADS.toString(),
			deny: '0',
		});

		await ensureSessionStarted(harness, muted.token);
		await expectThreadVisible(harness, muted, thread.id);
		await createBuilder(harness, muted.token)
			.post(`/channels/${thread.id}/messages`)
			.body({content: 'blocked by the parent overwrite'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();

		await ensureSessionStarted(harness, speaker.token);
		await createBuilder(harness, speaker.token)
			.post(`/channels/${thread.id}/messages`)
			.body({content: 'allowed by the parent overwrite'})
			.execute();
	});
});
