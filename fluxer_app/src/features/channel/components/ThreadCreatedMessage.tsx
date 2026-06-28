// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: renders the "started a thread" system message (MessageTypes.THREAD_CREATED)
// in the parent channel. message.content holds the thread's channel id, which we resolve
// to a name + a click-to-open link.

import {SystemMessage} from '@app/features/channel/components/SystemMessage';
import {SystemMessageUsername} from '@app/features/channel/components/SystemMessageUsername';
import Channels from '@app/features/channel/state/Channels';
import {useSystemMessageData} from '@app/features/messaging/hooks/useSystemMessageData';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {Trans} from '@lingui/react/macro';
import {ChatCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

export const ThreadCreatedMessage = observer(({message}: {message: Message}) => {
	const {author, channel, guild} = useSystemMessageData(message);
	if (!channel) {
		return null;
	}
	const thread = message.content ? Channels.getChannel(message.content) : undefined;
	const threadName = thread?.name ?? message.content ?? 'thread';
	const username = (
		<SystemMessageUsername
			author={author}
			guild={guild}
			message={message}
			key={author.id}
			data-flx="channel.thread-created-message.system-message-username"
		/>
	);
	const threadLink =
		thread && thread.guildId ? (
			<button
				type="button"
				onClick={() => {
					if (thread.guildId) {
						selectChannel(thread.guildId, thread.id);
					}
				}}
				data-flx="channel.thread-created-message.link"
				style={{
					background: 'none',
					border: 'none',
					padding: 0,
					font: 'inherit',
					color: 'var(--text-link, #00a8fc)',
					fontWeight: 600,
					cursor: 'pointer',
				}}
			>
				{threadName}
			</button>
		) : (
			<span style={{fontWeight: 600}}>{threadName}</span>
		);
	return (
		<SystemMessage
			icon={ChatCircleIcon}
			iconWeight="fill"
			message={message}
			messageContent={
				<Trans>
					{username} started a thread: {threadLink}
				</Trans>
			}
			data-flx="channel.thread-created-message.system-message"
		/>
	);
});
