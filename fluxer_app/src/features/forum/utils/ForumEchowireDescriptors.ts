// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: copy for the forum extras listed in docs/upstream-divergence.md. Kept out of
// upstream's ForumMessageDescriptors so an upstream sync never touches it.

import {msg} from '@lingui/core/macro';

export const FORUM_NEW_POSTS_DESCRIPTOR = msg({
	message: '{count} New',
	comment:
		'Pill beside a forum channel in the channel list: how many posts have new activity since the user last visited.',
});

export const FORUM_PARTICIPANTS_DESCRIPTOR = msg({
	message: 'Recent participants',
	comment: 'Accessible label for the row of member avatars on a forum post card.',
});

export const FORUM_SEE_EXAMPLES_DESCRIPTOR = msg({
	message: 'See Examples',
	comment: 'Button on an empty forum that lists example first posts.',
});

export const FORUM_EXAMPLES_TITLE_DESCRIPTOR = msg({
	message: 'Post ideas',
	comment: 'Title of the sheet listing example first posts for an empty forum.',
});

export const FORUM_EXAMPLES_INTRO_DESCRIPTOR = msg({
	message: 'Pick one to start a post, or write your own.',
	comment: 'Introduction above the example post ideas.',
});

export const FORUM_EXAMPLE_IDEA_DESCRIPTORS = [
	msg({message: 'Introduce yourself', comment: 'Example forum post idea.'}),
	msg({message: 'Ask for help with something', comment: 'Example forum post idea.'}),
	msg({message: 'Share something you made', comment: 'Example forum post idea.'}),
	msg({message: 'Start a discussion', comment: 'Example forum post idea.'}),
	msg({message: 'Suggest an improvement', comment: 'Example forum post idea.'}),
];
