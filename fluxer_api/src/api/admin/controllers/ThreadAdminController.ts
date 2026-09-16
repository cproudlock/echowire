// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: admin routes for threads and forum posts. Channel-scoped rather than guild-scoped,
// because a thread is addressed by its own channel id everywhere else in the api.

import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {AdminRateLimitConfigs} from '@app/api/rate_limit_configs/AdminRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {
	AdminThreadResponse,
	ListChannelThreadsResponse,
	UpdateAdminThreadRequest,
} from '@fluxer/schema/src/domains/admin/AdminThreadSchemas';
import {ChannelIdParam, SuccessResponse} from '@fluxer/schema/src/domains/common/CommonParamSchemas';

export function ThreadAdminController(app: HonoApp) {
	app.get(
		'/admin/channels/:channel_id/threads',
		RateLimitMiddleware(AdminRateLimitConfigs.ADMIN_LOOKUP),
		requireAdminACL(AdminACLs.CHANNEL_LIST_THREADS),
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'list_admin_channel_threads',
			summary: 'List channel threads',
			description:
				'Lists the threads or forum posts under a text or forum channel, newest first, with their archive, lock and pin state. Returns an empty list for channel types that cannot parent threads. Requires CHANNEL_LIST_THREADS permission.',
			responseSchema: ListChannelThreadsResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const adminService = ctx.get('adminService');
			return ctx.json(
				await adminService.threadService.listChannelThreads({
					channel_id: ctx.req.valid('param').channel_id,
				}),
			);
		},
	);
	app.patch(
		'/admin/channels/:channel_id/thread',
		RateLimitMiddleware(AdminRateLimitConfigs.ADMIN_GUILD_MODIFY),
		requireAdminACL(AdminACLs.CHANNEL_THREAD_UPDATE),
		Validator('param', ChannelIdParam),
		Validator('json', UpdateAdminThreadRequest),
		OpenAPI({
			operationId: 'update_admin_channel_thread',
			summary: 'Update thread state',
			description:
				'Archives, unarchives, locks or unlocks a thread or forum post as an instance admin. Dispatches THREAD_UPDATE to the guild. Logged to audit log. Requires CHANNEL_THREAD_UPDATE permission.',
			responseSchema: AdminThreadResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const adminService = ctx.get('adminService');
			return ctx.json(
				await adminService.threadService.updateThread({
					channel_id: ctx.req.valid('param').channel_id,
					body: ctx.req.valid('json'),
					adminUserId: ctx.get('adminUserId'),
					auditLogReason: ctx.get('auditLogReason'),
				}),
			);
		},
	);
	app.delete(
		'/admin/channels/:channel_id/thread',
		RateLimitMiddleware(AdminRateLimitConfigs.ADMIN_GUILD_MODIFY),
		requireAdminACL(AdminACLs.CHANNEL_THREAD_DELETE),
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'delete_admin_channel_thread',
			summary: 'Delete thread',
			description:
				'Permanently deletes a thread or forum post and purges its messages, attachments and search documents. Irreversible. Logged to audit log. Requires CHANNEL_THREAD_DELETE permission.',
			responseSchema: SuccessResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const adminService = ctx.get('adminService');
			return ctx.json(
				await adminService.threadService.deleteThread({
					channel_id: ctx.req.valid('param').channel_id,
					adminUserId: ctx.get('adminUserId'),
					auditLogReason: ctx.get('auditLogReason'),
				}),
			);
		},
	);
}
