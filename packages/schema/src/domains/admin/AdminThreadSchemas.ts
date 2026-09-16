// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: admin views and actions for threads and forum posts. The platform admin needs to see
// them under their parent channel and moderate them without going through a guild member account.

import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const AdminThreadSummary = z.object({
	id: SnowflakeStringType.describe('Thread or forum post ID'),
	guild_id: SnowflakeStringType.describe('Guild the thread belongs to'),
	parent_id: SnowflakeStringType.nullable().describe('Parent text or forum channel ID'),
	parent_name: z.string().nullable().describe('Name of the parent channel, when it still exists'),
	name: z.string().nullable().describe('Thread or post title'),
	type: z.number().int().describe('Channel type: 11 public thread, 12 private thread'),
	owner_id: SnowflakeStringType.nullable().describe('User who created the thread'),
	archived: z.boolean().describe('Whether the thread is archived'),
	locked: z.boolean().describe('Whether the thread is locked to moderators'),
	pinned: z.boolean().describe('Whether the forum post is pinned in its forum'),
	message_count: z.number().int().nullable().describe('Replies in the thread, excluding a forum post starter'),
	member_count: z.number().int().nullable().describe('Members who have joined the thread'),
	auto_archive_duration: z.number().int().nullable().describe('Inactivity minutes before auto archive'),
	archive_timestamp: z.string().nullable().describe('ISO 8601 timestamp of the last archive state change'),
	create_timestamp: z.string().nullable().describe('ISO 8601 timestamp when the thread was created'),
	applied_tags: z.array(SnowflakeStringType).max(20).nullable().describe('Forum tag IDs applied to the post'),
});

export type AdminThreadSummary = z.infer<typeof AdminThreadSummary>;

export const ListChannelThreadsResponse = z.object({
	threads: z.array(AdminThreadSummary).max(1000).describe('Threads under the channel, newest first'),
});

export type ListChannelThreadsResponse = z.infer<typeof ListChannelThreadsResponse>;

export const AdminThreadResponse = z.object({
	thread: AdminThreadSummary.describe('The thread after the update'),
});

export type AdminThreadResponse = z.infer<typeof AdminThreadResponse>;

export const UpdateAdminThreadRequest = z
	.object({
		archived: z.boolean().optional().describe('Archive or unarchive the thread'),
		locked: z.boolean().optional().describe('Lock or unlock the thread'),
	})
	.refine((body) => body.archived !== undefined || body.locked !== undefined, {
		message: 'At least one of archived or locked is required',
	});

export type UpdateAdminThreadRequest = z.infer<typeof UpdateAdminThreadRequest>;
