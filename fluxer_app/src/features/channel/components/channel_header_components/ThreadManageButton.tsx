// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: thread/forum-post moderation menu in the channel header. Shows for the thread owner
// or anyone with Manage Channels: Lock/Unlock and Delete. Backend gates the same way.

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import Authentication from '@app/features/auth/state/Authentication';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import {EditPostTagsModal} from '@app/features/channel/components/modals/EditPostTagsModal';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import Permission from '@app/features/permissions/state/Permission';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {usePopout} from '@app/features/ui/hooks/usePopout';
import {Popout} from '@app/features/ui/popover/PopoverPopout';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {Trans, useLingui} from '@lingui/react/macro';
import {msg} from '@lingui/core/macro';
import {DotsThreeIcon, LockIcon, LockOpenIcon, TagIcon, TrashIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const MANAGE_THREAD_DESCRIPTOR = msg({message: 'Manage', comment: 'Tooltip on the thread moderation menu button.'});

export const ThreadManageButton = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	const {isOpen, openProps} = usePopout('thread-manage');
	const isOwner = channel.ownerId != null && channel.ownerId === Authentication.currentUserId;
	const canManage = Permission.can(Permissions.MANAGE_CHANNELS, {
		channelId: channel.parentId ?? channel.id,
		guildId: channel.guildId ?? undefined,
	});
	if (!isOwner && !canManage) {
		return null;
	}
	const parentIsForum = channel.parentId != null && Channels.getChannel(channel.parentId)?.isForum() === true;
	const locked = channel.threadMetadata?.locked === true;
	return (
		<Popout
			{...openProps}
			position="bottom-end"
			render={({onClose}) => (
				<div
					data-flx="channel.thread-manage-popout"
					style={{
						display: 'flex',
						flexDirection: 'column',
						minWidth: 180,
						padding: 6,
						background: 'var(--background-floating)',
						borderRadius: 8,
						boxShadow: 'var(--shadow-high)',
					}}
				>
					{parentIsForum && (
						<MenuRow
							onClick={() => {
								onClose();
								ModalCommands.push(modal(() => <EditPostTagsModal channel={channel} />));
							}}
						>
							<TagIcon size={16} />
							<Trans>Edit tags</Trans>
						</MenuRow>
					)}
					{canManage && (
						<MenuRow
							onClick={() => {
								void ThreadCommands.updateThread(channel.id, {locked: !locked}).catch(() => {});
								onClose();
							}}
						>
							{locked ? <LockOpenIcon size={16} /> : <LockIcon size={16} />}
							{locked ? <Trans>Unlock</Trans> : <Trans>Lock</Trans>}
						</MenuRow>
					)}
					<MenuRow
						danger
						onClick={() => {
							onClose();
							ModalCommands.push(
								modal(() => (
									<ConfirmModal
										title={<Trans>Delete post</Trans>}
										description={<Trans>Are you sure you want to delete this? This cannot be undone.</Trans>}
										primaryText={<Trans>Delete</Trans>}
										primaryVariant="danger"
										onPrimary={async () => {
											await ThreadCommands.deleteThread(channel.id).catch(() => {});
											if (channel.guildId && channel.parentId) {
												selectChannel(channel.guildId, channel.parentId);
											}
										}}
									/>
								)),
							);
						}}
					>
						<TrashIcon size={16} />
						<Trans>Delete</Trans>
					</MenuRow>
				</div>
			)}
		>
			<ChannelHeaderIcon
				icon={DotsThreeIcon}
				label={i18n._(MANAGE_THREAD_DESCRIPTOR)}
				isSelected={isOpen}
				aria-haspopup={true}
				aria-expanded={isOpen}
				data-flx="channel.thread-manage-button.icon"
			/>
		</Popout>
	);
});

function MenuRow({
	children,
	onClick,
	danger,
}: {children: React.ReactNode; onClick: () => void; danger?: boolean}) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				width: '100%',
				padding: '8px 10px',
				borderRadius: 4,
				border: 'none',
				background: 'transparent',
				color: danger ? 'var(--text-danger, #f23f43)' : 'var(--text-normal)',
				fontSize: 14,
				fontWeight: 500,
				cursor: 'pointer',
				textAlign: 'left',
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.background = danger
					? 'var(--status-danger-background, rgba(242,63,67,0.1))'
					: 'var(--background-modifier-hover)';
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.background = 'transparent';
			}}
		>
			{children}
		</button>
	);
}
