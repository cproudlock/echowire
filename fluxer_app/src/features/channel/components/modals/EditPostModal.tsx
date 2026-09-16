// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: edit a thread or forum post: title, applied tags (posts only) and how long it stays
// open without activity. The owner or anyone with Manage Channels on the parent may edit.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {ForumTagChip} from '@app/features/channel/components/forum/ForumTagChip';
import styles from '@app/features/channel/components/modals/EditPostModal.module.css';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import {selectableForumTags} from '@app/features/channel/utils/ForumPaneUtils';
import {canModerateThreads} from '@app/features/channel/utils/ThreadActions';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
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
const DURATION_DESCRIPTORS = {
	60: msg({message: '1 hour', comment: 'Auto-archive duration option.'}),
	1440: msg({message: '24 hours', comment: 'Auto-archive duration option.'}),
	4320: msg({message: '3 days', comment: 'Auto-archive duration option.'}),
	10080: msg({message: '1 week', comment: 'Auto-archive duration option.'}),
} as const;

function toDuration(value: number | undefined): AutoArchiveDuration {
	return AUTO_ARCHIVE_DURATIONS.includes(value as AutoArchiveDuration) ? (value as AutoArchiveDuration) : 4320;
}

export const EditPostModal = observer(({thread}: {thread: Channel}) => {
	const {i18n} = useLingui();
	const parent = thread.parentId ? Channels.getChannel(thread.parentId) : undefined;
	const isPost = parent?.isForum() === true;
	const allTags = isPost ? (parent?.availableTags ?? []) : [];
	const [title, setTitle] = useState(thread.name ?? '');
	const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set(thread.appliedTags));
	const [duration, setDuration] = useState<AutoArchiveDuration>(toDuration(thread.threadMetadata?.autoArchiveDuration));
	const [saving, setSaving] = useState(false);
	const requireTag = isPost && parent?.forumRequireTag === true;
	const canSave = title.trim().length > 0 && (!requireTag || selectedTags.size > 0);
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
