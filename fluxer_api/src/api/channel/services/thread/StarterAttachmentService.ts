// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: "add to post". Not in upstream; see docs/upstream-divergence.md and
// docs/forums2-contract.md section 2.
//
// The owner of a forum post replies with media and then appends that media to the post's first
// message, where it becomes the post thumbnail. Nothing is uploaded: the attachment is already
// stored, and its CDN key is derived from the channel and the attachment id. A forum post's first
// message lives in the post channel itself (id == channel id), as do its replies, so the same blob
// serves both messages.

import {AttachmentDecayRepository} from '@app/api/attachment/AttachmentDecayRepository';
import {
	type AttachmentID,
	type ChannelID,
	channelIdToMessageId,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import {dispatchMessageUpdateBroadcast} from '@app/api/channel/services/message/MessageGatewayDispatch';
import {MessageWriteLock} from '@app/api/channel/services/message/MessageWriteLock';
import {assertThreadAllowed} from '@app/api/channel/services/thread/ThreadDenials';
import {dispatchThreadEvents, threadUpdateEvent} from '@app/api/channel/services/thread/ThreadDispatch';
import type {ThreadServiceContext} from '@app/api/channel/services/thread/ThreadServiceContext';
import {loadThreadView} from '@app/api/channel/services/thread/ThreadViews';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {Logger} from '@app/api/Logger';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import type {Message} from '@app/api/models/Message';
import {getMessageSearchService} from '@app/api/SearchFactory';
import {getExpiryBucket} from '@app/api/utils/AttachmentDecay';
import {MAX_ATTACHMENTS_PER_MESSAGE} from '@fluxer/constants/src/LimitConstants';
import {THREAD_ONLY_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';
import {threadWriteBlock} from '@fluxer/constants/src/ThreadPermissionUtils';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';

interface StarterAppend {
	message: Message;
	hadAttachments: boolean;
}

export class StarterAttachmentService {
	private readonly decay = new AttachmentDecayRepository();

	constructor(private readonly ctx: ThreadServiceContext) {}

	async add(params: {
		viewer: ThreadViewer;
		userId: UserID;
		channelId: ChannelID;
		sourceMessageId: MessageID;
		attachmentId: AttachmentID;
	}): Promise<MessageResponse> {
		const auth = await this.ctx.channelAuth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.channelId,
			viewer: params.viewer,
		});
		const {thread, channel} = auth;
		if (!thread || !auth.guild || channel.guildId === null) throw new UnknownChannelError();
		if (!THREAD_ONLY_CHANNEL_TYPES.has(thread.parent.type)) throw new InvalidChannelTypeError();
		if (!thread.actor.isThreadOwner && !thread.isModerator) throw new MissingPermissionsError();
		assertThreadAllowed(threadWriteBlock('edit', thread.actor));

		const {messages} = this.ctx.channelRepository;
		const starterId = channelIdToMessageId(channel.id);
		const source = await messages.getMessage(channel.id, params.sourceMessageId);
		if (!source) throw new UnknownMessageError();
		if (source.id === starterId) {
			throw InputValidationError.fromCode('message_id', ValidationErrorCodes.STARTER_ATTACHMENT_SOURCE_INVALID);
		}
		const attachment = source.attachments.find((entry) => entry.id === params.attachmentId);
		if (!attachment) throw new UnknownMessageError();

		const guildFeatures = auth.guild.features;
		const append = await new MessageWriteLock(this.ctx.cacheService, messages).withFreshMessage(
			channel.id,
			starterId,
			async (starter): Promise<StarterAppend> => {
				if (!starter) throw new UnknownMessageError();
				const row = starter.toRow();
				const existing = row.attachments ?? [];
				if (existing.some((entry) => entry.attachment_id === params.attachmentId)) {
					throw InputValidationError.fromCode('attachment_id', ValidationErrorCodes.STARTER_ATTACHMENT_ALREADY_PRESENT);
				}
				const author = starter.authorId ? await this.ctx.userRepository.findUnique(starter.authorId) : null;
				const maxAttachments = Math.floor(
					resolveLimitSafe(
						getLimitConfigService().getConfigSnapshot(),
						createLimitMatchContext({user: author, guildFeatures}),
						'max_attachments_per_message',
						MAX_ATTACHMENTS_PER_MESSAGE,
						guildFeatures ? 'guild' : 'user',
					),
				);
				if (existing.length >= maxAttachments) {
					throw InputValidationError.fromCode('attachment_id', ValidationErrorCodes.STARTER_ATTACHMENT_LIMIT_REACHED);
				}
				const message = await messages.upsertMessage(
					{...row, attachments: [...existing, attachment.toMessageAttachment()]},
					row,
				);
				return {message, hadAttachments: existing.length > 0};
			},
		);

		await this.repointDecay(params.attachmentId, starterId);
		await dispatchMessageUpdateBroadcast({
			gatewayService: this.ctx.gatewayService,
			channel,
			message: append.message,
		});
		// The forum card shows the first attachment, so only a first message that had none gains a
		// thumbnail and only then does the card change. A second attachment changes no card.
		if (!append.hadAttachments) {
			const view = await loadThreadView(this.ctx.channelRepository, channel, thread.state, thread.parent);
			await dispatchThreadEvents(this.ctx.gatewayService, view.state.guildId, [threadUpdateEvent(view)]);
		}
		await this.reindex(append.message);

		const response = (
			await this.ctx.threadMessageResponses.getFirstMessages({
				userId: params.userId,
				guildId: channel.guildId,
				canReadMessageHistory: true,
				threadIds: [channel.id],
			})
		).get(channel.id.toString());
		if (!response) throw new UnknownMessageError();
		return response;
	}

	// With attachment decay enabled the attachment has a decay record naming the reply that carried
	// it. Re-point it at the first message so the blob's lifetime follows the post, not the reply.
	// The expiry is untouched. Without a record (decay disabled) there is nothing to do.
	private async repointDecay(attachmentId: AttachmentID, starterId: MessageID): Promise<void> {
		const record = (await this.decay.fetchByIds([attachmentId])).get(attachmentId);
		if (!record || record.message_id === starterId) return;
		await this.decay.upsert({
			...record,
			message_id: starterId,
			expiry_bucket: getExpiryBucket(record.expires_at),
		});
	}

	private async reindex(message: Message): Promise<void> {
		try {
			const search = getMessageSearchService();
			if (!search) return;
			const author = message.authorId ? await this.ctx.userRepository.findUnique(message.authorId) : null;
			await search.updateMessage(message, author?.isBot ?? false);
		} catch (error) {
			Logger.error({error, messageId: message.id.toString()}, 'Failed to update starter message in search index');
		}
	}
}
