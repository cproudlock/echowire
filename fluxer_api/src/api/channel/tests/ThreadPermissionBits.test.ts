// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the thread permission bits, their compatibility with role sets written before those
// bits existed, and the membership routes that make private threads usable.

import {
	addMemberRole,
	createPermissionOverwrite,
	createRole,
	setupTestGuildWithMembers,
	updateRole,
} from '@app/api/channel/tests/ChannelTestUtils';
import {ensureSessionStarted, sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {
	ChannelTypes,
	DEFAULT_PERMISSIONS,
	Permissions,
	THREAD_PERMISSION_BITS,
} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

interface ThreadMemberEntry {
	id: string;
	user_id: string;
	join_timestamp: string;
	flags: number;
}

async function createThread(
	harness: ApiTestHarness,
	token: string,
	parentId: string,
	body: {name: string; type?: number; invitable?: boolean},
	status: number = HTTP_STATUS.CREATED,
): Promise<ChannelResponse> {
	return createBuilder<ChannelResponse>(harness, token)
		.post(`/channels/${parentId}/threads`)
		.body(body)
		.expect(status)
		.execute();
}

// A guild created before the thread bits existed: its @everyone role carries the old default mask.
async function makeGuildLegacy(harness: ApiTestHarness, ownerToken: string, guildId: string): Promise<void> {
	await updateRole(harness, ownerToken, guildId, guildId, {
		permissions: (DEFAULT_PERMISSIONS & ~THREAD_PERMISSION_BITS).toString(),
	});
}

async function setEveryonePermissions(
	harness: ApiTestHarness,
	ownerToken: string,
	guildId: string,
	permissions: bigint,
): Promise<void> {
	await updateRole(harness, ownerToken, guildId, guildId, {permissions: permissions.toString()});
}

async function listThreadMembers(
	harness: ApiTestHarness,
	token: string,
	threadId: string,
): Promise<Array<ThreadMemberEntry>> {
	return createBuilder<Array<ThreadMemberEntry>>(harness, token).get(`/channels/${threadId}/thread-members`).execute();
}

describe('Thread permission bits', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('a role set written before the thread bits still creates threads and posts in them', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		await makeGuildLegacy(harness, owner.token, guild.id);

		const thread = await createThread(harness, member.token, systemChannel.id, {name: 'legacy still works'});
		await sendMessage(harness, member.token, thread.id, 'a reply');
	});

	test('a guild that knows the bits refuses a member who lacks create posts and threads', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		// One thread bit present makes the bits authoritative, and this mask omits CREATE_PUBLIC_THREADS.
		await setEveryonePermissions(
			harness,
			owner.token,
			guild.id,
			(DEFAULT_PERMISSIONS & ~THREAD_PERMISSION_BITS) | Permissions.SEND_MESSAGES_IN_THREADS,
		);

		await createThread(harness, member.token, systemChannel.id, {name: 'refused'}, HTTP_STATUS.FORBIDDEN);
	});

	test('denying send messages in threads stops replies while the parent still takes messages', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		await createPermissionOverwrite(harness, owner.token, systemChannel.id, guild.id, {
			type: 0,
			allow: '0',
			deny: Permissions.SEND_MESSAGES_IN_THREADS.toString(),
		});

		const thread = await createThread(harness, member.token, systemChannel.id, {name: 'no replies here'});
		await sendMessage(harness, member.token, systemChannel.id, 'the parent is fine');
		await ensureSessionStarted(harness, member.token);
		await createBuilder(harness, member.token)
			.post(`/channels/${thread.id}/messages`)
			.body({content: 'blocked'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
	});

	test('a member allowed only in threads posts in the thread but not in the parent', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;
		await createPermissionOverwrite(harness, owner.token, systemChannel.id, guild.id, {
			type: 0,
			allow: Permissions.SEND_MESSAGES_IN_THREADS.toString(),
			deny: Permissions.SEND_MESSAGES.toString(),
		});
		const thread = await createThread(harness, owner.token, systemChannel.id, {name: 'threads only'});

		await sendMessage(harness, member.token, thread.id, 'allowed in here');
		await ensureSessionStarted(harness, member.token);
		await createBuilder(harness, member.token)
			.post(`/channels/${systemChannel.id}/messages`)
			.body({content: 'not out there'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
	});

	test('private threads need their own permission, which is not a default', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 1);
		const [member] = members;

		await createThread(
			harness,
			member.token,
			systemChannel.id,
			{name: 'not allowed', type: ChannelTypes.PRIVATE_THREAD},
			HTTP_STATUS.FORBIDDEN,
		);

		const role = await createRole(harness, owner.token, guild.id, {
			name: 'Private threads',
			permissions: Permissions.CREATE_PRIVATE_THREADS.toString(),
		});
		await addMemberRole(harness, owner.token, guild.id, member.userId, role.id);
		await createThread(harness, member.token, systemChannel.id, {
			name: 'allowed now',
			type: ChannelTypes.PRIVATE_THREAD,
		});
	});

	test('manage threads moderates other members threads without manage channels', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		const [author, moderator] = members;
		const thread = await createThread(harness, author.token, systemChannel.id, {name: 'someone elses'});

		await createBuilder(harness, moderator.token)
			.patch(`/channels/${thread.id}/thread`)
			.body({locked: true})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();

		const role = await createRole(harness, owner.token, guild.id, {
			name: 'Thread mods',
			permissions: Permissions.MANAGE_THREADS.toString(),
		});
		await addMemberRole(harness, owner.token, guild.id, moderator.userId, role.id);
		const locked = await createBuilder<ChannelResponse>(harness, moderator.token)
			.patch(`/channels/${thread.id}/thread`)
			.body({locked: true})
			.execute();
		expect(locked.thread_metadata?.locked).toBe(true);
	});
});

describe('Thread membership routes', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	async function privateThread(memberCount: number, invitable = false) {
		const setup = await setupTestGuildWithMembers(harness, memberCount);
		const role = await createRole(harness, setup.owner.token, setup.guild.id, {
			name: 'Private threads',
			permissions: Permissions.CREATE_PRIVATE_THREADS.toString(),
		});
		await addMemberRole(harness, setup.owner.token, setup.guild.id, setup.members[0]!.userId, role.id);
		const thread = await createThread(harness, setup.members[0]!.token, setup.systemChannel.id, {
			name: 'private',
			type: ChannelTypes.PRIVATE_THREAD,
			invitable,
		});
		return {...setup, thread};
	}

	test('the owner of a private thread adds a member, who can then see it', async () => {
		const {members, thread} = await privateThread(2);
		const [threadOwner, invitee] = members;

		await createBuilder(harness, invitee!.token).get(`/channels/${thread.id}`).expect(HTTP_STATUS.FORBIDDEN).execute();
		await createBuilder(harness, threadOwner!.token)
			.put(`/channels/${thread.id}/thread-members/${invitee!.userId}`)
			.expect(204)
			.execute();

		const channel = await createBuilder<ChannelResponse>(harness, invitee!.token)
			.get(`/channels/${thread.id}`)
			.execute();
		expect(channel.id).toBe(thread.id);
		const roster = await listThreadMembers(harness, threadOwner!.token, thread.id);
		expect(roster.map((entry) => entry.user_id)).toContain(invitee!.userId);
	});

	test('a member of an invitable private thread may add another, and may not when it is not invitable', async () => {
		const invitable = await privateThread(3, true);
		const [threadOwner, helper, newcomer] = invitable.members;
		await createBuilder(harness, threadOwner!.token)
			.put(`/channels/${invitable.thread.id}/thread-members/${helper!.userId}`)
			.expect(204)
			.execute();
		await createBuilder(harness, helper!.token)
			.put(`/channels/${invitable.thread.id}/thread-members/${newcomer!.userId}`)
			.expect(204)
			.execute();

		const closed = await privateThread(3, false);
		const [closedOwner, closedHelper, closedNewcomer] = closed.members;
		await createBuilder(harness, closedOwner!.token)
			.put(`/channels/${closed.thread.id}/thread-members/${closedHelper!.userId}`)
			.expect(204)
			.execute();
		await createBuilder(harness, closedHelper!.token)
			.put(`/channels/${closed.thread.id}/thread-members/${closedNewcomer!.userId}`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
	});

	test('a member who cannot see the parent channel cannot be added', async () => {
		const {owner, members, guild, systemChannel, thread} = await privateThread(2);
		const [threadOwner, outsider] = members;
		await createPermissionOverwrite(harness, owner.token, systemChannel.id, outsider!.userId, {
			type: 1,
			allow: '0',
			deny: Permissions.VIEW_CHANNEL.toString(),
		});
		void guild;

		await createBuilder(harness, threadOwner!.token)
			.put(`/channels/${thread.id}/thread-members/${outsider!.userId}`)
			.expect(HTTP_STATUS.NOT_FOUND)
			.execute();
	});

	test('one member can be fetched, and an absent one is not found', async () => {
		const {members, thread} = await privateThread(2);
		const [threadOwner, invitee] = members;
		const self = await createBuilder<ThreadMemberEntry>(harness, threadOwner!.token)
			.get(`/channels/${thread.id}/thread-members/${threadOwner!.userId}`)
			.execute();
		expect(self.user_id).toBe(threadOwner!.userId);
		expect(self.id).toBe(thread.id);

		await createBuilder(harness, threadOwner!.token)
			.get(`/channels/${thread.id}/thread-members/${invitee!.userId}`)
			.expect(HTTP_STATUS.NOT_FOUND)
			.execute();
	});

	test('a moderator removes a member, who loses access, and a member removes themselves', async () => {
		const {owner, members, thread} = await privateThread(2);
		const [threadOwner, invitee] = members;
		await createBuilder(harness, threadOwner!.token)
			.put(`/channels/${thread.id}/thread-members/${invitee!.userId}`)
			.expect(204)
			.execute();

		await createBuilder(harness, owner.token)
			.delete(`/channels/${thread.id}/thread-members/${invitee!.userId}`)
			.expect(204)
			.execute();
		await createBuilder(harness, invitee!.token).get(`/channels/${thread.id}`).expect(HTTP_STATUS.FORBIDDEN).execute();

		await createBuilder(harness, threadOwner!.token)
			.delete(`/channels/${thread.id}/thread-members/${threadOwner!.userId}`)
			.expect(204)
			.execute();
		const roster = await listThreadMembers(harness, owner.token, thread.id);
		expect(roster.map((entry) => entry.user_id)).not.toContain(threadOwner!.userId);
	});

	test('a non member cannot add anyone to a private thread', async () => {
		const {members, thread} = await privateThread(3);
		const [, bystander, target] = members;
		await createBuilder(harness, bystander!.token)
			.put(`/channels/${thread.id}/thread-members/${target!.userId}`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
	});
});

describe('Thread membership from mentions', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('mentioning a member in a public thread adds them, and in a private thread does not', async () => {
		const {owner, members, guild, systemChannel} = await setupTestGuildWithMembers(harness, 2);
		const [author, mentioned] = members;
		const publicThread = await createThread(harness, author!.token, systemChannel.id, {name: 'public'});
		await sendMessage(harness, author!.token, publicThread.id, `hello <@${mentioned!.userId}>`);
		const publicRoster = await listThreadMembers(harness, owner.token, publicThread.id);
		expect(publicRoster.map((entry) => entry.user_id)).toContain(mentioned!.userId);

		const role = await createRole(harness, owner.token, guild.id, {
			name: 'Private threads',
			permissions: Permissions.CREATE_PRIVATE_THREADS.toString(),
		});
		await addMemberRole(harness, owner.token, guild.id, author!.userId, role.id);
		const secret = await createThread(harness, author!.token, systemChannel.id, {
			name: 'private',
			type: ChannelTypes.PRIVATE_THREAD,
		});
		await sendMessage(harness, author!.token, secret.id, `psst <@${mentioned!.userId}>`);
		const secretRoster = await listThreadMembers(harness, author!.token, secret.id);
		expect(secretRoster.map((entry) => entry.user_id)).not.toContain(mentioned!.userId);
	});
});
