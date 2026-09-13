// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: a forum tag pill. Static when showing a post's tags, a toggle when filtering or
// choosing tags.

import styles from '@app/features/channel/components/forum/ForumTagChip.module.css';
import {clsx} from 'clsx';

interface ForumTagChipProps {
	tag: {readonly id: string; readonly name: string; readonly emojiName: string | null};
	selected?: boolean;
	onToggle?: () => void;
	size?: 'small' | 'medium';
}

export function ForumTagChip({tag, selected = false, onToggle, size = 'medium'}: ForumTagChipProps) {
	const content = (
		<>
			{tag.emojiName && <span className={styles.emoji}>{tag.emojiName}</span>}
			<span className={styles.name}>{tag.name}</span>
		</>
	);
	if (!onToggle) {
		return (
			<span className={clsx(styles.chip, styles.static, size === 'small' && styles.small)} data-flx="channel.forum-tag">
				{content}
			</span>
		);
	}
	return (
		<button
			type="button"
			aria-pressed={selected}
			onClick={onToggle}
			className={clsx(styles.chip, styles.toggle, selected && styles.selected, size === 'small' && styles.small)}
			data-flx="channel.forum-tag-toggle"
		>
			{content}
		</button>
	);
}
