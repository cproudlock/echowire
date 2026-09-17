// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: thread member count, Join/Leave, the member list, and adding or removing members in
// the thread header. Who may add or remove is decided by ThreadMemberActions, which mirrors the
// server rules, so the controls only appear where the server would allow the action.

import Authentication from '@app/features/auth/state/Authentication';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import {AddThreadMemberModal} from '@app/features/channel/components/modals/AddThreadMemberModal';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import {canSendInThreads, getThreadActions} from '@app/features/channel/utils/ThreadActions';
import {classifyThreadMemberFailure, resolveThreadMemberActions} from '@app/features/channel/utils/ThreadMemberActions';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import {usePopout} from '@app/features/ui/hooks/usePopout';
import {Popout} from '@app/features/ui/popover/PopoverPopout';
import Users from '@app/features/user/state/Users';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {UserMinusIcon, UserPlusIcon, UsersIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

const MEMBERS_DESCRIPTOR = msg({message: 'Thread members', comment: 'Tooltip on the thread members button.'});
const ADD_MEMBER_DESCRIPTOR = msg({
	message: 'Add member',
	comment: 'Tooltip on the button that opens the dialog for adding someone to a thread.',
});
const REMOVE_MEMBER_DESCRIPTOR = msg({
	message: 'Remove from thread',
	comment: 'Tooltip on the button that removes someone from a thread.',
});

export const ThreadMembersButton = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	const {isOpen, openProps} = usePopout('thread-members');
	useEffect(() => {
		void ThreadCommands.listThreadMembers(channel.id);
	}, [channel.id]);
	const members = ThreadMembers.getMembers(channel.id);
	const count = members.length > 0 ? members.length : (channel.memberCount ?? 0);
	const isMember = ThreadMembers.isMember(channel.id);
	const currentUserId = Authentication.currentUserId;
	const parentId = channel.parentId ?? channel.id;
	const actions = getThreadActions(channel);
	const memberActions = resolveThreadMemberActions({
		isOwner: channel.ownerId != null && channel.ownerId === currentUserId,
		canManage: actions.canManage,
		isPrivate: channel.type === ChannelTypes.PRIVATE_THREAD,
		invitable: channel.threadMetadata?.invitable === true,
		isMember,
		canSendInThreads: canSendInThreads({channelId: parentId, guildId: channel.guildId ?? undefined}),
	});

	const removeMember = async (userId: string) => {
		try {
			await ThreadCommands.removeThreadMember(channel.id, userId);
		} catch (error) {
			const failure = classifyThreadMemberFailure(failureCode(error));
			ToastCommands.createToast({
				type: 'error',
				children:
					failure === 'forbidden' ? (
						<Trans>You don't have permission to remove members here.</Trans>
					) : (
						<Trans>Couldn't remove that member. Try again.</Trans>
					),
			});
		}
	};

	return (
		<Popout
			{...openProps}
			position="bottom-end"
			render={() => (
				<div
					data-flx="channel.thread-members-popout"
					style={{
						display: 'flex',
						flexDirection: 'column',
						width: 240,
						maxHeight: 420,
						background: 'var(--form-surface-background)',
						borderRadius: 8,
						boxShadow: 'var(--shadow-high)',
						overflow: 'hidden',
					}}
				>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							gap: 8,
							padding: '10px 12px',
							borderBottom: '1px solid var(--background-modifier-accent)',
						}}
					>
						<span style={{fontSize: 13, fontWeight: 700, color: 'var(--text-muted)'}}>
							<Trans>Members</Trans>
							<span>{` · ${count}`}</span>
						</span>
						<div style={{display: 'flex', alignItems: 'center', gap: 6}}>
							{memberActions.canAdd && (
								<button
									type="button"
									aria-label={i18n._(ADD_MEMBER_DESCRIPTOR)}
									title={i18n._(ADD_MEMBER_DESCRIPTOR)}
									onClick={() => {
										const thread = Channels.getChannel(channel.id) ?? channel;
										ModalCommands.push(
											modal(() => (
												<AddThreadMemberModal
													thread={thread}
													data-flx="channel.thread-members-button.add-thread-member-modal"
												/>
											)),
										);
									}}
									style={{
										display: 'flex',
										alignItems: 'center',
										padding: 4,
										borderRadius: 4,
										border: 'none',
										background: 'var(--background-secondary)',
										color: 'var(--text-muted)',
										cursor: 'pointer',
									}}
									data-flx="channel.thread-members-button.add"
								>
									<UserPlusIcon size={14} />
								</button>
							)}
							<button
								type="button"
								onClick={() =>
									void (
										isMember ? ThreadCommands.leaveThread(channel.id) : ThreadCommands.joinThread(channel.id)
									).catch(() => {})
								}
								style={{
									padding: '4px 10px',
									borderRadius: 4,
									border: 'none',
									background: isMember ? 'var(--background-secondary)' : 'var(--brand-experiment, #5865f2)',
									color: isMember ? 'var(--text-muted)' : 'white',
									fontSize: 12,
									fontWeight: 600,
									cursor: 'pointer',
								}}
							>
								{isMember ? <Trans>Leave</Trans> : <Trans>Join</Trans>}
							</button>
						</div>
					</div>
					<div style={{overflowY: 'auto', padding: '4px 0'}}>
						{members.length === 0 ? (
							<div style={{padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13}}>
								<Trans>No members yet</Trans>
							</div>
						) : (
							members.map((member) => {
								const user = Users.getUser(member.userId);
								const canRemove = memberActions.canRemoveOthers && member.userId !== currentUserId;
								return (
									<div key={member.userId} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px'}}>
										{user ? <Avatar user={user} size={24} /> : <span style={{width: 24, height: 24}} />}
										<span
											style={{
												flex: 1,
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
												color: 'var(--text-normal)',
												fontSize: 13,
											}}
										>
											{user?.displayName ?? member.userId}
										</span>
										{canRemove && (
											<button
												type="button"
												aria-label={i18n._(REMOVE_MEMBER_DESCRIPTOR)}
												title={i18n._(REMOVE_MEMBER_DESCRIPTOR)}
												onClick={() => void removeMember(member.userId)}
												style={{
													display: 'flex',
													alignItems: 'center',
													padding: 2,
													border: 'none',
													background: 'none',
													color: 'var(--text-muted)',
													cursor: 'pointer',
												}}
												data-flx="channel.thread-members-button.remove"
											>
												<UserMinusIcon size={14} />
											</button>
										)}
									</div>
								);
							})
						)}
					</div>
				</div>
			)}
		>
			<ChannelHeaderIcon
				icon={UsersIcon}
				label={i18n._(MEMBERS_DESCRIPTOR)}
				isSelected={isOpen}
				aria-haspopup={true}
				aria-expanded={isOpen}
				data-flx="channel.thread-members-button.icon"
			/>
		</Popout>
	);
});
