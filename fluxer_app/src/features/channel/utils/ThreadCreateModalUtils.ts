// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: create a thread from the UI, then navigate into it.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';

export interface ThreadFormInputs {
	name: string;
}

export async function createThread(
	guildId: string,
	parentChannelId: string,
	data: ThreadFormInputs,
): Promise<void> {
	const thread = await ThreadCommands.createThread(parentChannelId, {name: data.name});
	setTimeout(() => {
		selectChannel(guildId, thread.id);
	}, 50);
	ModalCommands.pop();
}

export function getDefaultValues(): ThreadFormInputs {
	return {name: ''};
}
