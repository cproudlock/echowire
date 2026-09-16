// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the session payload carries the caller's thread memberships, read from the by-user
// index. Without them a client had to call GET /guilds/{id}/threads/active per guild just to learn
// which threads it had joined.

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannel, createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

interface RpcSessionResponse {
	type: 'session';
	data: {
		thread_members: Array<{
			id: string;
			guild_id: string | null;
			user_id: string;
			join_timestamp: string;
			flags: number;
		}>;
	};
}

async function sessionPayload(harness: ApiTestHarness, token: string): Promise<RpcSessionResponse> {
	return createBuilder<RpcSessionResponse>(harness, '')
		.post('/test/rpc-session-init')
		.body({type: 'session', token, version: 1, ip: '127.0.0.1'})
		.expect(HTTP_STATUS.OK)
		.execute();
}

describe('RpcService session thread members', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('sends the threads the user has joined, with their guild', async () => {
		const account = await createTestAccount(harness);
		const guild = await createGuild(harness, account.token, 'Thread Member Guild');
		const channel = await createChannel(harness, account.token, guild.id, 'threads-here');
		const thread = await createBuilder<ChannelResponse>(harness, account.token)
			.post(`/channels/${channel.id}/threads`)
			.body({name: 'joined on create'})
			.expect(HTTP_STATUS.CREATED)
			.execute();

		const response = await sessionPayload(harness, account.token);
		const membership = response.data.thread_members.find((entry) => entry.id === thread.id);
		expect(membership).toBeDefined();
		expect(membership?.guild_id).toBe(guild.id);
		expect(membership?.user_id).toBe(account.userId);
	});

	test('sends an empty list for an account that has joined nothing', async () => {
		const account = await createTestAccount(harness);
		const response = await sessionPayload(harness, account.token);
		expect(response.data.thread_members).toEqual([]);
	});

	test('does not send another user thread membership', async () => {
		const owner = await createTestAccount(harness);
		const stranger = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Private Membership Guild');
		const channel = await createChannel(harness, owner.token, guild.id, 'owner-threads');
		const thread = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/channels/${channel.id}/threads`)
			.body({name: 'not yours'})
			.expect(HTTP_STATUS.CREATED)
			.execute();

		const response = await sessionPayload(harness, stranger.token);
		expect(response.data.thread_members.map((entry) => entry.id)).not.toContain(thread.id);
		for (const entry of response.data.thread_members) {
			expect(entry.user_id).toBe(stranger.userId);
		}
	});
});
