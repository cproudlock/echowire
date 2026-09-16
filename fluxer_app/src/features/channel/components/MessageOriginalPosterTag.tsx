// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the "OP" pill beside the name of whoever started the thread or forum post. Reuses the
// bot tag styling so the two pills sit together consistently.

import styles from '@app/features/channel/components/ChannelUserTag.module.css';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import React from 'react';

const ORIGINAL_POSTER_DESCRIPTOR = msg({
	message: 'OP',
	comment: 'Short pill marking messages by the member who started a thread or forum post.',
});
const ORIGINAL_POSTER_TITLE_DESCRIPTOR = msg({
	message: 'Original poster',
	comment: 'Tooltip of the OP pill.',
});

export const OriginalPosterTag = React.forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<'span'>>(
	({className, ...props}, ref) => {
		const {i18n} = useLingui();
		return (
			<span
				className={clsx(styles.tag, styles.tagSm, className)}
				title={i18n._(ORIGINAL_POSTER_TITLE_DESCRIPTOR)}
				ref={ref}
				data-flx="channel.original-poster-tag.tag"
				{...props}
			>
				<span className={clsx(styles.text, styles.textSm)} data-flx="channel.original-poster-tag.text">
					{i18n._(ORIGINAL_POSTER_DESCRIPTOR)}
				</span>
			</span>
		);
	},
);

OriginalPosterTag.displayName = 'OriginalPosterTag';
