// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: thread membership rows are partitioned by thread, so nothing can find a user's threads
// from the user side. Account deletion, guild deletion and the data export all have to walk the
// guild's channels, and none of them did: deleted accounts stayed in member_count and in the member
// ids a private thread carries, guild deletion orphaned the rows, and the export omitted them.

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {removeThreadMembershipsForChannels} from '@app/api/channel/services/ThreadPurge';
import {createChannel, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {removeThreadMembershipsInGuild} from '@app/api/user/services/UserDeletionService';
import {collectThreadMemberships} from '@app/api/worker/tasks/HarvestUserData';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
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

describe('thread membership cleanup', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('account deletion leaves the user threads and corrects member_count', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		const thread = await createThread(harness, owner.token, parent.id, 'shared');
		await createBuilder(harness, member.token)
			.put(`/channels/${thread.id}/thread-members/@me`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		const channelRepository = new ChannelRepository();
		const threadMemberRepository = new ThreadMemberRepository();
		const threadId = createChannelID(BigInt(thread.id));
		expect(await threadMemberRepository.listMembers(threadId)).toHaveLength(2);

		await removeThreadMembershipsInGuild({
			guildId: createGuildID(BigInt(guild.id)),
			userId: createUserID(BigInt(member.userId)),
			channelRepository,
		});

		const remaining = await threadMemberRepository.listMembers(threadId);
		expect(remaining.map((entry) => entry.userId.toString())).toEqual([owner.userId]);
		const reloaded = await channelRepository.findUnique(threadId);
		expect(reloaded?.memberCount).toBe(1);
	});

	test('guild deletion takes every thread membership row with it', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		const first = await createThread(harness, owner.token, parent.id, 'one');
		const second = await createThread(harness, owner.token, parent.id, 'two');
		const channelRepository = new ChannelRepository();
		const threadMemberRepository = new ThreadMemberRepository();
		const channels = await channelRepository.listGuildChannels(createGuildID(BigInt(guild.id)));

		await removeThreadMembershipsForChannels(channels, threadMemberRepository);

		expect(await threadMemberRepository.listMembers(createChannelID(BigInt(first.id)))).toEqual([]);
		expect(await threadMemberRepository.listMembers(createChannelID(BigInt(second.id)))).toEqual([]);
	});

	test('the data export lists the threads the user has joined', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		const thread = await createThread(harness, owner.token, parent.id, 'exported');

		const entries = await collectThreadMemberships({
			guildId: createGuildID(BigInt(guild.id)),
			userId: createUserID(BigInt(owner.userId)),
			channelRepository: new ChannelRepository(),
		});

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			threadId: thread.id,
			guildId: guild.id,
			parentId: parent.id,
			name: 'exported',
		});
		expect(typeof entries[0].joinedAt).toBe('string');
	});
});
