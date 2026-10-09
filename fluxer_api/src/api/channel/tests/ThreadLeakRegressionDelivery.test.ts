// SPDX-License-Identifier: AGPL-3.0-or-later

// echowire: port of the September "one path for thread delivery" and visibility contract
// regressions. In upstream's design the api never decides who receives a thread event: it hands
// every event to the guild process of the gateway, with the audience facts in `_fluxer_*` fields
// that the gateway strips from the wire, and the gateway delivers to sessions that can view the
// thread (see guild_thread_dispatch.erl and the eunit tests in fluxer_gateway/test/guild_threads_tests.erl).
//
// What the api can and must guarantee, and what these tests pin:
//   1. thread content only ever leaves the api on the guild-scoped path, never on a user-scoped one;
//   2. every field that names thread members is one the gateway knows to strip or to deliver only
//      to the affected users, so a new audience field cannot be added without the gateway noticing;
//   3. a user who was never in a private thread appears in none of its events.

import {authorizeBot, createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {
	joinGuild,
	post,
	resetChannelThreadsConfig,
	setupLeakWorld,
	startPrivateThread,
	startThread,
} from '@app/api/channel/tests/ThreadLeakRegressionUtils';
import {threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const SECRET = 'tangerine-secret-plans';

// Keys that carry thread audience facts. The gateway strips every `_fluxer_`-prefixed key and
// `member_ids_preview` from what it sends to clients, and delivers the other two only to the users
// they name and to sessions that can view the thread.
const GATEWAY_STRIPPED_KEYS = new Set(['_fluxer_members', '_fluxer_member_ids', '_fluxer_member_ids_preview']);
const GATEWAY_STRIPPED_PREVIEW = 'member_ids_preview';
const GATEWAY_SCOPED_KEYS = new Set(['added_members', 'removed_member_ids']);

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
	if (Array.isArray(value)) {
		for (const entry of value) collectKeys(entry, into);
	} else if (value !== null && typeof value === 'object') {
		for (const [key, entry] of Object.entries(value)) {
			into.add(key);
			collectKeys(entry, into);
		}
	}
	return into;
}

describe('thread leak regression: delivery', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		resetChannelThreadsConfig();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		resetChannelThreadsConfig();
		await harness.shutdown();
	});

	type Dispatched = {event: string; data: Record<string, unknown>};

	function record() {
		const guild: Array<Dispatched> = [];
		const presence: Array<{userId: string; event: string; data: unknown}> = [];
		vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild').mockImplementation(async (params) => {
			guild.push({event: params.event, data: params.data as Record<string, unknown>});
		});
		vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence').mockImplementation(async (params) => {
			presence.push({userId: params.userId.toString(), event: params.event, data: params.data});
		});
		return {guild, presence};
	}

	async function privateThreadLifecycle() {
		const w = await setupLeakWorld(harness);
		const bystander = await joinGuild(harness, w.owner, w.channelId);
		const events = record();
		const thread = await startPrivateThread(harness, w.creator.token, w.channelId, 'hush');
		await post(harness, w.creator.token, thread.id, SECRET);
		await threadsRequest(harness, w.creator.token)
			.put(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
			.expect(204)
			.execute();
		await threadsRequest(harness, w.creator.token)
			.delete(`/channels/${thread.id}/thread-members/${w.outsider.userId}`)
			.expect(204)
			.execute();
		await threadsRequest(harness, w.creator.token).patch(`/channels/${thread.id}`).body({archived: true}).execute();
		await threadsRequest(harness, w.owner.token).delete(`/channels/${thread.id}`).expect(204).execute();
		return {w, bystander, thread, events};
	}

	it('hands thread content to the gateway on the guild-scoped path only', async () => {
		const {thread, events} = await privateThreadLifecycle();

		const messageCreates = events.guild.filter(
			(entry) => entry.event === 'MESSAGE_CREATE' && entry.data.channel_id === thread.id,
		);
		expect(messageCreates.length).toBeGreaterThan(0);
		expect(JSON.stringify(messageCreates)).toContain(SECRET);
		// Nothing about the thread is pushed to a user directly, where no audience check would apply.
		const userScoped = events.presence.filter((entry) => JSON.stringify(entry.data).includes(thread.id));
		expect(userScoped).toEqual([]);
		expect(JSON.stringify(events.presence)).not.toContain(SECRET);
	});

	it('names the audience of a private thread only in fields the gateway strips or scopes', async () => {
		const {w, thread, events} = await privateThreadLifecycle();

		const created = events.guild.find((entry) => entry.event === 'THREAD_CREATE' && entry.data.id === thread.id);
		expect(created?.data.type).toBe(ChannelTypes.PRIVATE_THREAD);
		expect(created).toBeDefined();
		const initial = ((created?.data._fluxer_members ?? []) as Array<{user_id: string}>).map((member) => member.user_id);
		expect(initial).toEqual([w.creator.userId]);

		const memberish = new Set<string>();
		for (const entry of events.guild) {
			for (const key of collectKeys(entry.data)) {
				if (/member/i.test(key)) memberish.add(key);
			}
		}
		const known = new Set([
			...GATEWAY_STRIPPED_KEYS,
			...GATEWAY_SCOPED_KEYS,
			GATEWAY_STRIPPED_PREVIEW,
			'_fluxer_thread',
			'member_count',
			'member',
			'members',
			'user_id',
			'mention_everyone',
			'_fluxer_parent_id',
		]);
		const unknown = [...memberish].filter((key) => !known.has(key));
		expect(unknown, `thread event fields naming members that the gateway does not know: ${unknown.join(', ')}`).toEqual(
			[],
		);

		for (const entry of events.guild) {
			for (const key of collectKeys(entry.data)) {
				if (key.startsWith('_fluxer_') || key.startsWith('__thread_')) continue;
				expect(key.toLowerCase(), `public field ${key} of ${entry.event}`).not.toBe('thread_member_ids');
			}
		}
	});

	it('never puts an internal audience field on an HTTP response', async () => {
		const w = await setupLeakWorld(harness);
		const bot = await createTestBotAccount(harness);
		await authorizeBot(harness, w.owner.token, bot.appId, ['bot'], w.guildId, Permissions.ADMINISTRATOR.toString());
		const botToken = `Bot ${bot.botToken}`;
		const privateThread = await startPrivateThread(harness, w.creator.token, w.channelId);
		const publicThread = await startThread(harness, w.creator.token, w.channelId, {name: 'open'});
		await post(harness, w.creator.token, privateThread.id, SECRET);
		await post(harness, w.creator.token, publicThread.id, SECRET);
		await threadsRequest(harness, w.creator.token)
			.put(`/channels/${privateThread.id}/thread-members/${w.outsider.userId}`)
			.expect(204)
			.execute();
		const forum = await threadsRequest<{id: string}>(harness, w.owner.token)
			.post(`/guilds/${w.guildId}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		const forumPost = await threadsRequest<{id: string}>(harness, w.creator.token)
			.post(`/channels/${forum.id}/threads`)
			.body({name: 'post', message: {content: SECRET}})
			.expect(201)
			.execute();

		const bodies: Array<[string, string]> = [];
		const read = async (token: string, path: string) => {
			const {response, text} = await threadsRequest(harness, token).get(path).executeRaw();
			expect(response.status, path).toBe(200);
			bodies.push([path, text]);
		};
		for (const id of [privateThread.id, publicThread.id, forumPost.id]) {
			await read(w.creator.token, `/channels/${id}`);
			await read(w.creator.token, `/channels/${id}/messages`);
			await read(botToken, `/channels/${id}/thread-members`);
		}
		await read(w.creator.token, `/channels/${w.channelId}/messages`);
		await read(w.creator.token, `/channels/${forum.id}/threads/archived/public`);
		await read(w.creator.token, `/channels/${w.channelId}/users/@me/threads/archived/private`);
		await read(botToken, `/guilds/${w.guildId}/threads/active`);
		await threadsRequest(harness, w.creator.token)
			.patch(`/channels/${privateThread.id}`)
			.body({name: 'renamed'})
			.execute()
			.then((body) => bodies.push(['PATCH thread', JSON.stringify(body)]));

		expect(bodies.length).toBeGreaterThan(8);
		for (const [path, text] of bodies) {
			expect(text, path).not.toMatch(/"_fluxer_|"__thread_|thread_member_ids/);
		}
		// Forum posts carry a member preview for their cards; ordinary threads never do.
		for (const [path, text] of bodies) {
			if (path.includes(privateThread.id) || path.includes(publicThread.id)) {
				expect(text, path).not.toContain('member_ids_preview');
			}
		}
	});

	it('names every former member in the delete event so the gateway can still reach them', async () => {
		const {thread, events, w} = await privateThreadLifecycle();

		const deleted = events.guild.find((entry) => entry.event === 'THREAD_DELETE' && entry.data.id === thread.id);
		expect(deleted).toBeDefined();
		expect(deleted?.data._fluxer_member_ids).toEqual([w.creator.userId]);
	});

	it('never mentions a user who was not in the private thread, and sends them nothing directly', async () => {
		const {bystander, thread, events, w} = await privateThreadLifecycle();

		const aboutThread = events.guild.filter((entry) => JSON.stringify(entry.data).includes(thread.id));
		expect(aboutThread.length).toBeGreaterThan(0);
		expect(JSON.stringify(aboutThread)).not.toContain(bystander.userId);
		expect(events.presence.filter((entry) => entry.userId === bystander.userId)).toEqual([]);
		// The member who was added and then removed is named only by the events that carry the change.
		const naming = aboutThread.filter((entry) => JSON.stringify(entry.data).includes(w.outsider.userId));
		expect(naming.map((entry) => entry.event).sort()).toEqual(expect.arrayContaining(['THREAD_MEMBERS_UPDATE']));
		for (const entry of naming) {
			expect(['THREAD_MEMBERS_UPDATE', 'MESSAGE_CREATE', 'THREAD_UPDATE', 'THREAD_CREATE']).toContain(entry.event);
		}
	});
});
