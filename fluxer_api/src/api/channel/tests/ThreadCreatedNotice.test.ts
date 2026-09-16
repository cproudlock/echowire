// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the "started a thread" notice is a system message, and system messages are not
// deletable. That left moderators unable to clear a notice whose thread had already been deleted.
// Moderators can now remove it; the member who started the thread still cannot.

import {
	createChannel,
	createPermissionOverwrite,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {MessageTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

async function threadCreatedNotice(
	harness: ApiTestHarness,
	token: string,
	channelId: string,
): Promise<MessageResponse> {
	const messages = await createBuilder<Array<MessageResponse>>(harness, token)
		.get(`/channels/${channelId}/messages`)
		.execute();
	const notice = messages.find((message) => message.type === MessageTypes.THREAD_CREATED);
	if (!notice) {
		throw new Error('no thread-created notice in the parent channel');
	}
	return notice;
}

describe('thread created notice', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('a moderator can delete the notice but the member who started the thread cannot', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		await createPermissionOverwrite(harness, owner.token, parent.id, guild.id, {
			type: 0,
			allow: (Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.READ_MESSAGE_HISTORY).toString(),
			deny: '0',
		});
		await ensureSessionStarted(harness, member.token);
		await createBuilder<ChannelResponse>(harness, member.token)
			.post(`/channels/${parent.id}/threads`)
			.body({name: 'member thread'})
			.expect(HTTP_STATUS.CREATED)
			.execute();

		const notice = await threadCreatedNotice(harness, owner.token, parent.id);

		await createBuilder(harness, member.token)
			.delete(`/channels/${parent.id}/messages/${notice.id}`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		await createBuilder(harness, owner.token)
			.delete(`/channels/${parent.id}/messages/${notice.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		const remaining = await createBuilder<Array<MessageResponse>>(harness, owner.token)
			.get(`/channels/${parent.id}/messages`)
			.execute();
		expect(remaining.some((message) => message.id === notice.id)).toBe(false);
	});
});
