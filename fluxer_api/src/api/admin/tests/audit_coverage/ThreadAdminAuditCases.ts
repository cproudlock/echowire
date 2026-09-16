// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads and forum posts are a fork feature, so their admin routes need
// their own audit coverage cases alongside upstream's areas.

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannel, createGuild} from '@app/api/channel/tests/AttachmentTestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';

const THREAD_NAME = 'audit coverage thread';

async function createParentWithThread(
	harness: ApiTestHarness,
): Promise<{owner: TestAccount; guildId: string; parentId: string; threadId: string}> {
	const owner = await createTestAccount(harness);
	const guild = await createGuild(harness, owner.token, 'Audit Thread Guild');
	const parent = await createChannel(harness, owner.token, guild.id, 'audit-threads');
	const thread = await createBuilder<ChannelResponse>(harness, owner.token)
		.post(`/channels/${parent.id}/threads`)
		.body({name: THREAD_NAME})
		.expect(HTTP_STATUS.CREATED)
		.execute();
	return {owner, guildId: guild.id, parentId: parent.id, threadId: thread.id};
}

export const ThreadAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/channels/:channel_id/threads',
		async prepare({harness}) {
			const {parentId} = await createParentWithThread(harness);
			return {
				request: {path: `/admin/channels/${parentId}/threads`},
				expected: {
					action: 'list_channel_threads',
					targetType: 'channel',
					targetId: parentId,
					metadata: {result_count: '1'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/channels/:channel_id/thread',
		async prepare({harness}) {
			const {threadId} = await createParentWithThread(harness);
			return {
				request: {path: `/admin/channels/${threadId}/thread`, body: {archived: true, locked: true}},
				expected: {
					action: 'thread_update',
					targetType: 'thread',
					targetId: threadId,
					metadata: {thread_name: THREAD_NAME, archived: 'true', locked: 'true'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/channels/:channel_id/thread',
		async prepare({harness}) {
			const {guildId, parentId, threadId} = await createParentWithThread(harness);
			return {
				request: {path: `/admin/channels/${threadId}/thread`},
				expected: {
					action: 'thread_delete',
					targetType: 'thread',
					targetId: threadId,
					metadata: {thread_name: THREAD_NAME, guild_id: guildId, parent_id: parentId},
				},
			};
		},
	},
];
