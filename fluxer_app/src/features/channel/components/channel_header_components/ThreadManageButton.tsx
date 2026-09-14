// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: header controls for a thread or forum post: a Follow/Following toggle and the "..."
// menu (ThreadPostMenu). Moderator items inside the menu are gated by ThreadActions.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import {ThreadPostMenu} from '@app/features/channel/components/menus/ThreadPostMenu';
import type {Channel} from '@app/features/channel/models/Channel';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {BellIcon, BellRingingIcon, DotsThreeIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect} from 'react';

const MORE_OPTIONS_DESCRIPTOR = msg({
	message: 'More options',
	comment: 'Tooltip on the thread or forum post "..." menu button.',
});
const FOLLOW_DESCRIPTOR = msg({
	message: 'Follow',
	comment: 'Header toggle that follows a thread or forum post to get its notifications.',
});
const FOLLOWING_DESCRIPTOR = msg({
	message: 'Following',
	comment: 'Header toggle state when the user follows a thread or forum post; clicking unfollows.',
});

export const ThreadFollowButton = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	useEffect(() => {
		void ThreadCommands.listThreadMembers(channel.id);
	}, [channel.id]);
	const following = ThreadMembers.isMember(channel.id);
	return (
		<ChannelHeaderIcon
			icon={following ? BellRingingIcon : BellIcon}
			label={i18n._(following ? FOLLOWING_DESCRIPTOR : FOLLOW_DESCRIPTOR)}
			isSelected={following}
			onClick={() =>
				void (following ? ThreadCommands.leaveThread(channel.id) : ThreadCommands.joinThread(channel.id)).catch(
					() => {},
				)
			}
			data-flx="channel.thread-follow-button.icon"
		/>
	);
});

export const ThreadManageButton = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	return (
		<ChannelHeaderIcon
			icon={DotsThreeIcon}
			label={i18n._(MORE_OPTIONS_DESCRIPTOR)}
			aria-haspopup={true}
			onClick={(event: React.MouseEvent) =>
				ContextMenuCommands.openFromElementBottomRight(event, ({onClose}) => (
					<ThreadPostMenu thread={channel} onClose={onClose} />
				))
			}
			data-flx="channel.thread-manage-button.icon"
		/>
	);
});
