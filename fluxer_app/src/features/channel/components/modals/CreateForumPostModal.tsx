// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: create a forum post, a thread under a GUILD_FORUM channel with applied tags and a
// first message. The forum's guidelines (its topic) sit at the top. The thread and tags are
// created server-side, the first message is then sent into the new thread via the normal message
// path, and we navigate into it.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import {ForumTagChip} from '@app/features/channel/components/forum/ForumTagChip';
import styles from '@app/features/channel/components/modals/CreateForumPostModal.module.css';
import type {Channel} from '@app/features/channel/models/Channel';
import {selectableForumTags} from '@app/features/channel/utils/ForumPaneUtils';
import {canModerateThreads} from '@app/features/channel/utils/ThreadActions';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as MessageCommands from '@app/features/messaging/commands/MessageCommands';
import {selectChannel} from '@app/features/navigation/commands/NavigationCommands';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const MAX_APPLIED_TAGS = 5;

const CREATE_POST_DESCRIPTOR = msg({message: 'Create Post', comment: 'Title/submit of the forum create-post modal.'});
const POST_TITLE_DESCRIPTOR = msg({message: 'Post title', comment: 'Label for the forum post title field.'});
const POST_TITLE_PLACEHOLDER = msg({message: 'New post', comment: 'Placeholder for the forum post title.'});
const POST_BODY_PLACEHOLDER = msg({message: 'Write something…', comment: 'Placeholder for the forum post body.'});
const TAGS_DESCRIPTOR = msg({message: 'Tags', comment: 'Label above the forum tag selector.'});
const TAGS_REQUIRED_DESCRIPTOR = msg({
	message: 'Tags (pick at least one)',
	comment: 'Label above the forum tag selector when the forum requires a tag on every post.',
});
const GUIDELINES_DESCRIPTOR = msg({
	message: 'Post guidelines',
	comment: "Heading above the forum's posting guidelines in the create-post modal.",
});

export const CreateForumPostModal = observer(
	({channel, initialTitle = ''}: {channel: Channel; initialTitle?: string}) => {
		const {i18n} = useLingui();
		const guildId = channel.guildId;
		const [title, setTitle] = useState(initialTitle);
		const [body, setBody] = useState('');
		const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
		const [submitting, setSubmitting] = useState(false);
		const canSubmit = title.trim().length > 0 && (!channel.forumRequireTag || selectedTagIds.size > 0);
		// Moderated tags are moderator-only, matching the server rule.
		const selectableTags = selectableForumTags(channel.availableTags, {
			canManage: canModerateThreads({channelId: channel.id, guildId: channel.guildId ?? undefined}),
		});

		const toggleTag = (tagId: string) => {
			setSelectedTagIds((prev) => {
				const next = new Set(prev);
				if (next.has(tagId)) next.delete(tagId);
				else if (next.size < MAX_APPLIED_TAGS) next.add(tagId);
				return next;
			});
		};

		const onSubmit = async () => {
			if (!guildId || !canSubmit || submitting) return;
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
			} catch {
				ToastCommands.createToast({
					type: 'error',
					children: <Trans>Couldn't create the post. You may be posting too quickly; try again shortly.</Trans>,
				});
			} finally {
				setSubmitting(false);
			}
		};

		if (!guildId) {
			return null;
		}
		const guidelines = channel.topic?.trim();
		return (
			<Modal.Root size="small" centered data-flx="channel.create-forum-post-modal.modal-root">
				<Modal.Header title={i18n._(CREATE_POST_DESCRIPTOR)} data-flx="channel.create-forum-post-modal.modal-header" />
				<Modal.Content data-flx="channel.create-forum-post-modal.modal-content">
					<div className={styles.fields}>
						{guidelines && (
							<div className={styles.guidelines} data-flx="channel.create-forum-post-modal.guidelines">
								<div className={styles.label}>{i18n._(GUIDELINES_DESCRIPTOR)}</div>
								<div className={styles.guidelinesText}>{guidelines}</div>
							</div>
						)}
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
						{selectableTags.length > 0 && (
							<div className={styles.field}>
								<div className={styles.label}>
									{i18n._(channel.forumRequireTag ? TAGS_REQUIRED_DESCRIPTOR : TAGS_DESCRIPTOR)}
								</div>
								<div className={styles.tags}>
									{selectableTags.map((tag) => (
										<ForumTagChip
											key={tag.id}
											tag={tag}
											selected={selectedTagIds.has(tag.id)}
											onToggle={() => toggleTag(tag.id)}
										/>
									))}
								</div>
							</div>
						)}
						<textarea
							value={body}
							onChange={(e) => setBody(e.target.value)}
							placeholder={i18n._(POST_BODY_PLACEHOLDER)}
							maxLength={4000}
							rows={5}
							className={styles.body}
							data-flx="channel.create-forum-post-modal.body"
						/>
					</div>
				</Modal.Content>
				<Modal.Footer data-flx="channel.create-forum-post-modal.modal-footer">
					<Button
						onClick={ModalCommands.pop}
						variant="secondary"
						data-flx="channel.create-forum-post-modal.button.cancel"
					>
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
					<Button
						onClick={() => void onSubmit()}
						submitting={submitting}
						disabled={!canSubmit}
						data-flx="channel.create-forum-post-modal.button.submit"
					>
						{i18n._(CREATE_POST_DESCRIPTOR)}
					</Button>
				</Modal.Footer>
			</Modal.Root>
		);
	},
);
