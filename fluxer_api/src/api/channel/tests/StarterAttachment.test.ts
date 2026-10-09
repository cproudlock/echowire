// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: "add to post", POST /channels/{id}/starter-message/attachments. Not in upstream; the
// contract is docs/forums2-contract.md section 2 and the carry decision is docs/upstream-divergence.md.

import {AttachmentDecayService} from '@app/api/attachment/AttachmentDecayService';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createMultipartFormData, loadFixture} from '@app/api/channel/tests/AttachmentTestUtils';
import {acceptInvite, createChannel, createChannelInvite, createGuild} from '@app/api/channel/tests/ChannelTestUtils';
import {
	ALL_THREADS_ACTIVE,
	resetChannelThreadsConfig,
	setChannelThreadsConfig,
	THREADS_FEATURE,
	THREADS_FEATURE_HEADER,
	threadsRequest,
} from '@app/api/channel/tests/ThreadTestUtils';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MAX_ATTACHMENTS_PER_MESSAGE} from '@fluxer/constants/src/LimitConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {
	StartForumThreadResponse,
	ThreadPostDataResponse,
} from '@fluxer/schema/src/domains/channel/ForumRequestSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

interface World {
	owner: TestAccount;
	poster: TestAccount;
	bystander: TestAccount;
	guildId: string;
	generalId: string;
	forumId: string;
	post: StartForumThreadResponse;
}

interface Dispatch {
	event: string;
	data: Record<string, unknown>;
}

interface ValidationBody {
	code: string;
	errors: Array<{path: string; code: string}>;
}

interface DecayLookup {
	row: {message_id: string; channel_id: string} | null;
}

describe('add to post', () => {
	let harness: ApiTestHarness;
	let dispatches: Array<Dispatch> = [];
	let presenceDispatches = 0;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		resetChannelThreadsConfig();
		dispatches = [];
		presenceDispatches = 0;
		vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild').mockImplementation(async (params) => {
			dispatches.push({event: params.event, data: params.data as Record<string, unknown>});
		});
		vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence').mockImplementation(async () => {
			presenceDispatches += 1;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		resetChannelThreadsConfig();
		await harness.shutdown();
	});

	function clearDispatches(): void {
		dispatches = [];
		presenceDispatches = 0;
	}

	async function join(owner: TestAccount, channelId: string): Promise<TestAccount> {
		const account = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, owner.token, channelId);
		await acceptInvite(harness, account.token, invite.code);
		await ensureSessionStarted(harness, account.token);
		return account;
	}

	// Multipart with the thread capability header, which sendMessageWithAttachments does not send.
	async function multipart(
		token: string,
		path: string,
		payload: Record<string, unknown>,
		filenames: Array<string>,
		status: number,
	): Promise<Response> {
		const {body, contentType} = createMultipartFormData(
			payload,
			filenames.map((filename, index) => ({index, filename, data: loadFixture('yeah.png')})),
		);
		const response = await harness.app.request(path, {
			method: 'POST',
			headers: {
				Authorization: token,
				[THREADS_FEATURE_HEADER]: THREADS_FEATURE,
				'Content-Type': contentType,
				'x-forwarded-for': '127.0.0.1',
			},
			body,
		});
		expect(response.status).toBe(status);
		return response;
	}

	async function reply(token: string, channelId: string, filenames: Array<string>): Promise<MessageResponse> {
		const response = await multipart(
			token,
			`/channels/${channelId}/messages`,
			{content: 'media', attachments: filenames.map((filename, id) => ({id, filename}))},
			filenames,
			200,
		);
		return (await response.json()) as MessageResponse;
	}

	async function startPost(
		token: string,
		forumId: string,
		starterFiles: Array<string> = [],
	): Promise<StartForumThreadResponse> {
		const response = await multipart(
			token,
			`/channels/${forumId}/threads`,
			{
				name: 'post',
				message: {content: 'first', attachments: starterFiles.map((filename, id) => ({id, filename}))},
			},
			starterFiles,
			201,
		);
		return (await response.json()) as StartForumThreadResponse;
	}

	async function setup(starterFiles: Array<string> = []): Promise<World> {
		await setChannelThreadsConfig(ALL_THREADS_ACTIVE);
		const owner = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		const guild = await createGuild(harness, owner.token, 'add to post');
		const general = await createChannel(harness, owner.token, guild.id, 'general');
		const poster = await join(owner, general.id);
		const bystander = await join(owner, general.id);
		const forum = await threadsRequest<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		const post = await startPost(poster.token, forum.id, starterFiles);
		clearDispatches();
		return {owner, poster, bystander, guildId: guild.id, generalId: general.id, forumId: forum.id, post};
	}

	function add(
		token: string,
		postId: string,
		messageId: string,
		attachmentId: string,
		options: {capable?: boolean} = {},
	) {
		return threadsRequest<MessageResponse>(harness, token, options)
			.post(`/channels/${postId}/starter-message/attachments`)
			.body({message_id: messageId, attachment_id: attachmentId});
	}

	async function firstMessage(token: string, forumId: string, postId: string): Promise<MessageResponse | null> {
		const data = await threadsRequest<ThreadPostDataResponse>(harness, token)
			.post(`/channels/${forumId}/post-data`)
			.body({thread_ids: [postId]})
			.execute();
		return data.threads[postId]?.first_message ?? null;
	}

	function validationError(result: {response: Response; json: unknown}): ValidationBody {
		expect(result.response.status).toBe(400);
		return result.json as ValidationBody;
	}

	function postEvents(world: World, event: string): Array<Dispatch> {
		return dispatches.filter((dispatch) => dispatch.event === event && dispatch.data['id'] === world.post.id);
	}

	describe('success', () => {
		it('appends a reply attachment to the first message and returns it', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			const attachmentId = media.attachments![0]!.id;
			clearDispatches();

			const updated = await add(world.poster.token, world.post.id, media.id, attachmentId).execute();
			expect(updated.id).toBe(world.post.id);
			expect(updated.channel_id).toBe(world.post.id);
			expect(updated.content).toBe('first');
			expect(updated.attachments?.map((attachment) => attachment.id)).toEqual([attachmentId]);
			expect(updated.attachments?.[0]?.filename).toBe('one.png');

			const stored = await firstMessage(world.poster.token, world.forumId, world.post.id);
			expect(stored?.attachments?.map((attachment) => attachment.id)).toEqual([attachmentId]);
			const replyAfter = await threadsRequest<MessageResponse>(harness, world.poster.token)
				.get(`/channels/${world.post.id}/messages/${media.id}`)
				.execute();
			expect(replyAfter.attachments?.map((attachment) => attachment.id)).toEqual([attachmentId]);
		});

		it('dispatches the message update, and a thread update only when the card gains a thumbnail', async () => {
			const world = await setup();
			const first = await reply(world.poster.token, world.post.id, ['one.png']);
			const second = await reply(world.poster.token, world.post.id, ['two.png']);
			clearDispatches();

			await add(world.poster.token, world.post.id, first.id, first.attachments![0]!.id).execute();
			expect(postEvents(world, 'MESSAGE_UPDATE')).toHaveLength(1);
			expect(postEvents(world, 'THREAD_UPDATE')).toHaveLength(1);

			clearDispatches();
			const updated = await add(world.poster.token, world.post.id, second.id, second.attachments![0]!.id).execute();
			expect(updated.attachments?.map((attachment) => attachment.filename)).toEqual(['one.png', 'two.png']);
			expect(postEvents(world, 'MESSAGE_UPDATE')).toHaveLength(1);
			expect(postEvents(world, 'THREAD_UPDATE')).toHaveLength(0);
			expect(presenceDispatches).toBe(0);
		});

		it('re-points the attachment decay record at the first message', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			const attachmentId = media.attachments![0]!.id;
			// Reading a message also renews the decay record of its attachments and names the message
			// being read as the owner. Switch that off so only the route's own re-pointing is measured.
			vi.spyOn(AttachmentDecayService.prototype, 'extendForAttachments').mockResolvedValue();
			const lookup = () =>
				createBuilderWithoutAuth<DecayLookup>(harness).get(`/test/attachment-decay/${attachmentId}`).execute();
			const before = await lookup();
			expect(before.row?.message_id).toBe(media.id);

			await add(world.poster.token, world.post.id, media.id, attachmentId).execute();
			const after = await lookup();
			expect(after.row?.message_id).toBe(world.post.id);
			expect(after.row?.channel_id).toBe(world.post.id);
		});

		it('lets a moderator add to a post they do not own', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			const updated = await add(world.owner.token, world.post.id, media.id, media.attachments![0]!.id).execute();
			expect(updated.attachments).toHaveLength(1);
		});
	});

	describe('refusals', () => {
		it('rejects an attachment that is already on the first message', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			const attachmentId = media.attachments![0]!.id;
			await add(world.poster.token, world.post.id, media.id, attachmentId).execute();
			clearDispatches();

			const body = validationError(await add(world.poster.token, world.post.id, media.id, attachmentId).executeRaw());
			expect(body.code).toBe(APIErrorCodes.INVALID_FORM_BODY);
			expect(body.errors).toEqual([
				expect.objectContaining({path: 'attachment_id', code: ValidationErrorCodes.STARTER_ATTACHMENT_ALREADY_PRESENT}),
			]);
			expect(dispatches).toEqual([]);
			const stored = await firstMessage(world.poster.token, world.forumId, world.post.id);
			expect(stored?.attachments).toHaveLength(1);
		});

		it('rejects an attachment once the first message is at its attachment limit', async () => {
			const full = Array.from({length: MAX_ATTACHMENTS_PER_MESSAGE}, (_, index) => `full-${index}.png`);
			const world = await setup(full);
			const media = await reply(world.poster.token, world.post.id, ['extra.png']);
			clearDispatches();

			const body = validationError(
				await add(world.poster.token, world.post.id, media.id, media.attachments![0]!.id).executeRaw(),
			);
			expect(body.errors).toEqual([
				expect.objectContaining({path: 'attachment_id', code: ValidationErrorCodes.STARTER_ATTACHMENT_LIMIT_REACHED}),
			]);
			expect(dispatches).toEqual([]);
			const stored = await firstMessage(world.poster.token, world.forumId, world.post.id);
			expect(stored?.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
		});

		it('rejects the first message of the post as the source', async () => {
			const world = await setup(['starter.png']);
			const starterAttachment = world.post.message!.attachments![0]!.id;

			const body = validationError(
				await add(world.poster.token, world.post.id, world.post.id, starterAttachment).executeRaw(),
			);
			expect(body.errors).toEqual([
				expect.objectContaining({path: 'message_id', code: ValidationErrorCodes.STARTER_ATTACHMENT_SOURCE_INVALID}),
			]);
			expect(dispatches).toEqual([]);
		});

		it('refuses a member who neither owns the post nor moderates threads, and changes nothing', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			const attachmentId = media.attachments![0]!.id;
			clearDispatches();

			await add(world.bystander.token, world.post.id, media.id, attachmentId)
				.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
				.execute();
			expect(dispatches).toEqual([]);
			const stored = await firstMessage(world.poster.token, world.forumId, world.post.id);
			expect(stored?.attachments ?? []).toEqual([]);
		});

		it('does not find a message that is not in the post, or an attachment it does not carry', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			const other = await reply(world.poster.token, world.post.id, ['two.png']);
			const elsewhere = await threadsRequest<MessageResponse>(harness, world.owner.token)
				.post(`/channels/${world.generalId}/messages`)
				.body({content: 'not in the post'})
				.execute();
			const attachmentId = media.attachments![0]!.id;
			clearDispatches();

			await add(world.poster.token, world.post.id, elsewhere.id, attachmentId)
				.expect(404, APIErrorCodes.UNKNOWN_MESSAGE)
				.execute();
			await add(world.poster.token, world.post.id, other.id, attachmentId)
				.expect(404, APIErrorCodes.UNKNOWN_MESSAGE)
				.execute();
			await add(world.poster.token, world.post.id, '123456789012345678', attachmentId)
				.expect(404, APIErrorCodes.UNKNOWN_MESSAGE)
				.execute();
			expect(dispatches).toEqual([]);
			const stored = await firstMessage(world.poster.token, world.forumId, world.post.id);
			expect(stored?.attachments ?? []).toEqual([]);
		});

		it('refuses a post that is archived', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			await threadsRequest(harness, world.owner.token)
				.patch(`/channels/${world.post.id}`)
				.body({archived: true})
				.execute();
			clearDispatches();

			await add(world.poster.token, world.post.id, media.id, media.attachments![0]!.id)
				.expect(400, APIErrorCodes.THREAD_ARCHIVED)
				.execute();
			expect(dispatches).toEqual([]);
		});
	});

	describe('channel types', () => {
		it('refuses a thread whose parent is not a forum or media channel', async () => {
			const world = await setup();
			const thread = await threadsRequest<ChannelResponse>(harness, world.owner.token)
				.post(`/channels/${world.generalId}/threads`)
				.body({name: 'topic', type: ChannelTypes.PUBLIC_THREAD})
				.expect(201)
				.execute();
			const media = await reply(world.owner.token, thread.id, ['one.png']);

			await add(world.owner.token, thread.id, media.id, media.attachments![0]!.id)
				.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
				.execute();
		});

		it('refuses a plain text channel', async () => {
			const world = await setup();
			const media = await reply(world.owner.token, world.generalId, ['one.png']);

			await add(world.owner.token, world.generalId, media.id, media.attachments![0]!.id)
				.expect(404, APIErrorCodes.UNKNOWN_CHANNEL)
				.execute();
		});
	});

	describe('visibility', () => {
		it('answers 404 to a caller without the thread capability, and changes nothing', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			clearDispatches();

			await add(world.poster.token, world.post.id, media.id, media.attachments![0]!.id, {capable: false})
				.expect(404)
				.execute();
			expect(dispatches).toEqual([]);
			const stored = await firstMessage(world.poster.token, world.forumId, world.post.id);
			expect(stored?.attachments ?? []).toEqual([]);
		});

		it('tells a member who cannot see the forum nothing about the post, even as its owner', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			const attachmentId = media.attachments![0]!.id;
			await threadsRequest(harness, world.owner.token)
				.put(`/channels/${world.forumId}/permissions/${world.poster.userId}`)
				.body({type: 1, allow: '0', deny: Permissions.VIEW_CHANNEL.toString()})
				.expect(204)
				.execute();
			clearDispatches();

			const {response, text} = await add(world.poster.token, world.post.id, media.id, attachmentId).executeRaw();
			expect([403, 404]).toContain(response.status);
			expect(text).not.toContain('one.png');
			expect(text).not.toContain(attachmentId);
			expect(dispatches).toEqual([]);
			expect(presenceDispatches).toBe(0);
			const stored = await firstMessage(world.owner.token, world.forumId, world.post.id);
			expect(stored?.attachments ?? []).toEqual([]);
		});

		it('delivers its events on the guild path only', async () => {
			const world = await setup();
			const media = await reply(world.poster.token, world.post.id, ['one.png']);
			clearDispatches();

			await add(world.poster.token, world.post.id, media.id, media.attachments![0]!.id).execute();
			expect(dispatches.map((dispatch) => dispatch.event).sort()).toEqual(['MESSAGE_UPDATE', 'THREAD_UPDATE']);
			expect(presenceDispatches).toBe(0);
		});
	});
});
