// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the head of an open forum post, above the starter message in the scroller. A large
// speech-bubble icon, the title, the applied tags, then a date divider. Under the starter message
// sits the action bar: the author avatar, React to Post (which uses the forum's default reaction
// when it has one), Follow and a copy-link button.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import styles from '@app/features/channel/components/forum/ForumPostIntro.module.css';
import {ForumTagChip} from '@app/features/channel/components/forum/ForumTagChip';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ForumPostPreviews from '@app/features/channel/state/ForumPostPreviews';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import {getForumPostCreatedAt} from '@app/features/channel/utils/ForumPostUtils';
import {EmojiPickerPopout} from '@app/features/emoji/components/popouts/EmojiPickerPopout';
import {COPY_LINK_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as ReactionCommands from '@app/features/messaging/commands/ReactionCommands';
import {buildChannelLink} from '@app/features/messaging/utils/MessageLinkUtils';
import {toReactionEmoji} from '@app/features/messaging/utils/MessageReactionUtils';
import * as PopoutCommands from '@app/features/ui/commands/PopoutCommands';
import * as TextCopyCommands from '@app/features/ui/commands/TextCopyCommands';
import Users from '@app/features/user/state/Users';
import {getUserAvatarURL} from '@app/features/user/utils/AvatarUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {BellIcon, ChatsCircleIcon, CheckIcon, LinkSimpleIcon, SmileyIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useRef} from 'react';

const REACT_TO_POST_DESCRIPTOR = msg({
	message: 'React to Post',
	comment: 'Button under the first message of a forum post that reacts to it.',
});
const FOLLOW_DESCRIPTOR = msg({message: 'Follow', comment: 'Button that follows a forum post.'});
const FOLLOWING_DESCRIPTOR = msg({
	message: 'Following',
	comment: 'State of the follow button when the viewer already follows the post.',
});

interface ForumPostIntroProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> {
	channel: Channel;
}

export const ForumPostIntro = observer(({channel: post, ...divProps}: ForumPostIntroProps) => {
	const {i18n} = useLingui();
	const reactButtonRef = useRef<HTMLButtonElement>(null);
	const forum = post.parentId ? Channels.getChannel(post.parentId) : undefined;
	if (!forum?.isForum()) {
		return null;
	}
	const preview = ForumPostPreviews.get(post.id);
	const starterMessageId = preview?.messageId ?? post.id;
	const tagsById = new Map(forum.availableTags.map((tag) => [tag.id, tag]));
	const tags = post.appliedTags.map((id) => tagsById.get(id)).filter((tag) => tag != null);
	const following = ThreadMembers.isMember(post.id);
	const authorId = preview?.author?.id ?? post.ownerId;
	const cachedUser = authorId ? Users.getUser(authorId) : undefined;
	const avatarUrl = authorId
		? getUserAvatarURL({id: authorId, avatar: preview?.author?.avatar ?? cachedUser?.avatar ?? null})
		: null;
	const createdAt = new Date(getForumPostCreatedAt(post));
	const dateLabel = new Intl.DateTimeFormat(i18n.locale, {dateStyle: 'long'}).format(createdAt);

	const reactWithDefault = () => {
		const defaultEmoji = forum.defaultReactionEmoji;
		if (defaultEmoji?.emojiName) {
			ReactionCommands.addReaction(
				i18n,
				post.id,
				starterMessageId,
				toReactionEmoji({id: defaultEmoji.emojiId ?? null, name: defaultEmoji.emojiName}),
			);
			return;
		}
		if (!reactButtonRef.current) return;
		PopoutCommands.open({
			key: `forum_post_react-${post.id}`,
			position: 'top-start',
			render: ({onClose}) => (
				<EmojiPickerPopout
					channelId={post.id}
					handleSelect={(emoji) => {
						ReactionCommands.addReaction(i18n, post.id, starterMessageId, toReactionEmoji(emoji));
						onClose();
					}}
					onClose={onClose}
					data-flx="channel.forum-post-intro.emoji-picker-popout"
				/>
			),
			target: reactButtonRef.current,
			shouldAutoUpdate: false,
			animationType: 'none',
		});
	};

	return (
		<div className={styles.root} data-flx="channel.forum-post-intro" {...divProps}>
			<div className={styles.header}>
				<ChatsCircleIcon size={48} weight="fill" className={styles.icon} />
				<h1 className={styles.title}>{post.name}</h1>
				{tags.length > 0 && (
					<div className={styles.tags}>
						{tags.map((tag) => (
							<ForumTagChip key={tag.id} tag={tag} size="small" />
						))}
					</div>
				)}
			</div>
			<div className={styles.dateDivider} data-flx="channel.forum-post-intro.date-divider">
				<span className={styles.dateLabel}>{dateLabel}</span>
			</div>
			<div className={styles.actionBar} data-flx="channel.forum-post-intro.action-bar">
				{avatarUrl && <img src={avatarUrl} alt="" className={styles.avatar} />}
				<button
					type="button"
					ref={reactButtonRef}
					onClick={reactWithDefault}
					className={styles.reactButton}
					data-flx="channel.forum-post-intro.react-to-post"
				>
					<SmileyIcon size={18} />
					<span>{i18n._(REACT_TO_POST_DESCRIPTOR)}</span>
				</button>
				<div className={styles.spacer} />
				<button
					type="button"
					onClick={() =>
						void (following ? ThreadCommands.leaveThread(post.id) : ThreadCommands.joinThread(post.id)).catch(() => {})
					}
					aria-pressed={following}
					className={clsx(styles.followButton, following && styles.followButtonActive)}
					data-flx="channel.forum-post-intro.follow"
				>
					{following ? <CheckIcon size={16} weight="bold" /> : <BellIcon size={16} />}
					<span>{i18n._(following ? FOLLOWING_DESCRIPTOR : FOLLOW_DESCRIPTOR)}</span>
				</button>
				<button
					type="button"
					onClick={() =>
						void TextCopyCommands.copy(i18n, buildChannelLink({guildId: post.guildId ?? null, channelId: post.id}))
					}
					aria-label={i18n._(COPY_LINK_DESCRIPTOR)}
					title={i18n._(COPY_LINK_DESCRIPTOR)}
					className={styles.iconButton}
					data-flx="channel.forum-post-intro.copy-link"
				>
					<LinkSimpleIcon size={16} />
				</button>
			</div>
			<div className={styles.separator} aria-hidden={true} />
		</div>
	);
});
