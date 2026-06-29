// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: THREAD_MEMBERS_UPDATE — keep the membership store and the thread's member_count in sync.

import Channels from '@app/features/channel/state/Channels';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';

interface ThreadMembersUpdatePayload {
	id: string;
	guild_id?: string;
	member_count?: number;
	added_members?: Array<{user_id: string; join_timestamp?: string}>;
	removed_member_ids?: Array<string>;
}

export function handleThreadMembersUpdate(data: ThreadMembersUpdatePayload): void {
	for (const member of data.added_members ?? []) {
		ThreadMembers.addMember(data.id, {
			userId: member.user_id,
			joinTimestamp: member.join_timestamp ?? new Date().toISOString(),
		});
	}
	for (const userId of data.removed_member_ids ?? []) {
		ThreadMembers.removeMember(data.id, userId);
	}
	if (data.member_count != null) {
		const channel = Channels.getChannel(data.id);
		if (channel && channel.memberCount !== data.member_count) {
			Channels.handleChannelCreate({channel: channel.withUpdates({member_count: data.member_count}).toJSON()});
		}
	}
}
