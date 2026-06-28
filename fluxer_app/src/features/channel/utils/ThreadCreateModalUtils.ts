// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: create a thread from the UI, then navigate into it.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';

export type AutoArchiveDuration = 60 | 1440 | 4320 | 10080;

export interface ThreadFormInputs {
	name: string;
	autoArchiveDuration: string;
}

export const AUTO_ARCHIVE_OPTIONS: Array<{value: AutoArchiveDuration; name: string}> = [
	{value: 60, name: '1 hour'},
	{value: 1440, name: '1 day'},
	{value: 4320, name: '3 days'},
	{value: 10080, name: '1 week'},
];

export async function createThread(
	guildId: string,
	parentChannelId: string,
	data: ThreadFormInputs,
	starterMessageId?: string,
): Promise<void> {
	const thread = await ThreadCommands.createThread(parentChannelId, {
		name: data.name,
		auto_archive_duration: Number(data.autoArchiveDuration) as AutoArchiveDuration,
		message_id: starterMessageId,
	});
	setTimeout(() => {
		selectChannel(guildId, thread.id);
	}, 50);
	ModalCommands.pop();
}

export function getDefaultValues(): ThreadFormInputs {
	return {name: '', autoArchiveDuration: '1440'};
}
