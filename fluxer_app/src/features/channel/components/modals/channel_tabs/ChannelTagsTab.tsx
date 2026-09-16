// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: forum channel settings. Post guidelines (the topic), default reaction, default sort and
// layout, slowmode for new posts, how long posts stay open, the require-tag rule, and the forum's
// tags (add / rename / set emoji / delete). Everything saves in one PATCH; existing tags keep their id.

import * as ChannelCommands from '@app/features/channel/commands/ChannelCommands';
import styles from '@app/features/channel/components/modals/channel_tabs/ChannelTagsTab.module.css';
import Channels from '@app/features/channel/state/Channels';
import {supportsModeratedTags} from '@app/features/channel/utils/ForumPaneUtils';
import {
	ForumLayout,
	ForumSortOrder,
	resolveForumLayout,
	resolveForumSortOrder,
} from '@app/features/channel/utils/ForumPostUtils';
import {Button} from '@app/features/ui/button/Button';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {PlusIcon, TrashIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

interface EditableTag {
	id?: string;
	name: string;
	emojiName: string | null;
	// null on a server that does not report moderated tags, in which case the column is hidden.
	moderated: boolean | null;
}

const MAX_TAGS = 20;
const AUTO_ARCHIVE_OPTIONS = [
	{value: 60, label: msg({message: '1 hour', comment: 'Auto-archive duration option.'})},
	{value: 1440, label: msg({message: '24 hours', comment: 'Auto-archive duration option.'})},
	{value: 4320, label: msg({message: '3 days', comment: 'Auto-archive duration option.'})},
	{value: 10080, label: msg({message: '1 week', comment: 'Auto-archive duration option.'})},
] as const;
const POST_SLOWMODE_OPTIONS = [
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

const ChannelTagsTab = observer(({channelId}: {channelId: string}) => {
	const {t, i18n} = useLingui();
	const channel = Channels.getChannel(channelId);
	const [guidelines, setGuidelines] = useState(channel?.topic ?? '');
	const [defaultReaction, setDefaultReaction] = useState(channel?.defaultReactionEmoji?.emojiName ?? '');
	const [sortOrder, setSortOrder] = useState<number>(resolveForumSortOrder(channel?.defaultSortOrder));
	const [layout, setLayout] = useState<number>(resolveForumLayout(channel?.defaultForumLayout));
	const [postSlowmode, setPostSlowmode] = useState<number>(channel?.defaultThreadRateLimitPerUser ?? 0);
	const [tags, setTags] = useState<Array<EditableTag>>(() =>
		(channel?.availableTags ?? []).map((tag) => ({
			id: tag.id,
			name: tag.name,
			emojiName: tag.emojiName,
			moderated: tag.moderated,
		})),
	);
	const [requireTag, setRequireTag] = useState(channel?.forumRequireTag ?? false);
	const [defaultDuration, setDefaultDuration] = useState<number>(channel?.forumDefaultAutoArchiveDuration ?? 4320);
	const [saving, setSaving] = useState(false);
	// Echowire: moderated tags exist only where the server reports the field on its tags.
	const moderatedTagsSupported = supportsModeratedTags(channel?.availableTags ?? []);

	if (!channel) {
		return null;
	}

	const updateTag = (index: number, patch: Partial<EditableTag>) => {
		setTags((prev) => prev.map((tag, i) => (i === index ? {...tag, ...patch} : tag)));
	};
	const addTag = () => {
		if (tags.length >= MAX_TAGS) return;
		setTags((prev) => [...prev, {name: '', emojiName: null, moderated: moderatedTagsSupported ? false : null}]);
	};
	const removeTag = (index: number) => {
		setTags((prev) => prev.filter((_, i) => i !== index));
	};

	const save = async () => {
		const cleaned = tags.map((tag) => ({...tag, name: tag.name.trim()})).filter((tag) => tag.name.length > 0);
		const reaction = defaultReaction.trim();
		setSaving(true);
		try {
			await ChannelCommands.update(channelId, {
				type: ChannelTypes.GUILD_FORUM,
				topic: guidelines.trim().length > 0 ? guidelines : null,
				default_reaction_emoji: reaction.length > 0 ? {emoji_id: null, emoji_name: reaction} : null,
				default_sort_order: sortOrder,
				default_forum_layout: layout,
				default_thread_rate_limit_per_user: postSlowmode,
				available_tags: cleaned.map((tag) => ({
					id: tag.id,
					name: tag.name,
					emoji_name: tag.emojiName && tag.emojiName.length > 0 ? tag.emojiName : null,
					...(moderatedTagsSupported ? {moderated: tag.moderated === true} : {}),
				})),
				require_tag: requireTag,
				default_auto_archive_duration: defaultDuration,
			});
			ToastCommands.createToast({type: 'success', children: <Trans>Forum settings saved</Trans>});
		} catch {
			ToastCommands.createToast({type: 'error', children: <Trans>Couldn't save the forum settings</Trans>});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className={styles.root}>
			<section className={styles.section}>
				<label className={styles.label} htmlFor="forum-guidelines">
					<Trans>Post guidelines</Trans>
				</label>
				<div className={styles.hint}>
					<Trans>Shown to members when they start a post.</Trans>
				</div>
				<textarea
					id="forum-guidelines"
					className={styles.textarea}
					value={guidelines}
					onChange={(e) => setGuidelines(e.target.value)}
					rows={4}
					maxLength={1024}
				/>
			</section>

			<section className={styles.grid}>
				<div className={styles.field}>
					<label className={styles.label} htmlFor="forum-default-reaction">
						<Trans>Default reaction</Trans>
					</label>
					<input
						id="forum-default-reaction"
						type="text"
						className={styles.input}
						value={defaultReaction}
						onChange={(e) => setDefaultReaction(e.target.value)}
						placeholder="👍"
						maxLength={8}
					/>
				</div>
				<div className={styles.field}>
					<label className={styles.label} htmlFor="forum-default-sort">
						<Trans>Default sort order</Trans>
					</label>
					<select
						id="forum-default-sort"
						className={styles.input}
						value={sortOrder}
						onChange={(e) => setSortOrder(Number(e.target.value))}
					>
						<option value={ForumSortOrder.LATEST_ACTIVITY}>{t`Recently Active`}</option>
						<option value={ForumSortOrder.CREATION_DATE}>{t`Date Posted`}</option>
					</select>
				</div>
				<div className={styles.field}>
					<label className={styles.label} htmlFor="forum-default-layout">
						<Trans>Default layout</Trans>
					</label>
					<select
						id="forum-default-layout"
						className={styles.input}
						value={layout}
						onChange={(e) => setLayout(Number(e.target.value))}
					>
						<option value={ForumLayout.LIST}>{t`List`}</option>
						<option value={ForumLayout.GALLERY}>{t`Gallery`}</option>
					</select>
				</div>
				<div className={styles.field}>
					<label className={styles.label} htmlFor="forum-post-slowmode">
						<Trans>Slowmode in new posts</Trans>
					</label>
					<select
						id="forum-post-slowmode"
						className={styles.input}
						value={postSlowmode}
						onChange={(e) => setPostSlowmode(Number(e.target.value))}
					>
						{POST_SLOWMODE_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{i18n._(option.label)}
							</option>
						))}
					</select>
				</div>
				<div className={styles.field}>
					<label className={styles.label} htmlFor="forum-auto-archive">
						<Trans>Hide posts after inactivity</Trans>
					</label>
					<select
						id="forum-auto-archive"
						className={styles.input}
						value={defaultDuration}
						onChange={(e) => setDefaultDuration(Number(e.target.value))}
					>
						{AUTO_ARCHIVE_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{i18n._(option.label)}
							</option>
						))}
					</select>
				</div>
			</section>

			<div className={styles.separator} />

			<section className={styles.section}>
				<div className={styles.label}>
					<Trans>Tags</Trans>
				</div>
				<div className={styles.hint}>
					<Trans>Tags help members organize and filter posts in this forum (up to 20).</Trans>
				</div>
				<label className={styles.checkboxRow}>
					<input type="checkbox" checked={requireTag} onChange={(e) => setRequireTag(e.target.checked)} />
					<Trans>Require members to select a tag when posting</Trans>
				</label>
				{moderatedTagsSupported && (
					<div className={styles.hint}>
						<Trans>A moderated tag can only be applied by members who can manage threads.</Trans>
					</div>
				)}
				{tags.map((tag, index) => (
					<div key={index} className={styles.tagRow}>
						<input
							type="text"
							className={`${styles.input} ${styles.emojiInput}`}
							value={tag.emojiName ?? ''}
							onChange={(e) => updateTag(index, {emojiName: e.target.value || null})}
							placeholder="🙂"
							maxLength={8}
							aria-label={t`Tag emoji`}
						/>
						<input
							type="text"
							className={`${styles.input} ${styles.tagNameInput}`}
							value={tag.name}
							onChange={(e) => updateTag(index, {name: e.target.value})}
							placeholder={t`Tag name`}
							maxLength={20}
							aria-label={t`Tag name`}
						/>
						{moderatedTagsSupported && (
							<label className={styles.moderatedToggle}>
								<input
									type="checkbox"
									checked={tag.moderated === true}
									onChange={(e) => updateTag(index, {moderated: e.target.checked})}
								/>
								<Trans>Moderators only</Trans>
							</label>
						)}
						<button
							type="button"
							className={styles.deleteButton}
							onClick={() => removeTag(index)}
							aria-label={t`Delete tag`}
						>
							<TrashIcon size={18} />
						</button>
					</div>
				))}
				<div className={styles.actions}>
					<Button variant="secondary" onClick={addTag} disabled={tags.length >= MAX_TAGS}>
						<PlusIcon size={16} weight="bold" />
						<Trans>Add tag</Trans>
					</Button>
				</div>
			</section>

			<div className={styles.footer}>
				<Button onClick={() => void save()} submitting={saving}>
					<Trans>Save forum settings</Trans>
				</Button>
			</div>
		</div>
	);
});

export default ChannelTagsTab;
