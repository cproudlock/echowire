// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: port of the September ThreadDeletePurge, ThreadMembershipCleanup and orphan/age-gate
// regressions onto upstream's thread implementation. A thread must never outlive what its access
// depends on: deleting the thread, its parent, the guild, or the user's guild membership has to
// remove the content, the membership rows and the ability to read it.

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {
	acceptInvite,
	createChannel,
	createChannelInvite,
	createGuild,
	leaveGuild,
	updateChannel,
} from '@app/api/channel/tests/ChannelTestUtils';
import {
	hideChannelFromEveryone,
	post,
	resetChannelThreadsConfig,
	setupLeakWorld,
	startPrivateThread,
	startThread,
	statusOf,
} from '@app/api/channel/tests/ThreadLeakRegressionUtils';
import {ALL_THREADS_ACTIVE, setChannelThreadsConfig, threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getChannelRepository,
	getGuildRepository,
	getInstanceConfigRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {
	deleteChannelThreads,
	removeThreadMembershipsForGuildMember,
} from '@app/api/worker/tasks/ThreadMaintenanceTasks';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const SECRET = 'tangerine-secret-plans';

function helpers(): WorkerTaskHelpers {
	return {
		logger: new NoopLogger(),
		jobId: 1n,
		addJob: async () => 0n,
		reportProgress: async () => {},
		shouldCancel: async () => false,
		setContextLink: async () => {},
	};
}

describe('thread leak regression: lifecycle', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		resetChannelThreadsConfig();
		setWorkerDependenciesForTest({
			kvClient: getKVClient(),
			channelRepository: getChannelRepository(),
			guildRepository: getGuildRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			gatewayService: {
				dispatchGuild: vi.fn(async () => {}),
				dispatchGuildMany: vi.fn(async () => {}),
			} as unknown as IGatewayService,
			channelService: {
				attachments: {purgeChannelAttachments: vi.fn(async () => {})},
			} as unknown as WorkerDependencies['channelService'],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		clearWorkerDependencies();
		resetChannelThreadsConfig();
		await harness.shutdown();
	});

	const threads = () => getChannelRepository().threads;

	async function memberRowCount(threadId: string): Promise<number> {
		return (await threads().listMembers(createChannelID(BigInt(threadId)), {limit: 100})).length;
	}

	it('deleting a thread removes its messages, state and memberships, not just the channel row', async () => {
		const w = await setupLeakWorld(harness);
		const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
		await threadsRequest(harness, w.creator.token)
			.put(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
			.expect(204)
			.execute();
		await post(harness, w.creator.token, thread.id, SECRET);
		await post(harness, w.outsider.token, thread.id, 'second');
		const threadId = createChannelID(BigInt(thread.id));
		// Two posts and the system message that announces the added member.
		expect((await getChannelRepository().messages.listMessages(threadId, undefined, 50)).length).toBeGreaterThanOrEqual(
			2,
		);
		expect(await memberRowCount(thread.id)).toBe(2);

		await threadsRequest(harness, w.owner.token).delete(`/channels/${thread.id}`).expect(204).execute();

		expect(await getChannelRepository().messages.listMessages(threadId, undefined, 50)).toEqual([]);
		expect(await getChannelRepository().findUnique(threadId)).toBeNull();
		expect(await threads().getState(threadId)).toBeNull();
		expect(await memberRowCount(thread.id)).toBe(0);
		for (const account of [w.creator, w.outsider, w.owner]) {
			const read = await statusOf(harness, account.token, 'get', `/channels/${thread.id}/messages`);
			expect(read.status).toBeGreaterThanOrEqual(400);
			expect(read.text).not.toContain(SECRET);
		}
	});

	it('deleting a parent takes its threads, private ones included, with it', async () => {
		const w = await setupLeakWorld(harness);
		const staff = await createChannel(harness, w.owner.token, w.guildId, 'staff');
		const publicThread = await startThread(harness, w.owner.token, staff.id, {name: 'open'});
		const privateThread = await startPrivateThread(harness, w.owner.token, staff.id);
		await post(harness, w.owner.token, privateThread.id, SECRET);
		await hideChannelFromEveryone(harness, w.owner.token, w.guildId, staff.id);

		await threadsRequest(harness, w.owner.token).delete(`/channels/${staff.id}`).expect(204).execute();
		// The sweep that the parent delete queues for a tainted guild.
		await deleteChannelThreads({guildId: w.guildId, parentId: staff.id}, helpers());

		for (const thread of [publicThread, privateThread]) {
			const threadId = createChannelID(BigInt(thread.id));
			expect(await threads().getState(threadId)).toBeNull();
			expect(await getChannelRepository().findUnique(threadId)).toBeNull();
			expect(await getChannelRepository().messages.listMessages(threadId, undefined, 50)).toEqual([]);
			expect(await memberRowCount(thread.id)).toBe(0);
		}
	});

	it('a thread whose parent row is missing is inaccessible to everyone', async () => {
		const w = await setupLeakWorld(harness);
		const staff = await createChannel(harness, w.owner.token, w.guildId, 'staff');
		await hideChannelFromEveryone(harness, w.owner.token, w.guildId, staff.id);
		const thread = await startThread(harness, w.owner.token, staff.id, {name: 'left behind'});
		await post(harness, w.owner.token, thread.id, SECRET);

		// An orphan written before parent deletion purged its threads.
		await new ChannelDataRepository().delete(createChannelID(BigInt(staff.id)), createGuildID(BigInt(w.guildId)));

		for (const account of [w.outsider, w.owner]) {
			const read = await statusOf(harness, account.token, 'get', `/channels/${thread.id}/messages`);
			expect(read.status).toBeGreaterThanOrEqual(400);
			expect(read.text).not.toContain(SECRET);
			const channel = await statusOf(harness, account.token, 'get', `/channels/${thread.id}`);
			expect(channel.status).toBeGreaterThanOrEqual(400);
		}
	});

	it('deleting the guild removes every thread, state and membership row', async () => {
		const owner = await createTestAccount(harness);
		await setChannelThreadsConfig(ALL_THREADS_ACTIVE);
		const guild = await createGuild(harness, owner.token, 'doomed');
		const parent = await createChannel(harness, owner.token, guild.id, 'general');
		const first = await startThread(harness, owner.token, parent.id, {name: 'one'});
		const second = await startPrivateThread(harness, owner.token, parent.id);
		await post(harness, owner.token, second.id, SECRET);
		expect(await memberRowCount(first.id)).toBe(1);

		await createBuilder(harness, owner.token)
			.post(`/guilds/${guild.id}/delete`)
			.body({password: owner.password})
			.expect(204)
			.execute();

		for (const thread of [first, second]) {
			const threadId = createChannelID(BigInt(thread.id));
			expect(await threads().getState(threadId)).toBeNull();
			expect(await memberRowCount(thread.id)).toBe(0);
			expect(await getChannelRepository().messages.listMessages(threadId, undefined, 50)).toEqual([]);
		}
	});

	describe('a user who leaves the guild', () => {
		async function worldWithMember() {
			const w = await setupLeakWorld(harness);
			const thread = await startPrivateThread(harness, w.creator.token, w.channelId);
			await threadsRequest(harness, w.creator.token)
				.put(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
				.expect(204)
				.execute();
			await post(harness, w.creator.token, thread.id, SECRET);
			return {w, thread};
		}

		const memberOf = (threadId: string, userId: string) =>
			threads().getMember(createChannelID(BigInt(threadId)), createUserID(BigInt(userId)));

		it('queues the membership cleanup, which then removes them and keeps the thread closed on a later rejoin', async () => {
			const {w, thread} = await worldWithMember();
			const addJob = vi.spyOn(getWorkerService(), 'addJob');
			await leaveGuild(harness, w.outsider.token, w.guildId);
			expect(addJob).toHaveBeenCalledWith(
				'removeThreadMembershipsForGuildMember',
				{guildId: w.guildId, userId: w.outsider.userId},
				expect.anything(),
			);

			await removeThreadMembershipsForGuildMember({guildId: w.guildId, userId: w.outsider.userId}, helpers());

			expect(await memberOf(thread.id, w.outsider.userId)).toBeNull();
			const state = await threads().getState(createChannelID(BigInt(thread.id)));
			expect(state?.memberCount).toBe(1);
			const invite = await createChannelInvite(harness, w.owner.token, w.channelId);
			await acceptInvite(harness, w.outsider.token, invite.code);
			const read = await statusOf(harness, w.outsider.token, 'get', `/channels/${thread.id}/messages`);
			expect(read.status).toBeGreaterThanOrEqual(400);
			expect(read.text).not.toContain(SECRET);
		});

		it('cannot read the thread while out of the guild, whatever the cleanup state', async () => {
			const {w, thread} = await worldWithMember();
			await leaveGuild(harness, w.outsider.token, w.guildId);
			// The cleanup has not run, so the membership row is still there.
			expect(await memberOf(thread.id, w.outsider.userId)).not.toBeNull();
			for (const path of [`/channels/${thread.id}`, `/channels/${thread.id}/messages`]) {
				const result = await statusOf(harness, w.outsider.token, 'get', path);
				expect(result.status, path).toBeGreaterThanOrEqual(400);
				expect(result.text).not.toContain(SECRET);
			}
			const send = await statusOf(harness, w.outsider.token, 'post', `/channels/${thread.id}/messages`, {
				content: 'from outside',
			});
			expect(send.status).toBeGreaterThanOrEqual(400);
		});

		it('keeps the membership when they rejoin before the cleanup runs, which upstream does on purpose', async () => {
			const {w, thread} = await worldWithMember();
			await leaveGuild(harness, w.outsider.token, w.guildId);
			const invite = await createChannelInvite(harness, w.owner.token, w.channelId);
			await acceptInvite(harness, w.outsider.token, invite.code);

			await removeThreadMembershipsForGuildMember({guildId: w.guildId, userId: w.outsider.userId}, helpers());

			expect(await memberOf(thread.id, w.outsider.userId)).not.toBeNull();
		});
	});

	describe('the age gate of a thread follows its parent at check time', () => {
		it('gates a thread when the parent or its category becomes nsfw after the thread exists', async () => {
			await setChannelThreadsConfig(ALL_THREADS_ACTIVE);
			const minor = await createTestAccount(harness, {dateOfBirth: '2010-01-01'});
			const guild = await createGuild(harness, minor.token, 'age gate');
			const category = await createChannel(harness, minor.token, guild.id, 'after dark', ChannelTypes.GUILD_CATEGORY);
			const text = await createBuilder<{id: string}>(harness, minor.token)
				.post(`/guilds/${guild.id}/channels`)
				.body({name: 'lounge', type: ChannelTypes.GUILD_TEXT, parent_id: category.id})
				.execute();
			const inCategory = await startThread(harness, minor.token, text.id, {name: 'under the category'});
			const plain = await createChannel(harness, minor.token, guild.id, 'plain');
			const underPlain = await startThread(harness, minor.token, plain.id, {name: 'under a later nsfw parent'});
			expect((await statusOf(harness, minor.token, 'get', `/channels/${inCategory.id}/messages`)).status).toBe(200);
			expect((await statusOf(harness, minor.token, 'get', `/channels/${underPlain.id}/messages`)).status).toBe(200);

			await updateChannel(harness, minor.token, category.id, {nsfw: true});
			await updateChannel(harness, minor.token, plain.id, {nsfw: true});

			const status = async (channelId: string) =>
				(await statusOf(harness, minor.token, 'get', `/channels/${channelId}/messages`)).status;
			expect(await status(plain.id)).toBe(403);
			expect(await status(underPlain.id)).toBe(403);
			expect(await status(inCategory.id)).toBe(await status(text.id));
		});
	});
});
