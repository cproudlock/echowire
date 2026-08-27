// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads popout (re-ported look from the old fork) — a dropdown from the
// channel header listing active / archived threads with a pill toggle.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import {ThreadCreateModal} from '@app/features/channel/components/modals/ThreadCreateModal';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import ReadStates from '@app/features/read_state/state/ReadStates';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {ArchiveIcon, ChatCircleIcon, LockIcon, PlusIcon, PushPinIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useState} from 'react';

export const ChannelThreadsPopout = observer(({channel, onClose}: {channel: Channel; onClose: () => void}) => {
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

	if (!guildId) {
		return null;
	}
	const allThreads = Channels.getGuildChannels(guildId).filter(
		(c) => c.parentId === channel.id && THREAD_CHANNEL_TYPES.has(c.type),
	);
	const threads = allThreads.filter((c) =>
		showArchived ? c.threadMetadata?.archived === true : !c.threadMetadata?.archived,
	);

	return (
		<div
			data-flx="channel.channel-threads-popout"
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: 320,
				maxHeight: 460,
				background: 'var(--form-surface-background)',
				borderRadius: 8,
				boxShadow: 'var(--shadow-high)',
				overflow: 'hidden',
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 8,
					padding: '10px 12px',
					borderBottom: '1px solid var(--background-modifier-accent)',
				}}
			>
				<div style={{display: 'flex', gap: 6}}>
					<PillButton active={!showArchived} onClick={() => setShowArchived(false)}>
						<ChatCircleIcon size={13} weight={!showArchived ? 'fill' : 'regular'} />
						Active
					</PillButton>
					<PillButton active={showArchived} onClick={() => setShowArchived(true)}>
						<ArchiveIcon size={13} />
						Archived
					</PillButton>
				</div>
				<button
					type="button"
					onClick={() => {
						ModalCommands.push(modal(() => <ThreadCreateModal guildId={guildId} parentChannelId={channel.id} />));
						onClose();
					}}
					aria-label="New thread"
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 4,
						padding: '4px 8px',
						borderRadius: 4,
						border: 'none',
						background: 'var(--brand-experiment, #5865f2)',
						color: 'white',
						fontSize: 12,
						fontWeight: 600,
						cursor: 'pointer',
					}}
				>
					<PlusIcon size={13} weight="bold" />
					New
				</button>
			</div>
			<div style={{overflowY: 'auto', padding: '4px 0'}}>
				{threads.length === 0 ? (
					<div style={{padding: '20px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13}}>
						{showArchived ? 'No archived threads' : 'No active threads'}
					</div>
				) : (
					threads.map((thread) => {
						const unread = ReadStates.isUnreadOrMentioned(thread.id);
						const mentionCount = ReadStates.getMentionCount(thread.id);
						return (
							<button
								key={thread.id}
								type="button"
								onClick={() => {
									selectChannel(guildId, thread.id);
									onClose();
								}}
								aria-label={`Thread: ${thread.name ?? 'thread'}${unread ? ' (unread)' : ''}`}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 8,
									width: '100%',
									padding: '8px 16px',
									border: 'none',
									background: 'transparent',
									color: unread ? 'var(--text-normal)' : 'var(--text-muted)',
									fontSize: 13,
									fontWeight: unread ? 600 : 500,
									cursor: 'pointer',
									textAlign: 'left',
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.background = 'var(--background-modifier-hover)';
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.background = 'transparent';
								}}
							>
								{unread ? (
									<span
										style={{
											width: 8,
											height: 8,
											borderRadius: '50%',
											background: 'var(--text-normal)',
											flexShrink: 0,
											marginLeft: 4,
											marginRight: 4,
										}}
									/>
								) : (
									<ChatCircleIcon size={16} style={{flexShrink: 0, color: 'var(--text-muted)'}} />
								)}
								{thread.pinned && (
									<PushPinIcon size={13} weight="fill" style={{flexShrink: 0, color: 'var(--text-muted)'}} />
								)}
								{thread.threadMetadata?.locked && (
									<LockIcon size={13} weight="fill" style={{flexShrink: 0, color: 'var(--text-muted)'}} />
								)}
								<span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1}}>
									{thread.name ?? 'thread'}
								</span>
								{mentionCount > 0 && (
									<span
										style={{
											display: 'inline-flex',
											alignItems: 'center',
											justifyContent: 'center',
											minWidth: 16,
											height: 16,
											padding: '0 5px',
											borderRadius: 8,
											background: 'var(--status-danger, #f23f43)',
											color: 'white',
											fontSize: 11,
											fontWeight: 700,
											flexShrink: 0,
										}}
									>
										{mentionCount}
									</span>
								)}
								{mentionCount === 0 && thread.messageCount != null && thread.messageCount > 0 && (
									<span style={{fontSize: 11, color: 'var(--text-muted)', flexShrink: 0}}>
										{thread.messageCount} {thread.messageCount === 1 ? 'reply' : 'replies'}
									</span>
								)}
							</button>
						);
					})
				)}
			</div>
		</div>
	);
});

function PillButton({active, onClick, children}: {active: boolean; onClick: () => void; children: React.ReactNode}) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 4,
				padding: '4px 10px',
				borderRadius: 4,
				border: 'none',
				background: active ? 'var(--brand-experiment, #5865f2)' : 'var(--background-secondary)',
				color: active ? 'white' : 'var(--text-muted)',
				fontSize: 12,
				fontWeight: 500,
				cursor: 'pointer',
			}}
		>
			{children}
		</button>
	);
}
