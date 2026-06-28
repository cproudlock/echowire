// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: active (and on demand, archived) threads nested under their parent
// text channel in the sidebar. Self-contained + additive: renders nothing unless
// the channel is a guild text channel with threads, so it can't affect the list.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import type {Guild} from '@app/features/guild/models/Guild';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {ArchiveIcon, ChatCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

function ThreadRow({
	guild,
	thread,
	isSelected,
	muted,
}: {
	guild: Guild;
	thread: Channel;
	isSelected: boolean;
	muted?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={() => selectChannel(guild.id, thread.id)}
			aria-label={`Thread: ${thread.name ?? 'thread'}`}
			aria-current={isSelected ? 'page' : undefined}
			data-flx="app.channel-list-content.channel-thread-list.thread"
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				width: '100%',
				padding: '3px 8px 3px 38px',
				background: isSelected ? 'var(--background-modifier-selected, rgba(255,255,255,0.08))' : 'none',
				border: 'none',
				color: isSelected
					? 'var(--text-primary, #f2f3f5)'
					: muted
						? 'var(--text-muted, #6d7178)'
						: 'var(--text-tertiary, #8a8f98)',
				cursor: 'pointer',
				font: 'inherit',
				fontSize: 13,
				fontWeight: isSelected ? 600 : 400,
				fontStyle: muted ? 'italic' : 'normal',
				lineHeight: '20px',
				textAlign: 'left',
				borderRadius: 4,
			}}
		>
			<ChatCircleIcon size={14} weight={isSelected ? 'fill' : 'regular'} />
			<span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
				{thread.name ?? 'thread'}
			</span>
		</button>
	);
}

export const ChannelThreadList = observer(
	({guild, channel, selectedChannelId}: {guild: Guild; channel: Channel; selectedChannelId?: string | null}) => {
		const [showArchived, setShowArchived] = useState(false);
		const isTextChannel = channel.type === ChannelTypes.GUILD_TEXT;

		useEffect(() => {
			if (!isTextChannel) return;
			void ThreadCommands.listActiveThreads(channel.id).catch(() => {});
		}, [channel.id, isTextChannel]);

		useEffect(() => {
			if (!isTextChannel || !showArchived) return;
			void ThreadCommands.listArchivedThreads(channel.id).catch(() => {});
		}, [showArchived, channel.id, isTextChannel]);

		if (!isTextChannel) {
			return null;
		}
		const allThreads = Channels.getGuildChannels(guild.id).filter(
			(c) => c.parentId === channel.id && THREAD_CHANNEL_TYPES.has(c.type),
		);
		const activeThreads = allThreads.filter((c) => !c.threadMetadata?.archived);
		const archivedThreads = allThreads.filter((c) => c.threadMetadata?.archived === true);
		if (activeThreads.length === 0 && archivedThreads.length === 0 && !showArchived) {
			return null;
		}
		return (
			<div data-flx="app.channel-list-content.channel-thread-list">
				{activeThreads.map((thread) => (
					<ThreadRow key={thread.id} guild={guild} thread={thread} isSelected={selectedChannelId === thread.id} />
				))}
				{(activeThreads.length > 0 || archivedThreads.length > 0 || showArchived) && (
					<button
						type="button"
						onClick={() => setShowArchived((value) => !value)}
						aria-label={showArchived ? 'Hide archived threads' : 'Show archived threads'}
						data-flx="app.channel-list-content.channel-thread-list.toggle-archived"
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 6,
							width: '100%',
							padding: '2px 8px 2px 38px',
							background: 'none',
							border: 'none',
							color: 'var(--text-muted, #6d7178)',
							cursor: 'pointer',
							font: 'inherit',
							fontSize: 12,
							lineHeight: '18px',
							textAlign: 'left',
						}}
					>
						<ArchiveIcon size={12} />
						<span>{showArchived ? 'Hide archived' : 'Show archived'}</span>
					</button>
				)}
				{showArchived &&
					archivedThreads.map((thread) => (
						<ThreadRow
							key={thread.id}
							guild={guild}
							thread={thread}
							isSelected={selectedChannelId === thread.id}
							muted
						/>
					))}
			</div>
		);
	},
);
