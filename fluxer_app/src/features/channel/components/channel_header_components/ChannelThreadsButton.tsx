// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: "Threads" header button — opens the threads popout (active/archived).

import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import {ChannelThreadsPopout} from '@app/features/channel/components/popouts/ChannelThreadsPopout';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ReadStates from '@app/features/read_state/state/ReadStates';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {usePopout} from '@app/features/ui/hooks/usePopout';
import {Popout} from '@app/features/ui/popover/PopoverPopout';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ChatCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

const THREADS_DESCRIPTOR = msg({
	message: 'Threads',
	comment: 'Tooltip on the threads button in the channel header.',
});

export const ChannelThreadsButton = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	const {isOpen, openProps} = usePopout('channel-threads');
	// Aggregate unread: any active thread under this channel with unread/mentions.
	const hasUnreadThread =
		channel.guildId != null &&
		Channels.getGuildChannels(channel.guildId).some(
			(c) =>
				c.parentId === channel.id &&
				THREAD_CHANNEL_TYPES.has(c.type) &&
				!c.threadMetadata?.archived &&
				ReadStates.hasUnreadOrMentions(c.id),
		);
	return (
		<Popout
			data-flx="channel.channel-threads-button.popout"
			{...openProps}
			render={({onClose}) => (
				<ChannelThreadsPopout
					channel={channel}
					onClose={onClose}
					data-flx="channel.channel-threads-button.channel-threads-popout"
				/>
			)}
			position="bottom-end"
		>
			<span style={{position: 'relative', display: 'inline-flex'}}>
				<ChannelHeaderIcon
					icon={ChatCircleIcon}
					label={i18n._(THREADS_DESCRIPTOR)}
					isSelected={isOpen}
					aria-haspopup={true}
					aria-expanded={isOpen}
					data-flx="channel.channel-threads-button.channel-header-icon"
				/>
				{hasUnreadThread && (
					<span
						aria-hidden={true}
						style={{
							position: 'absolute',
							top: 4,
							right: 4,
							width: 8,
							height: 8,
							borderRadius: '50%',
							background: 'var(--text-normal)',
							border: '2px solid var(--background-primary, var(--background-secondary))',
							pointerEvents: 'none',
						}}
					/>
				)}
			</span>
		</Popout>
	);
});
