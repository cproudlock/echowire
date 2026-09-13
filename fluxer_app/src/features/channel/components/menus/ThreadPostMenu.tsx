// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the "..." menu for a thread or forum post, in Discord's order. Moderator items follow
// the forums server contract (see ThreadActions).

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {EditPostModal} from '@app/features/channel/components/modals/EditPostModal';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import {getThreadActions} from '@app/features/channel/utils/ThreadActions';
import {COPY_LINK_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {buildChannelLink} from '@app/features/messaging/utils/MessageLinkUtils';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {CopyIdIcon, CopyLinkIcon, DeleteIcon, EditSimpleIcon} from '@app/features/ui/action_menu/ContextMenuIcons';
import {
	ChannelNotificationSettingsMenuItem,
	MuteChannelMenuItem,
} from '@app/features/ui/action_menu/items/ChannelMenuItems';
import {MenuGroup} from '@app/features/ui/action_menu/MenuGroup';
import {MenuItem} from '@app/features/ui/action_menu/MenuItem';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as TextCopyCommands from '@app/features/ui/commands/TextCopyCommands';
import UserSettings from '@app/features/user/state/UserSettings';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {ArchiveIcon, BellIcon, BellSlashIcon, LockIcon, LockOpenIcon, PushPinIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

const COPY_THREAD_ID_DESCRIPTOR = msg({
	message: 'Copy Thread ID',
	comment: 'Developer mode item in the thread or forum post menu that copies the thread id.',
});

export const ThreadPostMenu = observer(({thread, onClose}: {thread: Channel; onClose: () => void}) => {
	const {i18n} = useLingui();
	const parent = thread.parentId ? Channels.getChannel(thread.parentId) : undefined;
	const isPost = parent?.isForum() === true;
	const actions = getThreadActions(thread);
	const following = ThreadMembers.isMember(thread.id);
	const archived = thread.threadMetadata?.archived === true;
	const locked = thread.threadMetadata?.locked === true;
	const run = (action: () => Promise<unknown>) => {
		onClose();
		void action().catch(() => {});
	};
	const confirmDelete = () => {
		onClose();
		ModalCommands.push(
			modal(() => (
				<ConfirmModal
					title={isPost ? <Trans>Delete post</Trans> : <Trans>Delete thread</Trans>}
					description={<Trans>Are you sure you want to delete this? This cannot be undone.</Trans>}
					primaryText={<Trans>Delete</Trans>}
					primaryVariant="danger"
					onPrimary={async () => {
						await ThreadCommands.deleteThread(thread.id).catch(() => {});
						if (thread.guildId && thread.parentId) {
							selectChannel(thread.guildId, thread.parentId);
						}
					}}
				/>
			)),
		);
	};
	return (
		<>
			<MenuGroup>
				<MenuItem
					icon={following ? <BellSlashIcon size={20} /> : <BellIcon size={20} />}
					onClick={() =>
						run(() => (following ? ThreadCommands.leaveThread(thread.id) : ThreadCommands.joinThread(thread.id)))
					}
				>
					{following
						? isPost
							? i18n._(msg({message: 'Unfollow Post', comment: 'Post menu item that leaves a followed forum post.'}))
							: i18n._(msg({message: 'Leave Thread', comment: 'Thread menu item that leaves a joined thread.'}))
						: isPost
							? i18n._(msg({message: 'Follow Post', comment: 'Post menu item that follows a forum post.'}))
							: i18n._(msg({message: 'Join Thread', comment: 'Thread menu item that joins a thread.'}))}
				</MenuItem>
			</MenuGroup>
			<MenuGroup>
				<MuteChannelMenuItem channel={thread} onClose={onClose} />
				<ChannelNotificationSettingsMenuItem channel={thread} onClose={onClose} />
			</MenuGroup>
			<MenuGroup>
				{actions.canEdit && (
					<MenuItem
						icon={<EditSimpleIcon size={20} />}
						onClick={() => {
							onClose();
							ModalCommands.push(modal(() => <EditPostModal thread={thread} />));
						}}
					>
						{isPost ? <Trans>Edit Post</Trans> : <Trans>Edit Thread</Trans>}
					</MenuItem>
				)}
				{isPost && actions.canPin && (
					<MenuItem
						icon={<PushPinIcon size={20} weight={thread.pinned ? 'fill' : 'regular'} />}
						onClick={() => run(() => ThreadCommands.updateThread(thread.id, {pinned: !thread.pinned}))}
					>
						{thread.pinned ? <Trans>Unpin Post</Trans> : <Trans>Pin Post</Trans>}
					</MenuItem>
				)}
				{actions.canLock && (
					<MenuItem
						icon={locked ? <LockOpenIcon size={20} /> : <LockIcon size={20} />}
						onClick={() => run(() => ThreadCommands.updateThread(thread.id, {locked: !locked}))}
					>
						{locked ? <Trans>Unlock</Trans> : <Trans>Lock</Trans>}
					</MenuItem>
				)}
			</MenuGroup>
			<MenuGroup>
				{archived
					? actions.canReopen && (
							<MenuItem
								icon={<ArchiveIcon size={20} />}
								onClick={() => run(() => ThreadCommands.updateThread(thread.id, {archived: false}))}
							>
								{isPost ? <Trans>Open Post</Trans> : <Trans>Reopen Thread</Trans>}
							</MenuItem>
						)
					: actions.canClose && (
							<MenuItem
								icon={<ArchiveIcon size={20} />}
								onClick={() => run(() => ThreadCommands.updateThread(thread.id, {archived: true}))}
							>
								{isPost ? <Trans>Close Post</Trans> : <Trans>Close Thread</Trans>}
							</MenuItem>
						)}
				{actions.canDelete && (
					<MenuItem icon={<DeleteIcon size={20} />} danger onClick={confirmDelete}>
						{isPost ? <Trans>Delete Post</Trans> : <Trans>Delete Thread</Trans>}
					</MenuItem>
				)}
			</MenuGroup>
			<MenuGroup>
				<MenuItem
					icon={<CopyLinkIcon size={20} />}
					onClick={() => {
						onClose();
						void TextCopyCommands.copy(
							i18n,
							buildChannelLink({guildId: thread.guildId ?? null, channelId: thread.id}),
						);
					}}
				>
					{i18n._(COPY_LINK_DESCRIPTOR)}
				</MenuItem>
				{UserSettings.developerMode && (
					<MenuItem
						icon={<CopyIdIcon size={20} />}
						onClick={() => {
							onClose();
							void TextCopyCommands.copy(i18n, thread.id);
						}}
					>
						{i18n._(COPY_THREAD_ID_DESCRIPTOR)}
					</MenuItem>
				)}
			</MenuGroup>
		</>
	);
});
