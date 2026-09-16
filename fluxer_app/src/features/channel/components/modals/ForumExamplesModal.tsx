// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the "See Examples" sheet behind an empty forum. Picking an idea opens the create-post
// modal with that title filled in. The ideas are client-side copy; nothing about them is stored.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {CreateForumPostModal} from '@app/features/channel/components/modals/CreateForumPostModal';
import styles from '@app/features/channel/components/modals/ForumExamplesModal.module.css';
import type {Channel} from '@app/features/channel/models/Channel';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const TITLE_DESCRIPTOR = msg({
	message: 'Post ideas',
	comment: 'Title of the sheet listing example first posts for an empty forum.',
});
const BODY_DESCRIPTOR = msg({
	message: 'Pick one to start a post, or write your own.',
	comment: 'Introduction above the example post ideas.',
});
const EXAMPLE_DESCRIPTORS = [
	msg({message: 'Introduce yourself', comment: 'Example forum post idea.'}),
	msg({message: 'Ask for help with something', comment: 'Example forum post idea.'}),
	msg({message: 'Share something you made', comment: 'Example forum post idea.'}),
	msg({message: 'Start a discussion', comment: 'Example forum post idea.'}),
	msg({message: 'Suggest an improvement', comment: 'Example forum post idea.'}),
];

export const ForumExamplesModal = observer(({channel}: {channel: Channel}) => {
	const {i18n} = useLingui();
	const startWith = (title: string) => {
		ModalCommands.pop();
		ModalCommands.push(modal(() => <CreateForumPostModal channel={channel} initialTitle={title} />));
	};
	return (
		<Modal.Root size="small" centered data-flx="channel.forum-examples-modal.modal-root">
			<Modal.Header title={i18n._(TITLE_DESCRIPTOR)} data-flx="channel.forum-examples-modal.modal-header" />
			<Modal.Content data-flx="channel.forum-examples-modal.modal-content">
				<p className={styles.intro}>{i18n._(BODY_DESCRIPTOR)}</p>
				<ul className={styles.list}>
					{EXAMPLE_DESCRIPTORS.map((descriptor) => {
						const label = i18n._(descriptor);
						return (
							<li key={label}>
								<button
									type="button"
									onClick={() => startWith(label)}
									className={styles.example}
									data-flx="channel.forum-examples-modal.example"
								>
									{label}
								</button>
							</li>
						);
					})}
				</ul>
			</Modal.Content>
			<Modal.Footer data-flx="channel.forum-examples-modal.modal-footer">
				<Button onClick={ModalCommands.pop} variant="secondary" data-flx="channel.forum-examples-modal.button.close">
					{i18n._(CANCEL_DESCRIPTOR)}
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
