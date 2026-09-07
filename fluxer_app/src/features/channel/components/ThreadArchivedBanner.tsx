// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: banner shown above the composer in an archived thread. Mirrors Discord —
// the thread stays readable, and sending a message (or hitting Unarchive) reopens it.

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import type {Channel} from '@app/features/channel/models/Channel';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArchiveIcon, LockIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

const ARCHIVED_DESCRIPTOR = msg({
	message: 'This thread is archived.',
	comment: 'Banner shown above the composer when viewing an archived thread.',
});
const UNARCHIVE_DESCRIPTOR = msg({
	message: 'Unarchive',
	comment: 'Button that reopens an archived thread.',
});
const LOCKED_DESCRIPTOR = msg({
	message: 'This thread is locked. Only moderators can send messages.',
	comment: 'Banner shown above the composer when viewing a locked thread.',
});

export const ThreadArchivedBanner = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	// Echowire: a locked (but not archived) thread shows an informational banner; archived takes
	// precedence (it offers the Unarchive action).
	if (channel.isThread() && channel.threadMetadata?.locked && !channel.threadMetadata?.archived) {
		return (
			<div
				data-flx="channel.thread-locked-banner"
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					margin: '0 16px 8px',
					padding: '8px 14px',
					borderRadius: 8,
					background: 'var(--background-secondary)',
					color: 'var(--text-muted)',
					fontSize: 13,
				}}
			>
				<LockIcon size={16} weight="fill" style={{flexShrink: 0}} />
				<span style={{flex: 1}}>{i18n._(LOCKED_DESCRIPTOR)}</span>
			</div>
		);
	}
	if (!channel.isThread() || !channel.threadMetadata?.archived) {
		return null;
	}
	return (
		<div
			data-flx="channel.thread-archived-banner"
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 10,
				margin: '0 16px 8px',
				padding: '8px 14px',
				borderRadius: 8,
				background: 'var(--background-secondary)',
				color: 'var(--text-muted)',
				fontSize: 13,
			}}
		>
			<ArchiveIcon size={16} weight="fill" style={{flexShrink: 0}} />
			<span style={{flex: 1}}>{i18n._(ARCHIVED_DESCRIPTOR)}</span>
			<button
				type="button"
				onClick={() => void ThreadCommands.updateThread(channel.id, {archived: false})}
				style={{
					padding: '4px 12px',
					borderRadius: 4,
					border: 'none',
					background: 'var(--brand-experiment, #5865f2)',
					color: 'white',
					fontSize: 12,
					fontWeight: 600,
					cursor: 'pointer',
					flexShrink: 0,
				}}
			>
				{i18n._(UNARCHIVE_DESCRIPTOR)}
			</button>
		</div>
	);
});
