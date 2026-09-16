// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: three contract details around threads. A forum that requires a tag has to refuse a
// post whose tags are cleared on update, not only on create; the thread member response carries
// the thread id like the self response does; and thread_member_ids is gateway-internal and must
// never appear on an HTTP response or in the published schema.

import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import type {ThreadMemberListResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {ChannelResponse, ThreadMemberResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

describe('thread contract details', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});

	test('a post in a tag-required forum cannot have its tags cleared', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const forum = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({
				name: 'forum',
				type: ChannelTypes.GUILD_FORUM,
				available_tags: [{name: 'help'}],
				require_tag: true,
			})
			.execute();
		const tagId = forum.available_tags?.[0]?.id;
		expect(tagId).toBeTruthy();
		const post = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/channels/${forum.id}/threads`)
			.body({name: 'tagged post', applied_tags: [tagId]})
			.expect(HTTP_STATUS.CREATED)
			.execute();
		expect(post.applied_tags).toEqual([tagId]);

		const {response, text} = await createBuilder(harness, owner.token)
			.patch(`/channels/${post.id}/thread`)
			.body({applied_tags: []})
			.executeRaw();

		expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(text).toContain(ValidationErrorCodes.FORUM_TAG_REQUIRED);
	});

	test('the thread member list carries the thread id and no internal fields', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'general', type: ChannelTypes.GUILD_TEXT})
			.execute();
		const thread = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/channels/${parent.id}/threads`)
			.body({name: 'members here'})
			.expect(HTTP_STATUS.CREATED)
			.execute();

		const members = await createBuilder<ThreadMemberListResponse>(harness, owner.token)
			.get(`/channels/${thread.id}/thread-members`)
			.execute();

		expect(members).toHaveLength(1);
		expect(ThreadMemberResponse.parse(members[0]).id).toBe(thread.id);
		expect(members[0].user_id).toBe(owner.userId);
	});

	test('thread_member_ids is not part of the published channel schema', () => {
		expect(Object.keys(ChannelResponse.shape)).not.toContain('thread_member_ids');
	});

	test('a private thread HTTP response never carries thread_member_ids', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const parent = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'general', type: ChannelTypes.GUILD_TEXT})
			.execute();
		const privateThread = await createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/channels/${parent.id}/threads`)
			.body({name: 'secret', type: ChannelTypes.PRIVATE_THREAD})
			.expect(HTTP_STATUS.CREATED)
			.execute();

		const fetched = await createBuilder<Record<string, unknown>>(harness, owner.token)
			.get(`/channels/${privateThread.id}`)
			.execute();

		expect((privateThread as unknown as Record<string, unknown>).thread_member_ids).toBeUndefined();
		expect(fetched.thread_member_ids).toBeUndefined();
	});
});
