// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: active threads nested under their parent text channel in the sidebar.
// Self-contained + additive: renders nothing unless the channel is a guild text
// channel with active threads, so it can't affect the existing channel list.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import type {Guild} from '@app/features/guild/models/Guild';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {ChannelTypes, THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {ChatCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

export const ChannelThreadList = observer(
	({guild, channel, selectedChannelId}: {guild: Guild; channel: Channel; selectedChannelId?: string | null}) => {
		useEffect(() => {
			if (channel.type !== ChannelTypes.GUILD_TEXT) return;
			void ThreadCommands.listActiveThreads(channel.id).catch(() => {});
		}, [channel.id, channel.type]);

		if (channel.type !== ChannelTypes.GUILD_TEXT) {
			return null;
		}
		const threads = Channels.getGuildChannels(guild.id).filter(
			(c) => c.parentId === channel.id && THREAD_CHANNEL_TYPES.has(c.type),
		);
		if (threads.length === 0) {
			return null;
		}
		return (
			<div data-flx="app.channel-list-content.channel-thread-list">
				{threads.map((thread) => {
					const isSelected = selectedChannelId === thread.id;
					return (
						<button
							key={thread.id}
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
								color: isSelected ? 'var(--text-primary, #f2f3f5)' : 'var(--text-tertiary, #8a8f98)',
								cursor: 'pointer',
								font: 'inherit',
								fontSize: 13,
								fontWeight: isSelected ? 600 : 400,
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
				})}
			</div>
		);
	},
);
