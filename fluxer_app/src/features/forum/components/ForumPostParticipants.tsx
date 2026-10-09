// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: a small row of member avatars on a forum post card. Upstream's card shows no faces;
// this reads the post's member_ids_preview (the most recently joined members, newest first, which
// includes anyone who replied because replying joins the post) and shows the first few that the
// client already knows. It is not a list of everyone who posted.

import type {Channel} from '@app/features/channel/models/Channel';
import styles from '@app/features/forum/components/ForumPostParticipants.module.css';
import {FORUM_PARTICIPANTS_DESCRIPTOR} from '@app/features/forum/utils/ForumEchowireDescriptors';
import {AvatarStack} from '@app/features/ui/avatars/AvatarStack';
import type {User} from '@app/features/user/models/User';
import Users from '@app/features/user/state/Users';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

export const MAX_POST_PARTICIPANT_AVATARS = 3;
const AVATAR_SIZE_PX = 20;

export const ForumPostParticipants = observer(({post}: {post: Channel}) => {
	const {i18n} = useLingui();
	const users = post.memberIdsPreview
		.map((id) => Users.getUser(id))
		.filter((user): user is User => user != null)
		.slice(0, MAX_POST_PARTICIPANT_AVATARS);
	if (users.length === 0) return null;
	return (
		<span
			className={styles.participants}
			role="img"
			aria-label={i18n._(FORUM_PARTICIPANTS_DESCRIPTOR)}
			data-flx="forum.forum-post-participants"
		>
			<AvatarStack
				users={users}
				size={AVATAR_SIZE_PX}
				maxVisible={MAX_POST_PARTICIPANT_AVATARS}
				guildId={post.guildId}
				channelId={post.id}
				enableProfileModal={false}
				showTooltips={false}
				data-flx="forum.forum-post-participants.avatar-stack"
			/>
		</span>
	);
});
