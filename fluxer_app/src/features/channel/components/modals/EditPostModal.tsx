// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: edit a thread or forum post: title, applied tags (posts only), how long it stays
// open without activity, its own slowmode, and whether members may invite others to a private
// thread. The owner or anyone with Manage Threads on the parent may edit; invitability is
// moderator only, matching the server's moderator-only list.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {ForumTagChip} from '@app/features/channel/components/forum/ForumTagChip';
import styles from '@app/features/channel/components/modals/EditPostModal.module.css';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import {selectableForumTags} from '@app/features/channel/utils/ForumPaneUtils';
import {canModerateThreads, getThreadActions} from '@app/features/channel/utils/ThreadActions';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
import {SwitchGroup, SwitchGroupItem} from '@app/features/ui/components/SwitchGroup';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

type AutoArchiveDuration = 60 | 1440 | 4320 | 10080;
const AUTO_ARCHIVE_DURATIONS: ReadonlyArray<AutoArchiveDuration> = [60, 1440, 4320, 10080];
const MAX_APPLIED_TAGS = 5;

const TITLE_DESCRIPTOR = msg({message: 'Title', comment: 'Label for the thread or forum post title field.'});
const HIDE_AFTER_DESCRIPTOR = msg({
	message: 'Hide after inactivity',
	comment: 'Label for how long a thread or post stays open without new messages before it is closed.',
});
const SLOWMODE_DESCRIPTOR = msg({
	message: 'Slowmode',
	comment: 'Label for how long a member must wait between messages in this thread or post.',
});
const INVITABLE_DESCRIPTOR = msg({
	message: 'Members can add others',
	comment: 'Label for the switch that lets thread members invite others to a private thread.',
});
const DURATION_DESCRIPTORS = {
	60: msg({message: '1 hour', comment: 'Auto-archive duration option.'}),
	1440: msg({message: '24 hours', comment: 'Auto-archive duration option.'}),
	4320: msg({message: '3 days', comment: 'Auto-archive duration option.'}),
	10080: msg({message: '1 week', comment: 'Auto-archive duration option.'}),
} as const;
// Echowire: the same steps the forum's own "Slowmode in new posts" control offers, so a post and
// the forum default read the same way.
const SLOWMODE_OPTIONS = [
	{value: 0, label: msg({message: 'Off', comment: 'Slowmode option: no limit.'})},
	{value: 5, label: msg({message: '5 seconds', comment: 'Slowmode option.'})},
	{value: 10, label: msg({message: '10 seconds', comment: 'Slowmode option.'})},
	{value: 30, label: msg({message: '30 seconds', comment: 'Slowmode option.'})},
	{value: 60, label: msg({message: '1 minute', comment: 'Slowmode option.'})},
	{value: 300, label: msg({message: '5 minutes', comment: 'Slowmode option.'})},
	{value: 900, label: msg({message: '15 minutes', comment: 'Slowmode option.'})},
	{value: 3600, label: msg({message: '1 hour', comment: 'Slowmode option.'})},
	{value: 21600, label: msg({message: '6 hours', comment: 'Slowmode option.'})},
] as const;

function toDuration(value: number | undefined): AutoArchiveDuration {
	return AUTO_ARCHIVE_DURATIONS.includes(value as AutoArchiveDuration) ? (value as AutoArchiveDuration) : 4320;
}

// Echowire: a post inherits the forum's default at creation, so an arbitrary stored value can sit
// between two steps. Snap down to the nearest offered step rather than silently showing "Off".
function toSlowmodeStep(value: number | undefined): number {
	const seconds = Math.max(0, Math.min(value ?? 0, 21600));
	let step = 0;
	for (const option of SLOWMODE_OPTIONS) {
		if (option.value <= seconds) step = option.value;
	}
	return step;
}

export const EditPostModal = observer(({thread}: {thread: Channel}) => {
	const {i18n} = useLingui();
	const parent = thread.parentId ? Channels.getChannel(thread.parentId) : undefined;
	const isPost = parent?.isForum() === true;
	const isPrivateThread = thread.type === ChannelTypes.PRIVATE_THREAD;
	const allTags = isPost ? (parent?.availableTags ?? []) : [];
	const actions = getThreadActions(thread);
	const [title, setTitle] = useState(thread.name ?? '');
	const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set(thread.appliedTags));
	const [duration, setDuration] = useState<AutoArchiveDuration>(toDuration(thread.threadMetadata?.autoArchiveDuration));
	const [slowmode, setSlowmode] = useState<number>(toSlowmodeStep(thread.rateLimitPerUser));
	const [invitable, setInvitable] = useState<boolean>(thread.threadMetadata?.invitable === true);
	const [saving, setSaving] = useState(false);
	const requireTag = isPost && parent?.forumRequireTag === true;
	const canSave = title.trim().length > 0 && (!requireTag || selectedTags.size > 0);
	const forumDefaultSlowmode = isPost ? (parent?.defaultThreadRateLimitPerUser ?? 0) : 0;
	// Moderated tags need manage rights, except ones already applied, which stay so a save keeps them.
	const availableTags = selectableForumTags(allTags, {
		canManage: canModerateThreads({
			channelId: thread.parentId ?? thread.id,
			guildId: thread.guildId ?? undefined,
		}),
		appliedTagIds: new Set(thread.appliedTags),
	});

	const toggleTag = (tagId: string) => {
		setSelectedTags((prev) => {
			const next = new Set(prev);
			if (next.has(tagId)) next.delete(tagId);
			else if (next.size < MAX_APPLIED_TAGS) next.add(tagId);
			return next;
		});
	};

	const save = async () => {
		if (!canSave) return;
		setSaving(true);
		try {
			await ThreadCommands.updateThread(thread.id, {
				name: title.trim(),
				auto_archive_duration: duration,
				...(isPost ? {applied_tags: [...selectedTags]} : {}),
				...(actions.canSetSlowmode ? {rate_limit_per_user: slowmode} : {}),
				...(isPrivateThread && actions.canSetInvitable ? {invitable} : {}),
			});
			ModalCommands.pop();
		} catch {
			ToastCommands.createToast({type: 'error', children: <Trans>Couldn't save your changes. Try again.</Trans>});
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal.Root size="small" centered data-flx="channel.edit-post-modal.modal-root">
			<Modal.Header
				title={isPost ? <Trans>Edit Post</Trans> : <Trans>Edit Thread</Trans>}
				data-flx="channel.edit-post-modal.modal-header"
			/>
			<Modal.Content data-flx="channel.edit-post-modal.modal-content">
				<div className={styles.fields}>
					<Input
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						autoComplete="off"
						autoFocus={true}
						label={i18n._(TITLE_DESCRIPTOR)}
						maxLength={100}
						required={true}
						data-flx="channel.edit-post-modal.title"
					/>
					{isPost && availableTags.length > 0 && (
						<div className={styles.field}>
							<div className={styles.label}>
								{requireTag ? <Trans>Tags (at least one required)</Trans> : <Trans>Tags</Trans>}
							</div>
							<div className={styles.tags}>
								{availableTags.map((tag) => (
									<ForumTagChip
										key={tag.id}
										tag={tag}
										selected={selectedTags.has(tag.id)}
										onToggle={() => toggleTag(tag.id)}
									/>
								))}
							</div>
						</div>
					)}
					<div className={styles.field}>
						<label className={styles.label} htmlFor="edit-post-auto-archive">
							{i18n._(HIDE_AFTER_DESCRIPTOR)}
						</label>
						<select
							id="edit-post-auto-archive"
							className={styles.select}
							value={duration}
							onChange={(event) => setDuration(toDuration(Number(event.target.value)))}
						>
							{AUTO_ARCHIVE_DURATIONS.map((value) => (
								<option key={value} value={value}>
									{i18n._(DURATION_DESCRIPTORS[value])}
								</option>
							))}
						</select>
					</div>
					{actions.canSetSlowmode && (
						<div className={styles.field}>
							<label className={styles.label} htmlFor="edit-post-slowmode">
								{i18n._(SLOWMODE_DESCRIPTOR)}
							</label>
							<select
								id="edit-post-slowmode"
								className={styles.select}
								value={slowmode}
								onChange={(event) => setSlowmode(Number(event.target.value))}
							>
								{SLOWMODE_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{i18n._(option.label)}
									</option>
								))}
							</select>
							{forumDefaultSlowmode > 0 && (
								<span className={styles.hint}>
									<Trans>New posts in this forum start at the forum's slowmode.</Trans>
								</span>
							)}
						</div>
					)}
					{isPrivateThread && actions.canSetInvitable && (
						<div className={styles.field}>
							<SwitchGroup data-flx="channel.edit-post-modal.invitable">
								<SwitchGroupItem label={i18n._(INVITABLE_DESCRIPTOR)} value={invitable} onChange={setInvitable} />
							</SwitchGroup>
						</div>
					)}
				</div>
			</Modal.Content>
			<Modal.Footer data-flx="channel.edit-post-modal.modal-footer">
				<Button onClick={ModalCommands.pop} variant="secondary" data-flx="channel.edit-post-modal.button.cancel">
					{i18n._(CANCEL_DESCRIPTOR)}
				</Button>
				<Button
					onClick={() => void save()}
					submitting={saving}
					disabled={!canSave}
					data-flx="channel.edit-post-modal.button.save"
				>
					<Trans>Save</Trans>
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
