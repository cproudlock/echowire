// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: regressions from the review of the thread access-control hotfix. Threads must never
// outlive their parent channel, private threads must not announce themselves in the parent, and
// the create-from-message path must not reveal which messages carry a private thread.

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {
	createChannel,
	createPermissionOverwrite,
	deleteChannel,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {isOrphanedThread} from '@app/api/worker/tasks/PurgeOrphanedThreads';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
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
