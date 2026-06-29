// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: forum channel body (re-ported from the old fork). Renders a post grid (each post is a
// thread under the GUILD_FORUM channel) with search, tag filter, sort, an Active/Archived toggle,
// and a New Post button — instead of a message stream.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import type {Channel} from '@app/features/channel/models/Channel';
import {CreateForumPostModal} from '@app/features/channel/components/modals/CreateForumPostModal';
import Channels from '@app/features/channel/state/Channels';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import Users from '@app/features/user/state/Users';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';
import {
	ArchiveIcon,
	ChatCircleIcon,
	ClockIcon,
	FunnelIcon,
	PlusIcon,
	PushPinIcon,
	SortAscendingIcon,
} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useState} from 'react';

type SortMode = 'recent_activity' | 'date_posted';

function formatRelativeTime(ms: number): string {
	const diff = Date.now() - ms;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(ms).toLocaleDateString();
}

const ForumPostCard = observer(
	({channel, thread, onClick}: {channel: Channel; thread: Channel; onClick: () => void}) => {
		const author = thread.ownerId ? Users.getUser(thread.ownerId) : null;
		const replyCount = thread.messageCount ?? 0;
		const lastActivityMs = thread.lastMessageId
			? SnowflakeUtils.extractTimestamp(thread.lastMessageId)
			: SnowflakeUtils.extractTimestamp(thread.id);
		const tagsById = new Map(channel.availableTags.map((tag) => [tag.id, tag]));
		const resolvedTags = thread.appliedTags.map((id) => tagsById.get(id)).filter((t) => t != null);
		return (
			<button
				type="button"
				onClick={onClick}
				aria-label={`Post: ${thread.name ?? 'post'}`}
				data-flx="channel.forum-post-card"
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: 8,
					width: '100%',
					textAlign: 'left',
					padding: 16,
					borderRadius: 8,
					border: 'none',
					background: 'var(--background-secondary)',
					cursor: 'pointer',
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.background = 'var(--background-secondary-alt, var(--background-modifier-hover))';
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.background = 'var(--background-secondary)';
				}}
			>
				{resolvedTags.length > 0 && (
					<div style={{display: 'flex', flexWrap: 'wrap', gap: 4}}>
						{resolvedTags.map((tag) => (
							<span
								key={tag!.id}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 4,
									padding: '2px 8px',
									borderRadius: 999,
									background: 'var(--background-tertiary, var(--background-floating))',
									color: 'var(--text-muted)',
									fontSize: 11,
									fontWeight: 600,
								}}
							>
								{tag!.emojiName && <span>{tag!.emojiName}</span>}
								{tag!.name}
							</span>
						))}
					</div>
				)}
				<div style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 16, fontWeight: 600, color: 'var(--text-normal)'}}>
					{thread.pinned && <PushPinIcon size={14} weight="fill" style={{color: 'var(--text-muted)', flexShrink: 0}} />}
					{thread.name ?? 'post'}
				</div>
				<div style={{display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-muted)', fontSize: 12}}>
					{author && <span style={{fontWeight: 600}}>{author.displayName}</span>}
					<span style={{display: 'flex', alignItems: 'center', gap: 4}}>
						<ChatCircleIcon size={14} />
						{replyCount} {replyCount === 1 ? 'reply' : 'replies'}
					</span>
					<span style={{display: 'flex', alignItems: 'center', gap: 4}}>
						<ClockIcon size={14} />
						{formatRelativeTime(lastActivityMs)}
					</span>
				</div>
			</button>
		);
	},
);

export const ForumChannelView = observer(({channel}: {channel: Channel}) => {
	const [searchQuery, setSearchQuery] = useState('');
	const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
	const [sortMode, setSortMode] = useState<SortMode>('recent_activity');
	const [showArchived, setShowArchived] = useState(false);
	const guildId = channel.guildId;

	useEffect(() => {
		void ThreadCommands.listActiveThreads(channel.id).catch(() => {});
	}, [channel.id]);
	useEffect(() => {
		if (showArchived) {
			void ThreadCommands.listArchivedThreads(channel.id).catch(() => {});
		}
	}, [showArchived, channel.id]);

	const threads = guildId
		? Channels.getGuildChannels(guildId).filter(
				(c) => c.parentId === channel.id && THREAD_CHANNEL_TYPES.has(c.type),
			)
		: [];

	const filtered = useMemo(() => {
		let result = threads.filter((t) =>
			showArchived ? t.threadMetadata?.archived === true : !t.threadMetadata?.archived,
		);
		const query = searchQuery.trim().toLowerCase();
		if (query) {
			result = result.filter((t) => t.name?.toLowerCase().includes(query));
		}
		if (selectedTagIds.size > 0) {
			result = result.filter((t) => t.appliedTags.some((id) => selectedTagIds.has(id)));
		}
		return [...result].sort((a, b) => {
			// Pinned posts always sort to the top.
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			const at =
				sortMode === 'recent_activity' && a.lastMessageId
					? SnowflakeUtils.extractTimestamp(a.lastMessageId)
					: SnowflakeUtils.extractTimestamp(a.id);
			const bt =
				sortMode === 'recent_activity' && b.lastMessageId
					? SnowflakeUtils.extractTimestamp(b.lastMessageId)
					: SnowflakeUtils.extractTimestamp(b.id);
			return bt - at;
		});
	}, [threads, showArchived, searchQuery, selectedTagIds, sortMode]);

	if (!guildId) {
		return null;
	}
	return (
		<div
			data-flx="channel.forum-channel-view"
			style={{display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden'}}
		>
			<div style={{display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px'}}>
				<input
					type="text"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					placeholder="Search or create a post..."
					style={{
						flex: 1,
						padding: '8px 12px',
						borderRadius: 6,
						border: 'none',
						background: 'var(--background-tertiary, var(--background-secondary))',
						color: 'var(--text-normal)',
						fontSize: 14,
					}}
				/>
				<button
					type="button"
					onClick={() => setSortMode(sortMode === 'recent_activity' ? 'date_posted' : 'recent_activity')}
					title={sortMode === 'recent_activity' ? 'Recent Activity' : 'Date Posted'}
					style={pillStyle(false)}
				>
					<SortAscendingIcon size={16} />
					{sortMode === 'recent_activity' ? 'Recent' : 'Newest'}
				</button>
				<button type="button" onClick={() => setShowArchived(!showArchived)} style={pillStyle(showArchived)}>
					<ArchiveIcon size={16} />
					{showArchived ? 'Archived' : 'Active'}
				</button>
				{!showArchived && (
					<button
						type="button"
						onClick={() => ModalCommands.push(modal(() => <CreateForumPostModal channel={channel} />))}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 4,
							padding: '8px 12px',
							borderRadius: 6,
							border: 'none',
							background: 'var(--brand-experiment, #5865f2)',
							color: 'white',
							fontSize: 13,
							fontWeight: 600,
							cursor: 'pointer',
						}}
					>
						<PlusIcon size={14} weight="bold" />
						New Post
					</button>
				)}
			</div>
			{channel.availableTags.length > 0 && (
				<div style={{display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '0 16px 12px'}}>
					<FunnelIcon size={16} style={{color: 'var(--text-muted)', flexShrink: 0}} />
					{channel.availableTags.map((tag) => {
						const active = selectedTagIds.has(tag.id);
						return (
							<button
								key={tag.id}
								type="button"
								onClick={() =>
									setSelectedTagIds((prev) => {
										const next = new Set(prev);
										if (next.has(tag.id)) next.delete(tag.id);
										else next.add(tag.id);
										return next;
									})
								}
								style={pillStyle(active)}
							>
								{tag.emojiName && <span>{tag.emojiName}</span>}
								{tag.name}
							</button>
						);
					})}
				</div>
			)}
			<div style={{display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px 16px', overflowY: 'auto'}}>
				{filtered.length === 0 ? (
					<div style={{padding: '48px 16px', textAlign: 'center', color: 'var(--text-muted)'}}>
						<div style={{fontSize: 16, fontWeight: 600, marginBottom: 4}}>
							{showArchived ? 'No archived posts' : 'No posts yet'}
						</div>
						<div style={{fontSize: 13}}>
							{showArchived
								? 'Inactive posts will appear here.'
								: 'Be the first to start a discussion in this forum.'}
						</div>
					</div>
				) : (
					filtered.map((thread) => (
						<ForumPostCard
							key={thread.id}
							channel={channel}
							thread={thread}
							onClick={() => selectChannel(guildId, thread.id)}
						/>
					))
				)}
			</div>
		</div>
	);
});

function pillStyle(active: boolean): React.CSSProperties {
	return {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '8px 12px',
		borderRadius: 6,
		border: 'none',
		background: active ? 'var(--brand-experiment, #5865f2)' : 'var(--background-tertiary, var(--background-secondary))',
		color: active ? 'white' : 'var(--text-muted)',
		fontSize: 13,
		fontWeight: 600,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	};
}
