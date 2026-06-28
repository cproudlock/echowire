// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: forum channel settings tab — manage the channel's available tags (add / rename /
// set emoji / delete). Saves the full tag set via PATCH; existing tags keep their id.

import * as ChannelCommands from '@app/features/channel/commands/ChannelCommands';
import Channels from '@app/features/channel/state/Channels';
import {Button} from '@app/features/ui/button/Button';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Trans, useLingui} from '@lingui/react/macro';
import {PlusIcon, TrashIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

interface EditableTag {
	id?: string;
	name: string;
	emojiName: string | null;
}

const ChannelTagsTab = observer(({channelId}: {channelId: string}) => {
	const {t} = useLingui();
	const channel = Channels.getChannel(channelId);
	const [tags, setTags] = useState<Array<EditableTag>>(() =>
		(channel?.availableTags ?? []).map((tag) => ({id: tag.id, name: tag.name, emojiName: tag.emojiName})),
	);
	const [saving, setSaving] = useState(false);

	if (!channel) {
		return null;
	}

	const updateTag = (index: number, patch: Partial<EditableTag>) => {
		setTags((prev) => prev.map((tag, i) => (i === index ? {...tag, ...patch} : tag)));
	};
	const addTag = () => {
		if (tags.length >= 20) return;
		setTags((prev) => [...prev, {name: '', emojiName: null}]);
	};
	const removeTag = (index: number) => {
		setTags((prev) => prev.filter((_, i) => i !== index));
	};

	const save = async () => {
		const cleaned = tags
			.map((tag) => ({...tag, name: tag.name.trim()}))
			.filter((tag) => tag.name.length > 0);
		setSaving(true);
		try {
			await ChannelCommands.update(channelId, {
				available_tags: cleaned.map((tag) => ({
					id: tag.id,
					name: tag.name,
					emoji_name: tag.emojiName && tag.emojiName.length > 0 ? tag.emojiName : null,
				})),
			});
			ToastCommands.createToast({type: 'success', children: <Trans>Tags updated</Trans>});
		} catch {
			ToastCommands.createToast({type: 'error', children: <Trans>Failed to update tags</Trans>});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div style={{display: 'flex', flexDirection: 'column', gap: 12, padding: 4}}>
			<div style={{fontSize: 13, color: 'var(--text-muted)'}}>
				<Trans>Tags help members organize and filter posts in this forum (up to 20).</Trans>
			</div>
			{tags.map((tag, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: tags have no stable id until saved
				<div key={index} style={{display: 'flex', alignItems: 'center', gap: 8}}>
					<input
						type="text"
						value={tag.emojiName ?? ''}
						onChange={(e) => updateTag(index, {emojiName: e.target.value || null})}
						placeholder="🙂"
						maxLength={8}
						aria-label={t`Tag emoji`}
						style={{
							width: 44,
							textAlign: 'center',
							padding: '8px 6px',
							borderRadius: 6,
							border: '1px solid var(--background-modifier-accent)',
							background: 'var(--input-background, var(--background-secondary))',
							color: 'var(--text-normal)',
						}}
					/>
					<input
						type="text"
						value={tag.name}
						onChange={(e) => updateTag(index, {name: e.target.value})}
						placeholder={t`Tag name`}
						maxLength={20}
						aria-label={t`Tag name`}
						style={{
							flex: 1,
							padding: '8px 10px',
							borderRadius: 6,
							border: '1px solid var(--background-modifier-accent)',
							background: 'var(--input-background, var(--background-secondary))',
							color: 'var(--text-normal)',
						}}
					/>
					<button
						type="button"
						onClick={() => removeTag(index)}
						aria-label={t`Delete tag`}
						style={{
							display: 'flex',
							padding: 8,
							borderRadius: 6,
							border: 'none',
							background: 'transparent',
							color: 'var(--text-danger, #f23f43)',
							cursor: 'pointer',
						}}
					>
						<TrashIcon size={18} />
					</button>
				</div>
			))}
			<div style={{display: 'flex', justifyContent: 'space-between', gap: 8}}>
				<Button variant="secondary" onClick={addTag} disabled={tags.length >= 20}>
					<PlusIcon size={16} weight="bold" />
					<Trans>Add tag</Trans>
				</Button>
				<Button onClick={() => void save()} submitting={saving}>
					<Trans>Save tags</Trans>
				</Button>
			</div>
		</div>
	);
});

export default ChannelTagsTab;
