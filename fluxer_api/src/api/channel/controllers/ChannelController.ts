// SPDX-License-Identifier: AGPL-3.0-or-later

import {requireSudoMode} from '@app/api/auth/services/SudoVerificationService';
import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {GroupDmRecipientAddProtectionMiddleware} from '@app/api/middleware/GroupDmProtectionMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {SudoModeMiddleware} from '@app/api/middleware/SudoModeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {CLIENT_FEATURES_HEADER, parseClientFeaturesHeader} from '@app/api/utils/featureUtils';
import {Validator} from '@app/api/Validator';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {SudoVerificationSchema} from '@fluxer/schema/src/domains/auth/AuthSchemas';
import {
	ChannelUpdateRequest,
	ChannelUpdateRequestBody,
	DeleteChannelQuery,
	PermissionOverwriteCreateRequest,
	ThreadCreateRequest,
	ThreadUpdateRequest,
} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import {
	ChannelListResponse,
	ChannelResponse,
	ChannelSlowmodeStateResponse,
	RtcRegionListResponse,
	ThreadMemberListResponse,
} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {
	ChannelIdOverwriteIdParam,
	ChannelIdParam,
	ChannelIdUserIdParam,
} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import type {Context} from 'hono';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ChannelController(app: HonoApp) {
	// Echowire: create a thread under a text/forum channel.
	app.post(
		'/channels/:channel_id/threads',
		RateLimitMiddleware(RateLimitConfigs.THREAD_CREATE),
		LoginRequired,
		Validator('param', ChannelIdParam),
		Validator('json', ThreadCreateRequest),
		OpenAPI({
			operationId: 'create_thread',
			summary: 'Create a thread',
			description:
				'Creates a thread under a text or forum channel. Requires permission to send messages in the parent.',
			responseSchema: ChannelResponse,
			statusCode: 201,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const parentChannelId = createChannelID(ctx.req.valid('param').channel_id);
			const data = ctx.req.valid('json');
			const requestCache = ctx.get('requestCache');
			return ctx.json(
				await ctx.get('guildService').channels.createThread({userId, parentChannelId, data, requestCache}),
				201,
			);
		},
	);
	// Echowire: list active threads under a text/forum channel.
	app.get(
		'/channels/:channel_id/threads',
		RateLimitMiddleware(RateLimitConfigs.THREAD_LIST_ACTIVE),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'list_active_threads',
			summary: 'List active threads',
			description: 'Lists the active (non-archived) threads under a text or forum channel.',
			responseSchema: ChannelListResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const parentChannelId = createChannelID(ctx.req.valid('param').channel_id);
			const requestCache = ctx.get('requestCache');
			return ctx.json(
				await ctx.get('guildService').channels.listActiveThreads({userId, parentChannelId, requestCache}),
			);
		},
	);
	// Echowire: update a thread (archive/unarchive/lock/rename).
	app.patch(
		'/channels/:channel_id/thread',
		RateLimitMiddleware(RateLimitConfigs.THREAD_UPDATE),
		LoginRequired,
		Validator('param', ChannelIdParam),
		Validator('json', ThreadUpdateRequest),
		OpenAPI({
			operationId: 'update_thread',
			summary: 'Update a thread',
			description: 'Updates a thread (name, archived, locked, auto-archive duration, invitable).',
			responseSchema: ChannelResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const threadChannelId = createChannelID(ctx.req.valid('param').channel_id);
			const data = ctx.req.valid('json');
			const requestCache = ctx.get('requestCache');
			return ctx.json(
				await ctx.get('guildService').channels.updateThread({userId, threadChannelId, data, requestCache}),
			);
		},
	);
	// Echowire: delete a thread.
	app.delete(
		'/channels/:channel_id/thread',
		RateLimitMiddleware(RateLimitConfigs.THREAD_DELETE),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'delete_thread',
			summary: 'Delete a thread',
			description: 'Deletes a thread. Requires being the thread owner or having Manage Channels.',
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const threadChannelId = createChannelID(ctx.req.valid('param').channel_id);
			await ctx.get('guildService').channels.deleteThread({userId, threadChannelId});
			return ctx.body(null, 204);
		},
	);
	// Echowire: list archived threads under a text/forum channel.
	app.get(
		'/channels/:channel_id/threads/archived',
		RateLimitMiddleware(RateLimitConfigs.THREAD_LIST_ARCHIVED),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'list_archived_threads',
			summary: 'List archived threads',
			description: 'Lists the archived threads under a text or forum channel.',
			responseSchema: ChannelListResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const parentChannelId = createChannelID(ctx.req.valid('param').channel_id);
			const requestCache = ctx.get('requestCache');
			return ctx.json(
				await ctx.get('guildService').channels.listArchivedThreads({userId, parentChannelId, requestCache}),
			);
		},
	);
	// Echowire: thread membership — join (@me), leave (@me), list.
	app.put(
		'/channels/:channel_id/thread-members/@me',
		RateLimitMiddleware(RateLimitConfigs.THREAD_MEMBER_JOIN),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'join_thread',
			summary: 'Join a thread',
			description: 'Adds the current user to a thread.',
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const threadChannelId = createChannelID(ctx.req.valid('param').channel_id);
			await ctx.get('guildService').channels.joinThread({userId, threadChannelId});
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/channels/:channel_id/thread-members/@me',
		RateLimitMiddleware(RateLimitConfigs.THREAD_MEMBER_LEAVE),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'leave_thread',
			summary: 'Leave a thread',
			description: 'Removes the current user from a thread.',
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const threadChannelId = createChannelID(ctx.req.valid('param').channel_id);
			await ctx.get('guildService').channels.leaveThread({userId, threadChannelId});
			return ctx.body(null, 204);
		},
	);
	app.get(
		'/channels/:channel_id/thread-members',
		RateLimitMiddleware(RateLimitConfigs.THREAD_MEMBER_LIST),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'list_thread_members',
			summary: 'List thread members',
			description: 'Lists the members of a thread.',
			responseSchema: ThreadMemberListResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const threadChannelId = createChannelID(ctx.req.valid('param').channel_id);
			return ctx.json(await ctx.get('guildService').channels.listThreadMembers({userId, threadChannelId}));
		},
	);
	app.get(
		'/channels/:channel_id',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_GET),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'get_channel',
			summary: 'Fetch a channel',
			description:
				'Retrieves the channel object including metadata, member list, and settings. Requires the user to be a member of the channel with view permissions.',
			responseSchema: ChannelResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const requestCache = ctx.get('requestCache');
			const channelRequestService = ctx.get('channelRequestService');
			return ctx.json(
				await channelRequestService.getChannelResponse({
					userId,
					channelId,
					requestCache,
				}),
			);
		},
	);
	app.get(
		'/channels/:channel_id/slowmode',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_GET),
		LoginRequired,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'get_channel_slowmode_state',
			summary: 'Fetch slowmode state',
			description:
				'Returns the current slowmode rate-limit state for the calling user in this channel, including the configured interval and the time at which they are next allowed to send a message. Lets clients restore slowmode countdowns across devices without relying on local persistence.',
			responseSchema: ChannelSlowmodeStateResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const user = ctx.get('user');
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const channelRequestService = ctx.get('channelRequestService');
			return ctx.json(await channelRequestService.getSlowmodeState({user, channelId}));
		},
	);
	app.get(
		'/channels/:channel_id/rtc-regions',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_GET),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ChannelIdParam),
		OpenAPI({
			operationId: 'list_rtc_regions',
			summary: 'List RTC regions',
			description:
				'Returns available voice and video calling regions for the channel, used to optimise connection quality. Requires membership with call permissions.',
			responseSchema: RtcRegionListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const channelRequestService = ctx.get('channelRequestService');
			return ctx.json(await channelRequestService.listRtcRegions({userId, channelId}));
		},
	);
	app.patch(
		'/channels/:channel_id',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_UPDATE),
		LoginRequired,
		Validator('param', ChannelIdParam, {
			post: async (result, ctx: Context<HonoEnv>) => {
				if (!result.success) {
					return undefined;
				}
				const channelId = createChannelID(result.data.channel_id);
				const existing = await ctx.get('channelService').channelData.operations.getChannel({
					userId: ctx.get('user').id,
					channelId,
					skipNsfwValidation: true,
				});
				ctx.set('channelUpdateType', existing.type);
				return undefined;
			},
		}),
		Validator('json', ChannelUpdateRequest, {
			pre: async (raw: unknown, ctx: Context<HonoEnv>) => {
				const channelType = ctx.get('channelUpdateType');
				if (channelType === undefined) {
					throw new UnknownChannelError();
				}
				const body = isPlainObject(raw) ? raw : {};
				return {...body, type: channelType};
			},
		}),
		OpenAPI({
			operationId: 'update_channel',
			requestSchema: ChannelUpdateRequestBody,
			summary: 'Update channel settings',
			description:
				'Modifies channel properties such as name, description, topic, nsfw flag, and slowmode. Requires management permissions in the channel.',
			responseSchema: ChannelResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const data = ctx.req.valid('json');
			const clientFeatures = parseClientFeaturesHeader(ctx.req.header(CLIENT_FEATURES_HEADER));
			const requestCache = ctx.get('requestCache');
			const channelRequestService = ctx.get('channelRequestService');
			return ctx.json(
				await channelRequestService.updateChannel({
					userId,
					channelId,
					data,
					clientFeatures,
					requestCache,
				}),
			);
		},
	);
	app.delete(
		'/channels/:channel_id',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_DELETE),
		LoginRequired,
		Validator('param', ChannelIdParam),
		Validator('query', DeleteChannelQuery),
		SudoModeMiddleware,
		Validator('json', SudoVerificationSchema),
		OpenAPI({
			operationId: 'delete_channel',
			summary: 'Delete a channel',
			description:
				"Permanently removes a channel and all its content. Only server administrators or the channel owner can delete channels. When `delete_messages` is set on a group DM, the caller's authored messages in the group are deleted before leaving and sudo mode verification is required.",
			requestSchema: SudoVerificationSchema,
			requestBodyRequired: false,
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const user = ctx.get('user');
			const userId = user.id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const {silent, delete_messages} = ctx.req.valid('query');
			const body = ctx.req.valid('json');
			const requestCache = ctx.get('requestCache');
			const channelRequestService = ctx.get('channelRequestService');
			await ctx.get('channelService').channelData.operations.getChannel({userId, channelId});
			if (delete_messages) {
				await requireSudoMode(ctx, user, body);
				await ctx.get('channelService').userMessageDeletion.deleteUserMessagesInScope(userId, {
					channelIds: [channelId],
				});
			}
			await channelRequestService.deleteChannel({userId, channelId, requestCache, silent});
			return ctx.body(null, 204);
		},
	);
	app.put(
		'/channels/:channel_id/recipients/:user_id',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_UPDATE),
		LoginRequired,
		Validator('param', ChannelIdUserIdParam),
		GroupDmRecipientAddProtectionMiddleware,
		OpenAPI({
			operationId: 'add_group_dm_recipient',
			summary: 'Add recipient to group DM',
			description:
				'Adds a user to a group direct message channel. The requesting user must be a member of the group DM. Requires CAPTCHA verification.',
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const recipientId = createUserID(ctx.req.valid('param').user_id);
			const requestCache = ctx.get('requestCache');
			await ctx.get('channelService').groupDms.addRecipientToChannel({
				userId,
				channelId,
				recipientId,
				requestCache,
			});
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/channels/:channel_id/recipients/:user_id',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_UPDATE),
		LoginRequired,
		Validator('param', ChannelIdUserIdParam),
		Validator('query', DeleteChannelQuery),
		SudoModeMiddleware,
		Validator('json', SudoVerificationSchema),
		OpenAPI({
			operationId: 'remove_group_dm_recipient',
			summary: 'Remove recipient from group DM',
			description:
				'Removes a user from a group direct message channel. The requesting user must be a member with appropriate permissions. When the caller removes themself with `delete_messages`, their authored messages in the group are deleted before leaving and sudo mode verification is required.',
			requestSchema: SudoVerificationSchema,
			requestBodyRequired: false,
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const recipientId = createUserID(ctx.req.valid('param').user_id);
			const {silent, delete_messages} = ctx.req.valid('query');
			const body = ctx.req.valid('json');
			const requestCache = ctx.get('requestCache');
			if (delete_messages && recipientId === userId) {
				await ctx.get('channelService').channelData.operations.getChannel({userId, channelId});
				await requireSudoMode(ctx, ctx.get('user'), body);
				await ctx.get('channelService').userMessageDeletion.deleteUserMessagesInScope(userId, {
					channelIds: [channelId],
				});
			}
			await ctx
				.get('channelService')
				.groupDms.removeRecipientFromChannel({userId, channelId, recipientId, requestCache, silent});
			return ctx.body(null, 204);
		},
	);
	app.put(
		'/channels/:channel_id/permissions/:overwrite_id',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_UPDATE),
		LoginRequired,
		Validator('param', ChannelIdOverwriteIdParam),
		Validator('json', PermissionOverwriteCreateRequest),
		OpenAPI({
			operationId: 'set_channel_permission_overwrite',
			summary: 'Set permission overwrite for channel',
			description:
				'Creates or updates permission overrides for a role or user in the channel. Allows fine-grained control over who can view, send messages, or manage the channel.',
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const overwriteId = ctx.req.valid('param').overwrite_id;
			const data = ctx.req.valid('json');
			const clientFeatures = parseClientFeaturesHeader(ctx.req.header(CLIENT_FEATURES_HEADER));
			const requestCache = ctx.get('requestCache');
			await ctx.get('channelService').channelData.operations.setChannelPermissionOverwrite({
				userId,
				channelId,
				overwriteId,
				overwrite: {
					type: data.type,
					allow_: data.allow ? data.allow : 0n,
					deny_: data.deny ? data.deny : 0n,
				},
				clientFeatures,
				requestCache,
			});
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/channels/:channel_id/permissions/:overwrite_id',
		RateLimitMiddleware(RateLimitConfigs.CHANNEL_UPDATE),
		LoginRequired,
		Validator('param', ChannelIdOverwriteIdParam),
		OpenAPI({
			operationId: 'delete_channel_permission_overwrite',
			summary: 'Delete permission overwrite',
			description:
				'Removes a permission override from a role or user in the channel, restoring default permissions. Requires channel management rights.',
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			const overwriteId = ctx.req.valid('param').overwrite_id;
			const requestCache = ctx.get('requestCache');
			await ctx
				.get('channelService')
				.channelData.operations.deleteChannelPermissionOverwrite({userId, channelId, overwriteId, requestCache});
			return ctx.body(null, 204);
		},
	);
}
