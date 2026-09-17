// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: client commands for Threads (re-ported from the old fork; backend endpoints
// POST/GET /channels/:id/threads, PATCH/DELETE /channels/:id/thread).

import {Endpoints} from '@app/features/app/constants/Endpoints';
import Authentication from '@app/features/auth/state/Authentication';
import Channels from '@app/features/channel/state/Channels';
import ForumPostPreviews, {type WireStarterMessagePreview} from '@app/features/channel/state/ForumPostPreviews';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import type {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {Channel} from '@fluxer/schema/src/domains/channel/ChannelSchemas';

const logger = new Logger('Threads');

type ThreadListChannel = Channel & {starter_message_preview?: WireStarterMessagePreview | null};

interface GuildActiveThreadsResponse {
	threads: Array<ThreadListChannel>;
	members: Array<{id: string; user_id: string; join_timestamp: string; flags: number}>;
}

export interface CreateThreadParams {
	name: string;
	type?: typeof ChannelTypes.PUBLIC_THREAD | typeof ChannelTypes.PRIVATE_THREAD;
	auto_archive_duration?: 60 | 1440 | 4320 | 10080;
	// When starting a thread from a message, the source message ID. The created thread
	// adopts this ID so the message can render an inline link to it.
	message_id?: string;
	// Forum post tags (only valid when the parent is a forum channel; max 5).
	applied_tags?: Array<string>;
}

export interface UpdateThreadParams {
	name?: string;
	archived?: boolean;
	locked?: boolean;
	auto_archive_duration?: 60 | 1440 | 4320 | 10080;
	invitable?: boolean;
	// Forum post tags (replacement set, max 5).
	applied_tags?: Array<string>;
	// Pin/unpin a forum post (moderators).
	pinned?: boolean;
	// Slowmode for this thread or post in seconds (0 to 21600).
	rate_limit_per_user?: number;
}

// Create a thread under a text/forum parent channel. Returns the created thread channel.
export async function createThread(parentChannelId: string, params: CreateThreadParams): Promise<Channel> {
	try {
		const response = await http.post<Channel>(Endpoints.CHANNEL_THREADS(parentChannelId), {body: params});
		const thread = response.body;
		Channels.handleChannelCreate({channel: thread});
		const userId = Authentication.currentUserId;
		if (userId) {
			ThreadMembers.addMember(thread.id, {userId, joinTimestamp: new Date().toISOString()});
		}
		return thread;
	} catch (error) {
		logger.error(`Failed to create thread under ${parentChannelId}:`, error);
		throw error;
	}
}

// List the active (non-archived) threads under a text/forum parent channel.
export async function listActiveThreads(parentChannelId: string): Promise<Array<Channel>> {
	try {
		const response = await http.get<Array<ThreadListChannel>>(Endpoints.CHANNEL_THREADS(parentChannelId));
		const threads = response.body ?? [];
		ForumPostPreviews.ingest(threads);
		for (const thread of threads) {
			Channels.handleChannelCreate({channel: thread});
		}
		return threads;
	} catch (error) {
		logger.error(`Failed to list threads under ${parentChannelId}:`, error);
		throw error;
	}
}

// List the archived threads under a text/forum parent channel.
export async function listArchivedThreads(parentChannelId: string): Promise<Array<Channel>> {
	try {
		const response = await http.get<Array<ThreadListChannel>>(Endpoints.CHANNEL_THREADS_ARCHIVED(parentChannelId));
		const threads = response.body ?? [];
		ForumPostPreviews.ingest(threads);
		for (const thread of threads) {
			Channels.handleChannelCreate({channel: thread});
		}
		return threads;
	} catch (error) {
		logger.error(`Failed to list archived threads under ${parentChannelId}:`, error);
		throw error;
	}
}

// Load every active thread the user can see in a guild, with the user's own memberships, so the
// sidebar can nest joined threads under their parents. Older servers without the route are ignored.
export async function listGuildActiveThreads(guildId: string): Promise<void> {
	try {
		const response = await http.get<GuildActiveThreadsResponse>(Endpoints.GUILD_THREADS_ACTIVE(guildId));
		const {threads = [], members = []} = response.body ?? {threads: [], members: []};
		ForumPostPreviews.ingest(threads);
		for (const thread of threads) {
			Channels.handleChannelCreate({channel: thread});
		}
		for (const member of members) {
			ThreadMembers.addMember(member.id, {userId: member.user_id, joinTimestamp: member.join_timestamp});
		}
	} catch (error) {
		logger.warn(`Failed to list active threads for guild ${guildId}:`, error);
	}
}

// Update a thread (archive/unarchive, lock, rename, auto-archive duration).
export async function updateThread(threadChannelId: string, params: UpdateThreadParams): Promise<Channel> {
	try {
		const response = await http.patch<Channel>(Endpoints.CHANNEL_THREAD(threadChannelId), {body: params});
		const thread = response.body;
		Channels.handleChannelCreate({channel: thread});
		return thread;
	} catch (error) {
		logger.error(`Failed to update thread ${threadChannelId}:`, error);
		throw error;
	}
}

// Delete a thread.
export async function deleteThread(threadChannelId: string): Promise<void> {
	try {
		await http.delete(Endpoints.CHANNEL_THREAD(threadChannelId));
	} catch (error) {
		logger.error(`Failed to delete thread ${threadChannelId}:`, error);
		throw error;
	}
}

interface ThreadMemberResponse {
	user_id: string;
	join_timestamp: string;
	flags: number;
}

// List the members of a thread and sync the store.
export async function listThreadMembers(threadChannelId: string): Promise<void> {
	try {
		const response = await http.get<Array<ThreadMemberResponse>>(Endpoints.CHANNEL_THREAD_MEMBERS(threadChannelId));
		ThreadMembers.setMembers(
			threadChannelId,
			(response.body ?? []).map((member) => ({userId: member.user_id, joinTimestamp: member.join_timestamp})),
		);
	} catch (error) {
		logger.error(`Failed to list thread members for ${threadChannelId}:`, error);
	}
}

// Join the current user to a thread (optimistic store update).
export async function joinThread(threadChannelId: string): Promise<void> {
	const userId = Authentication.currentUserId;
	if (userId) {
		ThreadMembers.addMember(threadChannelId, {userId, joinTimestamp: new Date().toISOString()});
	}
	try {
		await http.put(Endpoints.CHANNEL_THREAD_MEMBER_ME(threadChannelId));
	} catch (error) {
		logger.error(`Failed to join thread ${threadChannelId}:`, error);
		void listThreadMembers(threadChannelId);
		throw error;
	}
}

// Leave a thread (optimistic store update).
export async function leaveThread(threadChannelId: string): Promise<void> {
	const userId = Authentication.currentUserId;
	if (userId) {
		ThreadMembers.removeMember(threadChannelId, userId);
	}
	try {
		await http.delete(Endpoints.CHANNEL_THREAD_MEMBER_ME(threadChannelId));
	} catch (error) {
		logger.error(`Failed to leave thread ${threadChannelId}:`, error);
		void listThreadMembers(threadChannelId);
		throw error;
	}
}

// Echowire: add another member to a thread. The server decides who may do this (owner, moderator,
// an invitable private thread's member, or anyone who may post in a public thread) and refuses a
// target who cannot see the parent channel, so the caller surfaces the failure rather than guessing.
export async function addThreadMember(threadChannelId: string, userId: string): Promise<void> {
	try {
		await http.put(Endpoints.CHANNEL_THREAD_MEMBER(threadChannelId, userId));
		ThreadMembers.addMember(threadChannelId, {userId, joinTimestamp: new Date().toISOString()});
	} catch (error) {
		logger.error(`Failed to add ${userId} to thread ${threadChannelId}:`, error);
		void listThreadMembers(threadChannelId);
		throw error;
	}
}

// Echowire: remove another member from a thread. Removing yourself is a leave, which has its own
// command, so this is for moderators and the thread owner.
export async function removeThreadMember(threadChannelId: string, userId: string): Promise<void> {
	ThreadMembers.removeMember(threadChannelId, userId);
	try {
		await http.delete(Endpoints.CHANNEL_THREAD_MEMBER(threadChannelId, userId));
	} catch (error) {
		logger.error(`Failed to remove ${userId} from thread ${threadChannelId}:`, error);
		void listThreadMembers(threadChannelId);
		throw error;
	}
}

// Echowire: fetch one thread member. Answers 404 when the user is not a member, which callers use
// to tell "not a member" from "cannot see the thread".
export async function fetchThreadMember(threadChannelId: string, userId: string): Promise<boolean> {
	try {
		await http.get(Endpoints.CHANNEL_THREAD_MEMBER(threadChannelId, userId));
		return true;
	} catch {
		return false;
	}
}

// Echowire: append an attachment already on a reply to the post's starter message, where it becomes
// the card thumbnail (forums phase 2 contract, section 2). The route answers with the post, whose
// starter_message_preview already carries the new thumbnail, so the card updates from the response.
export async function addAttachmentToStarterMessage(
	postChannelId: string,
	messageId: string,
	attachmentId: string,
): Promise<void> {
	const response = await http.post<Channel>(Endpoints.CHANNEL_STARTER_MESSAGE_ATTACHMENTS(postChannelId), {
		body: {message_id: messageId, attachment_id: attachmentId},
	});
	Channels.handleChannelUpdateBulk({channels: [response.body]});
	ForumPostPreviews.ingest([response.body as {id: string; starter_message_preview?: WireStarterMessagePreview | null}]);
}
