// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: an open forum post beside its forum's post list, the way Discord shows one. The list
// stays on the left with the open card highlighted; the post fills the right-hand pane with its own
// title bar, the "..." menu and a close button that returns to the full-width list. "Open in Full
// View" (a per-forum preference) and narrow viewports collapse the list away.

import {ForumChannelView} from '@app/features/channel/components/forum/ForumChannelView';
import styles from '@app/features/channel/components/forum/ForumSplitView.module.css';
import {ThreadPostMenu} from '@app/features/channel/components/menus/ThreadPostMenu';
import type {Channel} from '@app/features/channel/models/Channel';
import ForumViewPreferences from '@app/features/channel/state/ForumViewPreferences';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {DotsThreeIcon, XIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const POST_ACTIONS_DESCRIPTOR = msg({
	message: 'Post actions',
	comment: 'Accessible label of the "..." button in the header of an open forum post.',
});
const CLOSE_POST_DESCRIPTOR = msg({
	message: 'Close',
	comment: 'Accessible label of the button that closes an open forum post and returns to the post list.',
});

interface ForumSplitViewProps {
	forum: Channel;
	post: Channel;
	// The post body: the message stream and the composer, built by the channel view.
	children: React.ReactNode;
	// False when the list is hidden, either by the full-view preference or a narrow viewport.
	showList: boolean;
}

export const ForumSplitView = observer(({forum, post, children, showList}: ForumSplitViewProps) => {
	const {i18n} = useLingui();
	const closePost = () => {
		if (forum.guildId) selectChannel(forum.guildId, forum.id);
	};
	const openMenu = (event: React.MouseEvent) => {
		event.preventDefault();
		ContextMenuCommands.openFromEvent(event, ({onClose}) => (
			<ThreadPostMenu
				thread={post}
				onClose={onClose}
				fullView={ForumViewPreferences.isFullView(forum.id)}
				onToggleFullView={() => ForumViewPreferences.toggleFullView(forum.id)}
			/>
		));
	};

	return (
		<div className={styles.root} data-flx="channel.forum-split-view">
			{showList && (
				<div className={styles.listPane} data-flx="channel.forum-split-view.list-pane">
					<ForumChannelView channel={forum} selectedPostId={post.id} />
				</div>
			)}
			<div className={styles.postPane} data-flx="channel.forum-split-view.post-pane">
				<div className={styles.postHeader}>
					<span className={styles.postTitle} title={post.name ?? undefined}>
						{post.name}
					</span>
					<button
						type="button"
						onClick={openMenu}
						aria-label={i18n._(POST_ACTIONS_DESCRIPTOR)}
						title={i18n._(POST_ACTIONS_DESCRIPTOR)}
						className={styles.headerButton}
						data-flx="channel.forum-split-view.post-actions"
					>
						<DotsThreeIcon size={20} weight="bold" />
					</button>
					<button
						type="button"
						onClick={closePost}
						aria-label={i18n._(CLOSE_POST_DESCRIPTOR)}
						title={i18n._(CLOSE_POST_DESCRIPTOR)}
						className={styles.headerButton}
						data-flx="channel.forum-split-view.close"
					>
						<XIcon size={20} />
					</button>
				</div>
				<div className={styles.postBody}>{children}</div>
			</div>
		</div>
	);
});
