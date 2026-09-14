// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AttachmentID, ChannelID, MessageID, UserID} from '@app/api/BrandedTypes';
import type {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {
	IMessageRepository,
	type ListMessagesOptions,
	type MessageDeleteOptions,
} from '@app/api/channel/repositories/IMessageRepository';
import {MessageAttachmentRepository} from '@app/api/channel/repositories/message/MessageAttachmentRepository';
import {MessageAuthorRepository} from '@app/api/channel/repositories/message/MessageAuthorRepository';
import {MessageDataRepository} from '@app/api/channel/repositories/message/MessageDataRepository';
import {MessageDeletionRepository} from '@app/api/channel/repositories/message/MessageDeletionRepository';
import type {MessageRow} from '@app/api/database/types/MessageTypes';
import type {Channel} from '@app/api/models/Channel';
import type {Message} from '@app/api/models/Message';
import {ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';

// Echowire: above this many counted replies, assume a forum post's earliest message is its starter
// rather than listing the post to check.
const STARTER_PRESENCE_SCAN_LIMIT = 500;

export class MessageRepository extends IMessageRepository {
	private dataRepo: MessageDataRepository;
	private deletionRepo: MessageDeletionRepository;
	private attachmentRepo: MessageAttachmentRepository;
	private authorRepo: MessageAuthorRepository;
	private channelDataRepo: ChannelDataRepository;

	constructor(channelDataRepo: ChannelDataRepository) {
		super();
		this.dataRepo = new MessageDataRepository();
		this.deletionRepo = new MessageDeletionRepository(this.dataRepo);
		this.attachmentRepo = new MessageAttachmentRepository();
		this.authorRepo = new MessageAuthorRepository(this.dataRepo, this.deletionRepo);
		this.channelDataRepo = channelDataRepo;
	}

	async listMessages(
		channelId: ChannelID,
		beforeMessageId?: MessageID,
		limit?: number,
		afterMessageId?: MessageID,
		options?: ListMessagesOptions,
	): Promise<Array<Message>> {
		return this.dataRepo.listMessages(channelId, beforeMessageId, limit, afterMessageId, options);
	}

	async getMessage(channelId: ChannelID, messageId: MessageID): Promise<Message | null> {
		return this.dataRepo.getMessage(channelId, messageId);
	}

	async upsertMessage(data: MessageRow, oldData?: MessageRow | null): Promise<Message> {
		const message = await this.dataRepo.upsertMessage(data, oldData);
		if (!oldData) {
			await this.channelDataRepo.updateLastMessageId(data.channel_id, data.message_id);
		}
		return message;
	}

	async deleteMessage(
		channelId: ChannelID,
		messageId: MessageID,
		authorId: UserID,
		pinnedTimestamp?: Date,
		options?: MessageDeleteOptions,
	): Promise<void> {
		// Echowire: keep a thread's message_count in step with deletions. Work out the decrement
		// before deleting, because spotting a forum post's starter needs the message still present.
		const decrement = await this.threadCountDecrement(channelId, [messageId], options?.channelType);
		await this.deletionRepo.deleteMessage(channelId, messageId, authorId, pinnedTimestamp);
		await this.channelDataRepo.adjustThreadMessageCount(channelId, -decrement);
	}

	async bulkDeleteMessages(
		channelId: ChannelID,
		messageIds: Array<MessageID>,
		options?: MessageDeleteOptions,
	): Promise<void> {
		const decrement = await this.threadCountDecrement(channelId, messageIds, options?.channelType);
		await this.deletionRepo.bulkDeleteMessages(channelId, messageIds);
		await this.channelDataRepo.adjustThreadMessageCount(channelId, -decrement);
	}

	// Echowire: how far a delete should lower a thread's message_count. Non-threads are untouched.
	// A forum post's starter message was never counted (see ChannelDataRepository), so deleting it
	// must not be subtracted either.
	private async threadCountDecrement(
		channelId: ChannelID,
		messageIds: Array<MessageID>,
		channelType?: number,
	): Promise<number> {
		if (messageIds.length === 0) return 0;
		if (channelType !== undefined && !THREAD_CHANNEL_TYPES.has(channelType)) return 0;
		const thread = await this.channelDataRepo.findUnique(channelId);
		if (!thread || !THREAD_CHANNEL_TYPES.has(thread.type)) return 0;
		const starterIncluded = await this.includesForumPostStarter(thread, messageIds);
		return messageIds.length - (starterIncluded ? 1 : 0);
	}

	// The starter is the earliest message of a forum post. The earliest remaining message is the
	// starter only if the starter has not already been deleted: replies are counted and the starter
	// is not, so the starter is present exactly when the post holds message_count + 1 messages.
	private async includesForumPostStarter(thread: Channel, messageIds: Array<MessageID>): Promise<boolean> {
		if (!thread.parentId) return false;
		const parent = await this.channelDataRepo.findUnique(thread.parentId);
		if (parent?.type !== ChannelTypes.GUILD_FORUM) return false;
		const earliest = messageIds.reduce((min, id) => (id < min ? id : min));
		const earlier = await this.dataRepo.listMessages(thread.id, earliest, 1);
		if (earlier.length > 0) return false;
		const counted = thread.messageCount ?? 0;
		if (counted >= STARTER_PRESENCE_SCAN_LIMIT) return true;
		const present = await this.dataRepo.listMessages(thread.id, undefined, counted + 2);
		return present.length === counted + 1;
	}

	async deleteAllChannelMessages(channelId: ChannelID): Promise<void> {
		return this.deletionRepo.deleteAllChannelMessages(channelId);
	}

	async listMessagesByAuthor(
		authorId: UserID,
		limit?: number,
		lastMessageId?: MessageID,
	): Promise<
		Array<{
			channelId: ChannelID;
			messageId: MessageID;
		}>
	> {
		return this.authorRepo.listMessagesByAuthor(authorId, limit, lastMessageId);
	}

	async deleteMessagesByAuthor(
		authorId: UserID,
		channelIds?: Array<ChannelID>,
		messageIds?: Array<MessageID>,
	): Promise<void> {
		return this.authorRepo.deleteMessagesByAuthor(authorId, channelIds, messageIds);
	}

	async anonymizeMessage(channelId: ChannelID, messageId: MessageID, newAuthorId: UserID): Promise<void> {
		return this.authorRepo.anonymizeMessage(channelId, messageId, newAuthorId);
	}

	async authorHasMessage(authorId: UserID, channelId: ChannelID, messageId: MessageID): Promise<boolean> {
		return this.authorRepo.hasMessageByAuthor(authorId, channelId, messageId);
	}

	async lookupAttachmentByChannelAndFilename(
		channelId: ChannelID,
		attachmentId: AttachmentID,
		filename: string,
	): Promise<MessageID | null> {
		return this.attachmentRepo.lookupAttachmentByChannelAndFilename(channelId, attachmentId, filename);
	}

	async updateEmbeds(message: Message): Promise<void> {
		return this.dataRepo.updateEmbeds(message);
	}
}
