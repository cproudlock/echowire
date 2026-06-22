// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: client commands for Threads (re-ported from the old fork; backend endpoints
// POST/GET /channels/:id/threads, PATCH/DELETE /channels/:id/thread).

import {Endpoints} from '@app/features/app/constants/Endpoints';
import Channels from '@app/features/channel/state/Channels';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {Channel} from '@fluxer/schema/src/domains/channel/ChannelSchemas';

const logger = new Logger('Threads');

export interface CreateThreadParams {
	name: string;
	type?: typeof ChannelTypes.PUBLIC_THREAD | typeof ChannelTypes.PRIVATE_THREAD;
	auto_archive_duration?: 60 | 1440 | 4320 | 10080;
}

export interface UpdateThreadParams {
	name?: string;
	archived?: boolean;
	locked?: boolean;
	auto_archive_duration?: 60 | 1440 | 4320 | 10080;
	invitable?: boolean;
}

// Create a thread under a text/forum parent channel. Returns the created thread channel.
export async function createThread(parentChannelId: string, params: CreateThreadParams): Promise<Channel> {
	try {
		const response = await http.post<Channel>(Endpoints.CHANNEL_THREADS(parentChannelId), {body: params});
		const thread = response.body;
		Channels.handleChannelCreate({channel: thread});
		return thread;
	} catch (error) {
		logger.error(`Failed to create thread under ${parentChannelId}:`, error);
		throw error;
	}
}

// List the active (non-archived) threads under a text/forum parent channel.
export async function listActiveThreads(parentChannelId: string): Promise<Array<Channel>> {
	try {
		const response = await http.get<Array<Channel>>(Endpoints.CHANNEL_THREADS(parentChannelId));
		const threads = response.body ?? [];
		for (const thread of threads) {
			Channels.handleChannelCreate({channel: thread});
		}
		return threads;
	} catch (error) {
		logger.error(`Failed to list threads under ${parentChannelId}:`, error);
		throw error;
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
