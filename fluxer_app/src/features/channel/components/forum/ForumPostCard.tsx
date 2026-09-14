// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: one forum post in the list or gallery. Tags above a title, a one-line preview of the
// starter message prefixed by its author in role colour, the author avatar, reply count and last
// activity, and a thumbnail when the starter message has an image. Previews come from the server
// (starter_message_preview); older servers show no preview rather than fetching per card.

import styles from '@app/features/channel/components/forum/ForumPostCard.module.css';
import {ForumTagChip} from '@app/features/channel/components/forum/ForumTagChip';
import {ThreadPostMenu} from '@app/features/channel/components/menus/ThreadPostMenu';
import type {Channel} from '@app/features/channel/models/Channel';
import ForumPostPreviews, {isImageAttachment} from '@app/features/channel/state/ForumPostPreviews';
import {ForumLayout, getForumPostLastActivityAt} from '@app/features/channel/utils/ForumPostUtils';
import GuildMembers from '@app/features/member/state/GuildMembers';
import ReadStates from '@app/features/read_state/state/ReadStates';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import Users from '@app/features/user/state/Users';
import {getUserAvatarURL} from '@app/features/user/utils/AvatarUtils';
import {formatShortRelativeTime} from '@fluxer/date_utils/src/DateDuration';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ChatCircleIcon, LockIcon, PushPinIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const LAST_ACTIVITY_DESCRIPTOR = msg({
	message: '{time} ago',
	comment: 'Forum post card: time since the last message, for example "5m ago". {time} is a short duration.',
});
const REPLY_COUNT_ARIA_DESCRIPTOR = msg({
	message: '{count} replies',
	comment: 'Accessible label for the reply count on a forum post card.',
});

interface ForumPostCardProps {
	forum: Channel;
	post: Channel;
	layout: ForumLayout;
	onOpen: () => void;
}

export const ForumPostCard = observer(({forum, post, layout, onOpen}: ForumPostCardProps) => {
	const {i18n} = useLingui();
	const guildId = forum.guildId ?? '';
	const preview = ForumPostPreviews.get(post.id);
	const authorId = preview?.author?.id ?? post.ownerId;
	const member = authorId ? GuildMembers.getMember(guildId, authorId) : undefined;
	const cachedUser = authorId ? Users.getUser(authorId) : undefined;
	const authorName =
		member?.nick ??
		preview?.author?.globalName ??
		preview?.author?.username ??
		cachedUser?.displayName ??
		cachedUser?.username ??
		null;
	const avatarUrl = authorId
		? getUserAvatarURL({id: authorId, avatar: preview?.author?.avatar ?? cachedUser?.avatar ?? null})
		: null;
	const tagsById = new Map(forum.availableTags.map((tag) => [tag.id, tag]));
	const tags = post.appliedTags.map((id) => tagsById.get(id)).filter((tag) => tag != null);
	const thumbnail =
		preview?.firstAttachment && isImageAttachment(preview.firstAttachment)
			? (preview.firstAttachment.proxyUrl ?? preview.firstAttachment.url)
			: null;
	const unread = ReadStates.hasUnread(post.id);
	const replyCount = post.messageCount ?? 0;
	const lastActivity = i18n._(LAST_ACTIVITY_DESCRIPTOR, {
		time: formatShortRelativeTime(getForumPostLastActivityAt(post), '1m'),
	});
	const isGallery = layout === ForumLayout.GALLERY;

	const handleContextMenu = (event: React.MouseEvent) => {
		event.preventDefault();
		ContextMenuCommands.openFromEvent(event, ({onClose}) => <ThreadPostMenu thread={post} onClose={onClose} />);
	};

	return (
		<button
			type="button"
			onClick={onOpen}
			onContextMenu={handleContextMenu}
			className={clsx(styles.card, isGallery ? styles.galleryCard : styles.listCard, unread && styles.unread)}
			data-flx="channel.forum-post-card"
		>
			{isGallery && (
				<div className={styles.galleryMedia}>
					{thumbnail ? (
						<img src={thumbnail} alt="" loading="lazy" className={styles.galleryImage} />
					) : (
						<ChatCircleIcon size={32} weight="fill" className={styles.galleryPlaceholder} />
					)}
				</div>
			)}
			<div className={styles.body}>
				{tags.length > 0 && (
					<div className={styles.tags}>
						{tags.map((tag) => (
							<ForumTagChip key={tag.id} tag={tag} size="small" />
						))}
					</div>
				)}
				<div className={styles.titleRow}>
					{post.pinned && <PushPinIcon size={14} weight="fill" className={styles.stateIcon} />}
					{post.threadMetadata?.locked && <LockIcon size={14} weight="fill" className={styles.stateIcon} />}
					<span className={styles.title}>{post.name}</span>
				</div>
				{preview && preview.content.length > 0 && (
					<div className={styles.preview}>
						{authorName && (
							<span className={styles.previewAuthor} style={{color: member?.getColorString()}}>
								{`${authorName}: `}
							</span>
						)}
						<span>{preview.content}</span>
					</div>
				)}
				<div className={styles.footer}>
					{avatarUrl && <img src={avatarUrl} alt="" className={styles.avatar} />}
					<span className={styles.replies} title={i18n._(REPLY_COUNT_ARIA_DESCRIPTOR, {count: replyCount})}>
						<ChatCircleIcon size={14} weight="fill" />
						<span>{replyCount}</span>
					</span>
					<span className={styles.dot} aria-hidden={true} />
					<span>{lastActivity}</span>
				</div>
			</div>
			{!isGallery && thumbnail && <img src={thumbnail} alt="" loading="lazy" className={styles.listThumbnail} />}
		</button>
	);
});
