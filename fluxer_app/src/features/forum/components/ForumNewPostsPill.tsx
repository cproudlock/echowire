// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the "N New" pill beside a forum or media channel in the channel list. Upstream marks an unread forum
// with a dot; this adds the count of posts started since the forum was last visited. It renders
// nothing unless upstream already treats the forum as unread, so the new-posts setting and the
// acking rules stay upstream's.

import Authentication from '@app/features/auth/state/Authentication';
import type {Channel} from '@app/features/channel/models/Channel';
import styles from '@app/features/forum/components/ForumNewPostsPill.module.css';
import {hasForumUnread} from '@app/features/forum/state/ForumReadState';
import {FORUM_NEW_POSTS_DESCRIPTOR} from '@app/features/forum/utils/ForumEchowireDescriptors';
import {countNewForumPosts} from '@app/features/forum/utils/ForumNewPostCount';
import ReadStates from '@app/features/read_state/state/ReadStates';
import ChannelThreads from '@app/features/threads/state/ChannelThreads';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

export const ForumNewPostsPill = observer(({forum}: {forum: Channel}) => {
	const {i18n} = useLingui();
	if (!forum.isThreadOnly() || !hasForumUnread(forum)) return null;
	const state = ReadStates.get(forum.id);
	const ackId = state.ackMessageId ?? SnowflakeUtils.fromTimestamp(state.ackTimestamp);
	const count = countNewForumPosts(
		ChannelThreads.getThreadsForParent(forum.id).map((post) => ({
			id: post.id,
			ownerId: post.ownerId,
			archived: post.isArchived,
		})),
		ackId,
		Authentication.currentUserId,
	);
	if (count === 0) return null;
	return (
		<span className={styles.pill} data-flx="forum.forum-new-posts-pill">
			{i18n._(FORUM_NEW_POSTS_DESCRIPTOR, {count})}
		</span>
	);
});
