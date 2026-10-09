// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: "add to post". Not in upstream; see docs/upstream-divergence.md.

import {createAttachmentID, createChannelID, createMessageID} from '@app/api/BrandedTypes';
import {ChannelThreadsRouteGuard} from '@app/api/channel/threads/ChannelThreadsRouteGuard';
import {viewerFromCtx} from '@app/api/experiment/ChannelThreadsGate';
import {LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {StarterAttachmentRequest} from '@fluxer/schema/src/domains/channel/StarterAttachmentSchemas';
import {ChannelIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {MessageResponseSchema} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';

export function StarterAttachmentController(app: HonoApp) {
	app.post(
		'/channels/:channel_id/starter-message/attachments',
		ChannelThreadsRouteGuard(),
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_STARTER_ATTACHMENT),
		LoginRequired,
		Validator('param', ChannelIdParam),
		Validator('json', StarterAttachmentRequest),
		OpenAPI({
			operationId: 'add_attachment_to_post',
			summary: 'Add an attachment to a post',
			description:
				"Appends an attachment that already exists on a message in a forum or media post to the post's first message, where it becomes the post thumbnail. Requires being the post owner or having the manage threads permission. Returns the updated first message.",
			responseSchema: MessageResponseSchema,
			statusCode: 200,
			security: ['botToken', 'sessionToken'],
			tags: 'Channels',
			experiment: 'channel_threads',
		}),
		async (ctx) => {
			const body = ctx.req.valid('json');
			return ctx.json(
				await ctx.get('threadService').starterAttachments.add({
					viewer: viewerFromCtx(ctx),
					userId: ctx.get('user').id,
					channelId: createChannelID(ctx.req.valid('param').channel_id),
					sourceMessageId: createMessageID(body.message_id),
					attachmentId: createAttachmentID(body.attachment_id),
				}),
			);
		},
	);
}
