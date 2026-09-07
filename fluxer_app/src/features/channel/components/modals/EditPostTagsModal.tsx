// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: edit the tags applied to a forum post (a thread under a GUILD_FORUM channel). Tags come
// from the parent forum's available_tags; saving sends the replacement set via updateThread.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Trans} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

export const EditPostTagsModal = observer(({channel}: {channel: Channel}) => {
	const parent = channel.parentId ? Channels.getChannel(channel.parentId) : undefined;
	const availableTags = parent?.availableTags ?? [];
	const [selected, setSelected] = useState<Set<string>>(new Set(channel.appliedTags));
	const [saving, setSaving] = useState(false);

	const toggle = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else if (next.size < 5) next.add(id);
			return next;
		});
	};

	const save = async () => {
		setSaving(true);
		try {
			await ThreadCommands.updateThread(channel.id, {applied_tags: [...selected]});
			ModalCommands.pop();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal.Root size="small" centered data-flx="channel.edit-post-tags-modal.modal-root">
			<Modal.Header title={<Trans>Edit tags</Trans>} data-flx="channel.edit-post-tags-modal.modal-header" />
			<Modal.Content data-flx="channel.edit-post-tags-modal.modal-content">
				{availableTags.length === 0 ? (
					<div style={{color: 'var(--text-muted)', fontSize: 13}}>
						<Trans>This forum has no tags. Add tags in the forum's settings first.</Trans>
					</div>
				) : (
					<div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
						{availableTags.map((tag) => {
							const active = selected.has(tag.id);
							return (
								<button
									key={tag.id}
									type="button"
									onClick={() => toggle(tag.id)}
									aria-pressed={active}
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 4,
										padding: '4px 10px',
										borderRadius: 999,
										border: 'none',
										background: active ? 'var(--brand-experiment, #5865f2)' : 'var(--background-secondary)',
										color: active ? 'white' : 'var(--text-muted)',
										fontSize: 12,
										fontWeight: 600,
										cursor: 'pointer',
									}}
								>
									{tag.emojiName && <span>{tag.emojiName}</span>}
									{tag.name}
								</button>
							);
						})}
					</div>
				)}
			</Modal.Content>
			<Modal.Footer data-flx="channel.edit-post-tags-modal.modal-footer">
				<Button onClick={ModalCommands.pop} variant="secondary" data-flx="channel.edit-post-tags-modal.button.cancel">
					{CANCEL_DESCRIPTOR.message}
				</Button>
				<Button onClick={() => void save()} submitting={saving} data-flx="channel.edit-post-tags-modal.button.save">
					<Trans>Save</Trans>
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
