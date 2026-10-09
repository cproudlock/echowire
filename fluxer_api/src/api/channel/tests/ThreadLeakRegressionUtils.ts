// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: shared fixtures for the thread leak regression tests. They port the September fork
// regression tests (thread access review, visibility contract, delivery path) onto upstream's
// thread implementation, so every helper goes through the real HTTP routes with the thread
// capability header and an experiment config that enrols everyone.

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {
	acceptInvite,
	createChannel,
	createChannelInvite,
	createGuild,
	createPermissionOverwrite,
	createRole,
} from '@app/api/channel/tests/ChannelTestUtils';
import {
	ALL_THREADS_ACTIVE,
	resetChannelThreadsConfig,
	setChannelThreadsConfig,
	threadsRequest,
} from '@app/api/channel/tests/ThreadTestUtils';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ThreadPermissionFlags} from '@fluxer/constants/src/ThreadPermissionUtils';
import type {ThreadChannelResponse} from '@fluxer/schema/src/domains/channel/ThreadRequestSchemas';
import type {GuildRoleResponse} from '@fluxer/schema/src/domains/guild/GuildRoleSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';

export {resetChannelThreadsConfig};

export interface LeakWorld {
	owner: TestAccount;
	creator: TestAccount;
	outsider: TestAccount;
	guildId: string;
	channelId: string;
}

// Plain members may start private threads here. The owner holds every permission, so tests that
// need a viewer without MANAGE_THREADS use the creator and the outsider, never the owner.
const MEMBER_PERMISSIONS =
	Permissions.VIEW_CHANNEL |
	Permissions.SEND_MESSAGES |
	Permissions.READ_MESSAGE_HISTORY |
	ThreadPermissionFlags.CREATE_PUBLIC_THREADS |
	ThreadPermissionFlags.CREATE_PRIVATE_THREADS |
	ThreadPermissionFlags.SEND_MESSAGES_IN_THREADS;

export async function joinGuild(harness: ApiTestHarness, owner: TestAccount, channelId: string): Promise<TestAccount> {
	const account = await createTestAccount(harness);
	const invite = await createChannelInvite(harness, owner.token, channelId);
	await acceptInvite(harness, account.token, invite.code);
	await ensureSessionStarted(harness, account.token);
	return account;
}

export async function setupLeakWorld(harness: ApiTestHarness): Promise<LeakWorld> {
	await setChannelThreadsConfig(ALL_THREADS_ACTIVE);
	const owner = await createTestAccount(harness);
	const guild = await createGuild(harness, owner.token, 'leak regression');
	const channel = await createChannel(harness, owner.token, guild.id, 'general');
	await threadsRequest(harness, owner.token)
		.patch(`/guilds/${guild.id}/roles/${guild.id}`)
		.body({permissions: MEMBER_PERMISSIONS.toString()})
		.execute();
	await ensureSessionStarted(harness, owner.token);
	const creator = await joinGuild(harness, owner, channel.id);
	const outsider = await joinGuild(harness, owner, channel.id);
	return {owner, creator, outsider, guildId: guild.id, channelId: channel.id};
}

export async function startThread(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	options: {name?: string; type?: number} = {},
): Promise<ThreadChannelResponse> {
	return threadsRequest<ThreadChannelResponse>(harness, token)
		.post(`/channels/${parentId}/threads`)
		.body({name: options.name ?? 'topic', type: options.type ?? ChannelTypes.PUBLIC_THREAD})
		.expect(201)
		.execute();
}

export async function startPrivateThread(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	name = 'private topic',
): Promise<ThreadChannelResponse> {
	return startThread(harness, token, parentId, {name, type: ChannelTypes.PRIVATE_THREAD});
}

export async function post(
	harness: ApiTestHarness,
	token: string,
	channelId: string,
	content: string,
): Promise<MessageResponse> {
	return threadsRequest<MessageResponse>(harness, token)
		.post(`/channels/${channelId}/messages`)
		.body({content})
		.expect(200)
		.execute();
}

export async function hideChannelFromEveryone(
	harness: ApiTestHarness,
	token: string,
	guildId: string,
	channelId: string,
): Promise<void> {
	await createPermissionOverwrite(harness, token, channelId, guildId, {
		type: 0,
		allow: '0',
		deny: Permissions.VIEW_CHANNEL.toString(),
	});
}

export async function createViewRole(
	harness: ApiTestHarness,
	token: string,
	guildId: string,
	channelId: string,
	name: string,
): Promise<GuildRoleResponse> {
	const role = await createRole(harness, token, guildId, {name});
	await createPermissionOverwrite(harness, token, channelId, role.id, {
		type: 0,
		allow: Permissions.VIEW_CHANNEL.toString(),
		deny: '0',
	});
	return role;
}

// The status of a request whatever it is, for asserting that a route refuses without caring about
// which of the refusal codes (403 or 404) upstream chose for it.
export async function statusOf(
	harness: ApiTestHarness,
	token: string,
	method: 'get' | 'post' | 'put' | 'patch' | 'delete',
	path: string,
	body?: unknown,
): Promise<{status: number; text: string}> {
	let builder = threadsRequest(harness, token);
	builder = builder[method](path) as typeof builder;
	if (body !== undefined) builder = builder.body(body) as typeof builder;
	const {response, text} = await builder.executeRaw();
	return {status: response.status, text};
}
