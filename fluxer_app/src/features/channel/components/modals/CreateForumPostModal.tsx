// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: create a forum post — a thread under a GUILD_FORUM channel with applied tags and a
// first message. The thread + tags are created server-side; the first message is then sent into
// the new thread via the normal message path, and we navigate into it.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import type {Channel} from '@app/features/channel/models/Channel';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as MessageCommands from '@app/features/messaging/commands/MessageCommands';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const CREATE_POST_DESCRIPTOR = msg({message: 'Create Post', comment: 'Title/submit of the forum create-post modal.'});
const POST_TITLE_DESCRIPTOR = msg({message: 'Post title', comment: 'Label for the forum post title field.'});
const POST_TITLE_PLACEHOLDER = msg({message: 'New post', comment: 'Placeholder for the forum post title.'});
const POST_BODY_PLACEHOLDER = msg({message: 'Write something…', comment: 'Placeholder for the forum post body.'});
const TAGS_DESCRIPTOR = msg({message: 'Tags', comment: 'Label above the forum tag selector.'});

export const CreateForumPostModal = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	const guildId = channel.guildId;
	const [title, setTitle] = useState('');
	const [body, setBody] = useState('');
	const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
	const [submitting, setSubmitting] = useState(false);

	const toggleTag = (tagId: string) => {
		setSelectedTagIds((prev) => {
			const next = new Set(prev);
			if (next.has(tagId)) next.delete(tagId);
			else if (next.size < 5) next.add(tagId);
			return next;
		});
	};

	const onSubmit = async () => {
		if (!guildId || !title.trim() || submitting) return;
		setSubmitting(true);
		try {
			const thread = await ThreadCommands.createThread(channel.id, {
				name: title.trim(),
				applied_tags: selectedTagIds.size > 0 ? [...selectedTagIds] : undefined,
			});
			const trimmedBody = body.trim();
			if (trimmedBody.length > 0) {
				const nonce = SnowflakeUtils.fromTimestamp(Date.now());
				MessageCommands.reserveSend(thread.id, nonce);
				await MessageCommands.send(thread.id, {content: trimmedBody, nonce, hasAttachments: false});
			}
			ModalCommands.pop();
			setTimeout(() => selectChannel(guildId, thread.id), 50);
		} finally {
			setSubmitting(false);
		}
	};

	if (!guildId) {
		return null;
	}
	return (
		<Modal.Root size="small" centered data-flx="channel.create-forum-post-modal.modal-root">
			<Modal.Header title={i18n._(CREATE_POST_DESCRIPTOR)} data-flx="channel.create-forum-post-modal.modal-header" />
			<Modal.Content data-flx="channel.create-forum-post-modal.modal-content">
				<Input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					autoComplete="off"
					autoFocus={true}
					label={i18n._(POST_TITLE_DESCRIPTOR)}
					maxLength={100}
					placeholder={i18n._(POST_TITLE_PLACEHOLDER)}
					required={true}
					data-flx="channel.create-forum-post-modal.input"
				/>
				{channel.availableTags.length > 0 && (
					<div style={{marginTop: 16}}>
						<div style={{marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #b5bac1)'}}>
							{i18n._(TAGS_DESCRIPTOR)}
						</div>
						<div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
							{channel.availableTags.map((tag) => {
								const active = selectedTagIds.has(tag.id);
								return (
									<button
										key={tag.id}
										type="button"
										onClick={() => toggleTag(tag.id)}
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
					</div>
				)}
				<textarea
					value={body}
					onChange={(e) => setBody(e.target.value)}
					placeholder={i18n._(POST_BODY_PLACEHOLDER)}
					maxLength={4000}
					rows={5}
					style={{
						marginTop: 16,
						width: '100%',
						resize: 'vertical',
						padding: 10,
						borderRadius: 6,
						border: '1px solid var(--background-modifier-accent)',
						background: 'var(--input-background, var(--background-secondary))',
						color: 'var(--text-normal)',
						fontSize: 14,
						fontFamily: 'inherit',
						boxSizing: 'border-box',
					}}
					data-flx="channel.create-forum-post-modal.body"
				/>
			</Modal.Content>
			<Modal.Footer data-flx="channel.create-forum-post-modal.modal-footer">
				<Button onClick={ModalCommands.pop} variant="secondary" data-flx="channel.create-forum-post-modal.button.cancel">
					{i18n._(CANCEL_DESCRIPTOR)}
				</Button>
				<Button
					onClick={() => void onSubmit()}
					submitting={submitting}
					disabled={!title.trim()}
					data-flx="channel.create-forum-post-modal.button.submit"
				>
					{i18n._(CREATE_POST_DESCRIPTOR)}
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
