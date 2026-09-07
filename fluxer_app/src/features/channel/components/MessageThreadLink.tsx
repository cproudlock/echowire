// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: inline link rendered under a message that has a thread started from it.
// A thread created from a message adopts that message's ID (Discord semantics), so we
// look the thread up by the message ID. Clicking jumps into the thread.

import {useMessageViewContext} from '@app/features/channel/components/MessageViewContext';
import Channels from '@app/features/channel/state/Channels';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {ChatCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

export const MessageThreadLink = observer(() => {
	const {channel, message} = useMessageViewContext();
	const thread = Channels.getChannel(message.id);
	if (!thread?.isThread() || thread.parentId !== channel.id) {
		return null;
	}
	const guildId = thread.guildId;
	if (!guildId) {
		return null;
	}
	const replyCount = thread.messageCount ?? 0;
	return (
		<button
			type="button"
			onClick={() => selectChannel(guildId, thread.id)}
			aria-label={`Open thread: ${thread.name ?? 'thread'}`}
			data-flx="channel.message-thread-link"
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				marginTop: 4,
				padding: '4px 10px',
				borderRadius: 8,
				border: 'none',
				background: 'var(--background-secondary)',
				color: 'var(--text-link, #00a8fc)',
				fontSize: 13,
				fontWeight: 600,
				cursor: 'pointer',
				maxWidth: '100%',
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.background = 'var(--background-secondary-alt, var(--background-modifier-hover))';
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.background = 'var(--background-secondary)';
			}}
		>
			<ChatCircleIcon size={16} weight="fill" style={{flexShrink: 0}} />
			<span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
				{thread.name ?? 'thread'}
			</span>
			{replyCount > 0 && (
				<span style={{color: 'var(--text-muted)', fontWeight: 500, flexShrink: 0}}>
					{replyCount} {replyCount === 1 ? 'message' : 'messages'}
				</span>
			)}
		</button>
	);
});
