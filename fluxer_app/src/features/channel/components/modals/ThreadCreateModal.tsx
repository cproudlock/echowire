// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: modal to create a thread under a text/forum channel.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {useFormSubmit} from '@app/features/app/hooks/useFormSubmit';
import {
	createThread,
	getDefaultValues,
	type ThreadFormInputs,
} from '@app/features/channel/utils/ThreadCreateModalUtils';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Form} from '@app/features/ui/components/form/Form';
import {Input} from '@app/features/ui/components/form/FormInput';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useForm} from 'react-hook-form';

const CREATE_THREAD_DESCRIPTOR = msg({
	message: 'Create Thread',
	comment: 'Title and submit button of the create-thread modal. Keep it concise.',
});
const THREAD_NAME_DESCRIPTOR = msg({
	message: 'Thread name',
	comment: 'Short label for the thread name field in the create-thread modal.',
});
const THREAD_NAME_PLACEHOLDER_DESCRIPTOR = msg({
	message: 'new-thread',
	comment: 'Placeholder example for the thread name field.',
});

export const ThreadCreateModal = observer(
	({guildId, parentChannelId}: {guildId: string; parentChannelId: string}) => {
		const {i18n} = useLingui();
		const form = useForm<ThreadFormInputs>({defaultValues: getDefaultValues()});
		const onSubmit = async (data: ThreadFormInputs) => {
			await createThread(guildId, parentChannelId, data);
		};
		const {handleSubmit} = useFormSubmit({form, onSubmit, defaultErrorField: 'name'});
		return (
			<Modal.Root size="small" centered data-flx="channel.thread-create-modal.modal-root">
				<Form form={form} onSubmit={handleSubmit} data-flx="channel.thread-create-modal.form.submit">
					<Modal.Header
						title={i18n._(CREATE_THREAD_DESCRIPTOR)}
						data-flx="channel.thread-create-modal.modal-header"
					/>
					<Modal.Content data-flx="channel.thread-create-modal.modal-content">
						<Input
							data-flx="channel.thread-create-modal.input"
							{...form.register('name')}
							autoComplete="off"
							autoFocus={true}
							error={form.formState.errors.name?.message}
							label={i18n._(THREAD_NAME_DESCRIPTOR)}
							maxLength={100}
							minLength={1}
							placeholder={i18n._(THREAD_NAME_PLACEHOLDER_DESCRIPTOR)}
							required={true}
						/>
					</Modal.Content>
					<Modal.Footer data-flx="channel.thread-create-modal.modal-footer">
						<Button
							onClick={ModalCommands.pop}
							variant="secondary"
							data-flx="channel.thread-create-modal.button.pop"
						>
							{i18n._(CANCEL_DESCRIPTOR)}
						</Button>
						<Button
							type="submit"
							submitting={form.formState.isSubmitting}
							data-flx="channel.thread-create-modal.button.submit"
						>
							{i18n._(CREATE_THREAD_DESCRIPTOR)}
						</Button>
					</Modal.Footer>
				</Form>
			</Modal.Root>
		);
	},
);
