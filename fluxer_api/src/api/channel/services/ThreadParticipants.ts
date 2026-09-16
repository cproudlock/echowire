// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: a thread keeps a rolling window of its most recent distinct message authors so a forum
// card can show participant avatars without reading each post's messages. It is written in the same
// patch that advances last_message_id, so it costs nothing to read back.

import type {UserID} from '@app/api/BrandedTypes';
import {MAX_RECENT_THREAD_PARTICIPANTS} from '@fluxer/constants/src/LimitConstants';

// Returns the window with this author moved to the front, or null when the window already starts
// with them and nothing needs writing.
export function nextRecentParticipants(
	current: ReadonlyArray<string> | null | undefined,
	authorId: UserID,
	max: number = MAX_RECENT_THREAD_PARTICIPANTS,
): Array<string> | null {
	const author = authorId.toString();
	const existing = current ?? [];
	if (existing[0] === author) {
		return null;
	}
	const withoutAuthor = existing.filter((id) => id !== author);
	return [author, ...withoutAuthor].slice(0, max);
}
