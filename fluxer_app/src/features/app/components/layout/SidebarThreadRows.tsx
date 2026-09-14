// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads and forum posts nested under their parent channel in the sidebar, drawn with
// a tree connector like Discord. Shows active threads the user has joined or created plus the one
// that is open.

import styles from '@app/features/app/components/layout/SidebarThreadRows.module.css';
import Authentication from '@app/features/auth/state/Authentication';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import {selectSidebarThreads} from '@app/features/channel/utils/ForumPostUtils';
import type {Guild} from '@app/features/guild/models/Guild';
import {MENTION_COUNT_ARIA_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {isKeyboardActivationKey} from '@app/features/input/utils/KeyboardUtils';
import * as NavigationCommands from '@app/features/navigation/commands/NavigationCommands';
import ReadStates from '@app/features/read_state/state/ReadStates';
import {ChannelContextMenu} from '@app/features/ui/action_menu/ChannelContextMenu';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import {MentionBadge} from '@app/features/ui/components/MentionBadge';
import UserGuildSettings from '@app/features/user/state/UserGuildSettings';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

interface SidebarThreadRowsProps {
	guild: Guild;
	parent: Channel;
	selectedChannelId: string | null;
	// A collapsed category keeps only the open thread visible.
	onlySelected?: boolean;
}

export const SidebarThreadRows = observer(
	({guild, parent, selectedChannelId, onlySelected = false}: SidebarThreadRowsProps) => {
		const threads = Channels.getGuildChannels(guild.id).filter((channel) => THREAD_CHANNEL_TYPES.has(channel.type));
		const visible = selectSidebarThreads(threads, {
			parentId: parent.id,
			currentUserId: Authentication.currentUserId,
			selectedChannelId,
			isMember: (threadId) => ThreadMembers.isMember(threadId),
		}).filter((thread) => !onlySelected || thread.id === selectedChannelId);
		if (visible.length === 0) {
			return null;
		}
		return (
			<div className={styles.threadRows} data-flx="app.sidebar-thread-rows">
				{visible.map((thread, index) => (
					<SidebarThreadRow
						key={thread.id}
						guild={guild}
						thread={thread}
						isSelected={thread.id === selectedChannelId}
						isLast={index === visible.length - 1}
					/>
				))}
			</div>
		);
	},
);

const SidebarThreadRow = observer(
	({guild, thread, isSelected, isLast}: {guild: Guild; thread: Channel; isSelected: boolean; isLast: boolean}) => {
		const {i18n} = useLingui();
		const mentionCount = ReadStates.getMentionCount(thread.id);
		const isMuted = UserGuildSettings.getChannelOverride(guild.id, thread.id)?.muted ?? false;
		const hasUnread = !isMuted && ReadStates.hasUnread(thread.id);
		const open = () => NavigationCommands.selectChannel(guild.id, thread.id);
		const handleKeyDown = (event: React.KeyboardEvent) => {
			if (isKeyboardActivationKey(event.key)) {
				event.preventDefault();
				open();
			}
		};
		const handleContextMenu = (event: React.MouseEvent) => {
			event.preventDefault();
			ContextMenuCommands.openFromEvent(event, ({onClose}) => (
				<ChannelContextMenu channel={thread} onClose={onClose} />
			));
		};
		const ariaLabel =
			mentionCount > 0
				? `${thread.name ?? ''}, ${i18n._(MENTION_COUNT_ARIA_DESCRIPTOR, {mentionCount})}`
				: (thread.name ?? '');
		return (
			<div className={styles.threadRowContainer}>
				<svg className={styles.connector} viewBox="0 0 12 22" aria-hidden={true} data-last={isLast}>
					<path d={isLast ? 'M1 0 V9 Q1 13 5 13 H12' : 'M1 0 V22 M1 9 Q1 13 5 13 H12'} />
				</svg>
				<div
					role="link"
					tabIndex={0}
					aria-label={ariaLabel}
					aria-current={isSelected ? 'page' : undefined}
					className={clsx(
						styles.threadRow,
						isSelected && styles.threadRowSelected,
						!isSelected && hasUnread && styles.threadRowUnread,
						isMuted && styles.threadRowMuted,
					)}
					onClick={open}
					onKeyDown={handleKeyDown}
					onContextMenu={handleContextMenu}
					data-flx="app.sidebar-thread-row"
				>
					{!isSelected && hasUnread && <span className={styles.unreadIndicator} />}
					<span className={styles.threadName}>{thread.name}</span>
					{!isSelected && mentionCount > 0 && <MentionBadge mentionCount={mentionCount} size="small" />}
				</div>
			</div>
		);
	},
);
