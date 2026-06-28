// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: "Threads" header button — opens the threads popout (active/archived).

import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import {ChannelThreadsPopout} from '@app/features/channel/components/popouts/ChannelThreadsPopout';
import type {Channel} from '@app/features/channel/models/Channel';
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
			<ChannelHeaderIcon
				icon={ChatCircleIcon}
				label={i18n._(THREADS_DESCRIPTOR)}
				isSelected={isOpen}
				aria-haspopup={true}
				aria-expanded={isOpen}
				data-flx="channel.channel-threads-button.channel-header-icon"
			/>
		</Popout>
	);
});
