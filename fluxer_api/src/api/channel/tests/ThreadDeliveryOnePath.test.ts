// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: one route answers "which threads may I see", and the client recovers through it rather
// than through a second gateway mechanism. These tests pin the two cases that used to need one:
// access arriving after connect, which the deleted THREAD_LIST_SYNC covered, and a link pointing
// at a thread the session payload does not carry.

import {
	addMemberRole,
	createChannel,
	createPermissionOverwrite,
	createRole,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {markGuildChannelsAsIndexed} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse, GuildActiveThreadsResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
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

async function activeThreads(
	harness: ApiTestHarness,
	token: string,
	guildId: string,
): Promise<GuildActiveThreadsResponse> {
	return createBuilder<GuildActiveThreadsResponse>(harness, token).get(`/guilds/${guildId}/threads/active`).execute();
}

describe('one path for thread delivery', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('the guild active thread list reports a thread once access to its parent arrives', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [reader] = members;
		const staff = await createChannel(harness, owner.token, guild.id, 'staff');
		await createPermissionOverwrite(harness, owner.token, staff.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.VIEW_CHANNEL.toString(),
		});
		const thread = await createThread(harness, owner.token, staff.id, 'staff only');
		await markGuildChannelsAsIndexed(harness, owner.token, guild.id);

		const before = await activeThreads(harness, reader.token, guild.id);
		expect(before.threads.map((entry) => entry.id)).not.toContain(thread.id);

		// Access arrives the way it does in practice: a role that is allowed to view the parent.
		const role = await createRole(harness, owner.token, guild.id, {name: 'Staff'});
		await createPermissionOverwrite(harness, owner.token, staff.id, role.id, {
			type: 0,
			allow: Permissions.VIEW_CHANNEL.toString(),
			deny: '0',
		});
		await addMemberRole(harness, owner.token, guild.id, reader.userId, role.id);
		await markGuildChannelsAsIndexed(harness, owner.token, guild.id);

		const after = await activeThreads(harness, reader.token, guild.id);
		expect(after.threads.map((entry) => entry.id)).toContain(thread.id);
	});

	test('an archived thread is absent from the active list and still fetchable by id', async () => {
		const {owner, guild, systemChannel} = await setupTestGuildWithMembers(harness, 0);
		const thread = await createThread(harness, owner.token, systemChannel.id, 'wrapped up');
		await markGuildChannelsAsIndexed(harness, owner.token, guild.id);

		await createBuilder(harness, owner.token)
			.patch(`/channels/${thread.id}/thread`)
			.body({archived: true})
			.expect(HTTP_STATUS.OK)
			.execute();

		const listed = await activeThreads(harness, owner.token, guild.id);
		expect(listed.threads.map((entry) => entry.id)).not.toContain(thread.id);

		// The recovery path a client takes when a link lands on a thread its session never carried.
		const fetched = await createBuilder<ChannelResponse>(harness, owner.token)
			.get(`/channels/${thread.id}`)
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(fetched.id).toBe(thread.id);
		expect(fetched.thread_metadata?.archived).toBe(true);
	});

	test('the active list carries the caller own memberships, which is what the session payload reports', async () => {
		const {owner, guild, systemChannel} = await setupTestGuildWithMembers(harness, 0);
		const thread = await createThread(harness, owner.token, systemChannel.id, 'joined by its creator');
		await markGuildChannelsAsIndexed(harness, owner.token, guild.id);

		const listed = await activeThreads(harness, owner.token, guild.id);
		expect(listed.threads.map((entry) => entry.id)).toContain(thread.id);
		const membership = listed.members.find((member) => member.id === thread.id);
		expect(membership?.user_id).toBe(owner.userId);
	});
});
