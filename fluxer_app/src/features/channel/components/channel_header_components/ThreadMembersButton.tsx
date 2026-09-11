// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: thread member count + Join/Leave + member list, in the thread header.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import type {Channel} from '@app/features/channel/models/Channel';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import {Avatar} from '@app/features/ui/components/Avatar';
import {usePopout} from '@app/features/ui/hooks/usePopout';
import {Popout} from '@app/features/ui/popover/PopoverPopout';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {UsersIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

const MEMBERS_DESCRIPTOR = msg({message: 'Thread members', comment: 'Tooltip on the thread members button.'});

export const ThreadMembersButton = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	const {isOpen, openProps} = usePopout('thread-members');
	useEffect(() => {
		void ThreadCommands.listThreadMembers(channel.id);
	}, [channel.id]);
	const members = ThreadMembers.getMembers(channel.id);
	const count = members.length > 0 ? members.length : (channel.memberCount ?? 0);
	const isMember = ThreadMembers.isMember(channel.id);
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
							<span>{` — ${count}`}</span>
						</span>
						<button
							type="button"
							onClick={() =>
								void (isMember ? ThreadCommands.leaveThread(channel.id) : ThreadCommands.joinThread(channel.id)).catch(
									() => {},
								)
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
					<div style={{overflowY: 'auto', padding: '4px 0'}}>
						{members.length === 0 ? (
							<div style={{padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13}}>
								<Trans>No members yet</Trans>
							</div>
						) : (
							members.map((member) => {
								const user = Users.getUser(member.userId);
								return (
									<div key={member.userId} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px'}}>
										{user ? <Avatar user={user} size={24} /> : <span style={{width: 24, height: 24}} />}
										<span
											style={{
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
												color: 'var(--text-normal)',
												fontSize: 13,
											}}
										>
											{user?.displayName ?? member.userId}
										</span>
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
