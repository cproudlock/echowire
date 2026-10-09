// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the "See Examples" button on an empty forum and the sheet behind it. Picking an idea
// hands its title to the forum's own new-post composer. The ideas are client-side copy; nothing
// about them is stored.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import type {Channel} from '@app/features/channel/models/Channel';
import styles from '@app/features/forum/components/ForumExamples.module.css';
import {
	FORUM_EXAMPLE_IDEA_DESCRIPTORS,
	FORUM_EXAMPLES_INTRO_DESCRIPTOR,
	FORUM_EXAMPLES_TITLE_DESCRIPTOR,
	FORUM_SEE_EXAMPLES_DESCRIPTOR,
} from '@app/features/forum/utils/ForumEchowireDescriptors';
import {canCreatePost} from '@app/features/forum/utils/ForumPermissions';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const ForumExamplesModal = observer(({onPick}: {onPick: (title: string) => void}) => {
	const {i18n} = useLingui();
	const startWith = (title: string) => {
		ModalCommands.pop();
		onPick(title);
	};
	return (
		<Modal.Root size="small" centered data-flx="forum.forum-examples.modal-root">
			<Modal.Header title={i18n._(FORUM_EXAMPLES_TITLE_DESCRIPTOR)} data-flx="forum.forum-examples.modal-header" />
			<Modal.Content data-flx="forum.forum-examples.modal-content">
				<p className={styles.intro} data-flx="forum.forum-examples.forum-examples-modal.intro">
					{i18n._(FORUM_EXAMPLES_INTRO_DESCRIPTOR)}
				</p>
				<ul className={styles.list} data-flx="forum.forum-examples.forum-examples-modal.list">
					{FORUM_EXAMPLE_IDEA_DESCRIPTORS.map((descriptor) => {
						const label = i18n._(descriptor);
						return (
							<li key={label} data-flx="forum.forum-examples.forum-examples-modal.li">
								<button
									type="button"
									onClick={() => startWith(label)}
									className={styles.example}
									data-flx="forum.forum-examples.example"
								>
									{label}
								</button>
							</li>
						);
					})}
				</ul>
			</Modal.Content>
			<Modal.Footer data-flx="forum.forum-examples.modal-footer">
				<Button onClick={ModalCommands.pop} variant="secondary" data-flx="forum.forum-examples.button.close">
					{i18n._(CANCEL_DESCRIPTOR)}
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});

export const ForumExamplesButton = observer(({forum, onPick}: {forum: Channel; onPick: (title: string) => void}) => {
	const {i18n} = useLingui();
	if (!canCreatePost(forum)) return null;
	return (
		<Button
			small
			fitContent
			variant="secondary"
			onClick={() =>
				ModalCommands.push(
					modal(() => (
						<ForumExamplesModal
							onPick={onPick}
							data-flx="forum.forum-examples.forum-examples-button.forum-examples-modal"
						/>
					)),
				)
			}
			data-flx="forum.forum-examples.button.see-examples"
		>
			{i18n._(FORUM_SEE_EXAMPLES_DESCRIPTOR)}
		</Button>
	);
});
