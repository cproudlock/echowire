// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: forum channel body. A search box that also starts a post, a filter row (Sort & View,
// tag chips that narrow the list, an "All" overflow picker, closed posts), and the posts as list
// cards or a gallery grid. Visiting the forum clears its sidebar "N New" count.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import styles from '@app/features/channel/components/forum/ForumChannelView.module.css';
import {ForumPostCard} from '@app/features/channel/components/forum/ForumPostCard';
import {ForumTagChip} from '@app/features/channel/components/forum/ForumTagChip';
import {CreateForumPostModal} from '@app/features/channel/components/modals/CreateForumPostModal';
import {ForumExamplesModal} from '@app/features/channel/components/modals/ForumExamplesModal';
import type {Channel} from '@app/features/channel/models/Channel';
import ForumViewPreferences from '@app/features/channel/state/ForumViewPreferences';
import {
	ForumLayout,
	ForumSortOrder,
	filterForumPosts,
	resolveForumLayout,
	resolveForumSortOrder,
	sortForumPosts,
} from '@app/features/channel/utils/ForumPostUtils';
import {getForumPosts, markForumViewed} from '@app/features/channel/utils/ForumReadState';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {CheckboxItem, MenuGroupLabel} from '@app/features/ui/action_menu/ContextMenu';
import {MenuGroup} from '@app/features/ui/action_menu/MenuGroup';
import {MenuItem} from '@app/features/ui/action_menu/MenuItem';
import {MenuItemRadio} from '@app/features/ui/action_menu/MenuItemRadio';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {
	ArchiveIcon,
	ArrowsDownUpIcon,
	CaretDownIcon,
	ChatsCircleIcon,
	MagnifyingGlassIcon,
	PlusIcon,
} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useState} from 'react';

// Tags beyond this many live in the "All" overflow picker.
const MAX_INLINE_TAGS = 8;

const SEARCH_PLACEHOLDER_DESCRIPTOR = msg({
	message: 'Search or create a post...',
	comment: 'Placeholder of the forum search box. Typing filters post titles; New Post uses the text as the title.',
});
const NEW_POST_DESCRIPTOR = msg({message: 'New Post', comment: 'Button that starts a new forum post.'});
const SORT_AND_VIEW_DESCRIPTOR = msg({
	message: 'Sort & View',
	comment: 'Forum button that opens sort order and layout choices.',
});
const SORT_BY_DESCRIPTOR = msg({message: 'Sort by', comment: 'Group label in the forum Sort & View menu.'});
const RECENTLY_ACTIVE_DESCRIPTOR = msg({
	message: 'Recently Active',
	comment: 'Forum sort option: posts with the newest messages first.',
});
const DATE_POSTED_DESCRIPTOR = msg({message: 'Date Posted', comment: 'Forum sort option: newest posts first.'});
const VIEW_AS_DESCRIPTOR = msg({message: 'View as', comment: 'Group label in the forum Sort & View menu.'});
const LIST_DESCRIPTOR = msg({message: 'List', comment: 'Forum layout option: one post per row.'});
const GALLERY_DESCRIPTOR = msg({message: 'Gallery', comment: 'Forum layout option: a grid of post cards with images.'});
const RESET_TO_DEFAULT_DESCRIPTOR = msg({
	message: 'Reset to default',
	comment: "Forum Sort & View item that returns to the forum's own default sort and layout.",
});
const ALL_TAGS_DESCRIPTOR = msg({message: 'All', comment: 'Forum button that lists every tag to filter by.'});
const CLEAR_TAGS_DESCRIPTOR = msg({
	message: 'Clear tags',
	comment: 'Forum tag picker item that removes every tag filter.',
});
const CLOSED_POSTS_DESCRIPTOR = msg({
	message: 'Closed posts',
	comment: 'Forum toggle that shows posts closed by a moderator or hidden after inactivity.',
});
const EMPTY_TITLE_DESCRIPTOR = msg({
	message: 'Be the first to start the conversation!',
	comment: 'Empty forum heading.',
});
const EMPTY_BODY_DESCRIPTOR = msg({
	message: 'What do you want to post about in #{name}?',
	comment: 'Empty forum prompt. {name} is the forum channel name.',
});
const SEE_EXAMPLES_DESCRIPTOR = msg({
	message: 'See Examples',
	comment: 'Button on an empty forum that lists example first posts.',
});
const NO_MATCHES_DESCRIPTOR = msg({
	message: 'No posts match your search or tags.',
	comment: 'Forum list message when filters hide every post.',
});
const NO_CLOSED_POSTS_DESCRIPTOR = msg({
	message: 'No closed posts.',
	comment: 'Forum list message when showing closed posts and there are none.',
});

function openMenuBelow(event: React.MouseEvent, render: (props: {onClose: () => void}) => React.ReactNode): void {
	event.preventDefault();
	const rect = event.currentTarget.getBoundingClientRect();
	ContextMenuCommands.openAtPoint(
		{x: rect.left, y: rect.bottom + 4},
		render,
		{align: 'top-left', trackDynamicPosition: true},
		event.currentTarget as HTMLElement,
	);
}

export const ForumChannelView = observer(({channel, selectedPostId}: {channel: Channel; selectedPostId?: string}) => {
	const {i18n} = useLingui();
	const [searchQuery, setSearchQuery] = useState('');
	const [selectedTagIds, setSelectedTagIds] = useState<ReadonlySet<string>>(new Set());
	const [showClosed, setShowClosed] = useState(false);
	const guildId = channel.guildId;

	useEffect(() => {
		void ThreadCommands.listActiveThreads(channel.id).catch(() => {});
		markForumViewed(channel);
		return () => markForumViewed(channel);
	}, [channel.id]);
	useEffect(() => {
		if (showClosed) {
			void ThreadCommands.listArchivedThreads(channel.id).catch(() => {});
		}
	}, [showClosed, channel.id]);

	const override = ForumViewPreferences.getOverride(channel.id);
	const sortOrder = override.sortOrder ?? resolveForumSortOrder(channel.defaultSortOrder);
	const layout = override.layout ?? resolveForumLayout(channel.defaultForumLayout);
	const posts = getForumPosts(channel);
	const visiblePosts = useMemo(
		() =>
			sortForumPosts(
				filterForumPosts(posts, {archived: showClosed, query: searchQuery, tagIds: selectedTagIds}),
				sortOrder,
			),
		[posts, showClosed, searchQuery, selectedTagIds, sortOrder],
	);

	if (!guildId) {
		return null;
	}

	const openCreatePost = () =>
		ModalCommands.push(modal(() => <CreateForumPostModal channel={channel} initialTitle={searchQuery.trim()} />));
	const toggleTag = (tagId: string) =>
		setSelectedTagIds((prev) => {
			const next = new Set(prev);
			if (next.has(tagId)) next.delete(tagId);
			else next.add(tagId);
			return next;
		});
	const inlineTags = channel.availableTags.slice(0, MAX_INLINE_TAGS);
	const hasOverflowTags = channel.availableTags.length > MAX_INLINE_TAGS;
	const overflowSelectedCount = channel.availableTags
		.slice(MAX_INLINE_TAGS)
		.filter((tag) => selectedTagIds.has(tag.id)).length;

	const openSortMenu = (event: React.MouseEvent) =>
		openMenuBelow(event, () => (
			<>
				<MenuGroup>
					<MenuGroupLabel>{i18n._(SORT_BY_DESCRIPTOR)}</MenuGroupLabel>
					<MenuItemRadio
						selected={sortOrder === ForumSortOrder.LATEST_ACTIVITY}
						onSelect={() => ForumViewPreferences.setSortOrder(channel.id, ForumSortOrder.LATEST_ACTIVITY)}
					>
						{i18n._(RECENTLY_ACTIVE_DESCRIPTOR)}
					</MenuItemRadio>
					<MenuItemRadio
						selected={sortOrder === ForumSortOrder.CREATION_DATE}
						onSelect={() => ForumViewPreferences.setSortOrder(channel.id, ForumSortOrder.CREATION_DATE)}
					>
						{i18n._(DATE_POSTED_DESCRIPTOR)}
					</MenuItemRadio>
				</MenuGroup>
				<MenuGroup>
					<MenuGroupLabel>{i18n._(VIEW_AS_DESCRIPTOR)}</MenuGroupLabel>
					<MenuItemRadio
						selected={layout === ForumLayout.LIST}
						onSelect={() => ForumViewPreferences.setLayout(channel.id, ForumLayout.LIST)}
					>
						{i18n._(LIST_DESCRIPTOR)}
					</MenuItemRadio>
					<MenuItemRadio
						selected={layout === ForumLayout.GALLERY}
						onSelect={() => ForumViewPreferences.setLayout(channel.id, ForumLayout.GALLERY)}
					>
						{i18n._(GALLERY_DESCRIPTOR)}
					</MenuItemRadio>
				</MenuGroup>
				<MenuGroup>
					<MenuItem onClick={() => ForumViewPreferences.resetOverride(channel.id)}>
						{i18n._(RESET_TO_DEFAULT_DESCRIPTOR)}
					</MenuItem>
				</MenuGroup>
			</>
		));

	const openAllTagsMenu = (event: React.MouseEvent) =>
		openMenuBelow(event, () => (
			<>
				<MenuGroup>
					{channel.availableTags.map((tag) => (
						<CheckboxItem key={tag.id} checked={selectedTagIds.has(tag.id)} onCheckedChange={() => toggleTag(tag.id)}>
							{tag.emojiName ? `${tag.emojiName} ${tag.name}` : tag.name}
						</CheckboxItem>
					))}
				</MenuGroup>
				{selectedTagIds.size > 0 && (
					<MenuGroup>
						<MenuItem onClick={() => setSelectedTagIds(new Set())}>{i18n._(CLEAR_TAGS_DESCRIPTOR)}</MenuItem>
					</MenuGroup>
				)}
			</>
		));

	const filtersActive = searchQuery.trim().length > 0 || selectedTagIds.size > 0;
	const forumIsEmpty = posts.length === 0 && !showClosed;

	return (
		<div className={styles.root} data-flx="channel.forum-channel-view">
			<div className={styles.toolbar}>
				<div className={styles.searchBox}>
					<MagnifyingGlassIcon size={18} className={styles.searchIcon} />
					<input
						type="text"
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && searchQuery.trim().length > 0) {
								event.preventDefault();
								openCreatePost();
							}
						}}
						placeholder={i18n._(SEARCH_PLACEHOLDER_DESCRIPTOR)}
						aria-label={i18n._(SEARCH_PLACEHOLDER_DESCRIPTOR)}
						className={styles.searchInput}
						data-flx="channel.forum-channel-view.search"
					/>
					<button
						type="button"
						onClick={openCreatePost}
						className={styles.newPostButton}
						data-flx="channel.forum-channel-view.new-post"
					>
						<PlusIcon size={14} weight="bold" />
						<span>{i18n._(NEW_POST_DESCRIPTOR)}</span>
					</button>
				</div>
				<div className={styles.filterRow}>
					<button
						type="button"
						onClick={openSortMenu}
						className={styles.filterButton}
						aria-haspopup={true}
						data-flx="channel.forum-channel-view.sort-and-view"
					>
						<ArrowsDownUpIcon size={16} />
						<span>{i18n._(SORT_AND_VIEW_DESCRIPTOR)}</span>
						<CaretDownIcon size={12} weight="bold" />
					</button>
					{channel.availableTags.length > 0 && <span className={styles.divider} aria-hidden={true} />}
					{inlineTags.map((tag) => (
						<ForumTagChip
							key={tag.id}
							tag={tag}
							selected={selectedTagIds.has(tag.id)}
							onToggle={() => toggleTag(tag.id)}
						/>
					))}
					{channel.availableTags.length > 0 && (hasOverflowTags || selectedTagIds.size > 0) && (
						<button
							type="button"
							onClick={openAllTagsMenu}
							className={clsx(styles.filterButton, overflowSelectedCount > 0 && styles.filterButtonActive)}
							aria-haspopup={true}
							data-flx="channel.forum-channel-view.all-tags"
						>
							<span>{i18n._(ALL_TAGS_DESCRIPTOR)}</span>
							<CaretDownIcon size={12} weight="bold" />
						</button>
					)}
					<button
						type="button"
						onClick={() => setShowClosed((value) => !value)}
						aria-pressed={showClosed}
						className={clsx(styles.filterButton, styles.closedToggle, showClosed && styles.filterButtonActive)}
						data-flx="channel.forum-channel-view.closed-posts"
					>
						<ArchiveIcon size={16} />
						<span>{i18n._(CLOSED_POSTS_DESCRIPTOR)}</span>
					</button>
				</div>
			</div>
			<div className={styles.scroller}>
				{visiblePosts.length === 0 ? (
					<div className={styles.emptyState} data-flx="channel.forum-channel-view.empty">
						{forumIsEmpty ? (
							<>
								<ChatsCircleIcon size={40} weight="fill" className={styles.emptyIcon} />
								<div className={styles.emptyTitle}>{i18n._(EMPTY_TITLE_DESCRIPTOR)}</div>
								<div className={styles.emptyBody}>{i18n._(EMPTY_BODY_DESCRIPTOR, {name: channel.name ?? ''})}</div>
								<button
									type="button"
									onClick={() => ModalCommands.push(modal(() => <ForumExamplesModal channel={channel} />))}
									className={styles.emptyExamplesButton}
									data-flx="channel.forum-channel-view.see-examples"
								>
									{i18n._(SEE_EXAMPLES_DESCRIPTOR)}
								</button>
							</>
						) : (
							<div className={styles.emptyBody}>
								{showClosed && !filtersActive ? i18n._(NO_CLOSED_POSTS_DESCRIPTOR) : i18n._(NO_MATCHES_DESCRIPTOR)}
							</div>
						)}
					</div>
				) : (
					<div className={layout === ForumLayout.GALLERY ? styles.gallery : styles.list}>
						{visiblePosts.map((post) => (
							<ForumPostCard
								key={post.id}
								forum={channel}
								post={post}
								layout={layout}
								selected={post.id === selectedPostId}
								onOpen={() => selectChannel(guildId, post.id)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
});
