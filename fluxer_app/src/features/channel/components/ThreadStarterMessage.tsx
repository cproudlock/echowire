// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: when a thread was started from a message, the thread's ID equals that
// message's ID (Discord semantics). This renders the source message as a pinned
// "starter" at the top of the thread, fetched from the parent channel.

import {Endpoints} from '@app/features/app/constants/Endpoints';
import type {Channel} from '@app/features/channel/models/Channel';
import {SafeMarkdown} from '@app/features/messaging/components/markdown';
import {Message} from '@app/features/messaging/models/MessagingMessage';
import {http} from '@app/features/platform/transport/RestTransport';
import {Avatar} from '@app/features/ui/components/Avatar';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const STARTER_DESCRIPTOR = msg({
	message: 'Thread started from this message',
	comment: 'Label above the source message pinned at the top of a thread.',
});

export const ThreadStarterMessage = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	const parentId = channel.parentId;
	const messageId = channel.id;
	const [message, setMessage] = useState<Message | null>(null);

	useEffect(() => {
		if (!channel.isThread() || !parentId) {
			return;
		}
		let cancelled = false;
		setMessage(null);
		void http
			.get(Endpoints.CHANNEL_MESSAGE(parentId, messageId))
			.then((response) => {
				if (cancelled) return;
				setMessage(new Message(response.body as never));
			})
			.catch(() => {
				// 404 = thread was created from the channel (no source message) or the source
				// message was deleted; either way there is simply no starter to show.
			});
		return () => {
			cancelled = true;
		};
	}, [channel, parentId, messageId]);

	if (!channel.isThread() || !parentId || !message) {
		return null;
	}
	const author = message.author;
	return (
		<div
			data-flx="channel.thread-starter-message"
			style={{
				margin: '8px 16px 4px',
				padding: '12px 14px',
				borderRadius: 8,
				background: 'var(--background-secondary)',
				borderLeft: '3px solid var(--brand-experiment, #5865f2)',
			}}
		>
			<div style={{marginBottom: 8, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.2}}>
				{i18n._(STARTER_DESCRIPTOR)}
			</div>
			<div style={{display: 'flex', gap: 10}}>
				<Avatar user={author} size={32} data-flx="channel.thread-starter-message.avatar" />
				<div style={{minWidth: 0, flex: 1}}>
					<div style={{display: 'flex', alignItems: 'baseline', gap: 8}}>
						<span style={{fontSize: 14, fontWeight: 600, color: 'var(--text-normal)'}}>{author.displayName}</span>
					</div>
					<div style={{fontSize: 14, color: 'var(--text-normal)', wordBreak: 'break-word'}}>
						{message.content ? <SafeMarkdown content={message.content} /> : null}
					</div>
				</div>
			</div>
		</div>
	);
});
