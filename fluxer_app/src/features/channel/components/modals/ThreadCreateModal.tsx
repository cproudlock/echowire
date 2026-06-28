// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: modal to create a thread under a text/forum channel.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {useFormSubmit} from '@app/features/app/hooks/useFormSubmit';
import {
	AUTO_ARCHIVE_OPTIONS,
	createThread,
	deriveThreadNameFromMessage,
	getDefaultValues,
	type ThreadFormInputs,
} from '@app/features/channel/utils/ThreadCreateModalUtils';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Form} from '@app/features/ui/components/form/Form';
import {Input} from '@app/features/ui/components/form/FormInput';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {Controller, useForm} from 'react-hook-form';

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
const AUTO_ARCHIVE_DESCRIPTOR = msg({
	message: 'Hide after inactivity',
	comment: 'Label for the auto-archive duration selector in the create-thread modal.',
});
const STARTING_FROM_DESCRIPTOR = msg({
	message: 'Starting thread from this message',
	comment: 'Label above the source-message preview when creating a thread from a message.',
});

export const ThreadCreateModal = observer(
	({
		guildId,
		parentChannelId,
		starterMessageId,
		starterMessageContent,
		starterMessageAuthor,
	}: {
		guildId: string;
		parentChannelId: string;
		starterMessageId?: string;
		starterMessageContent?: string;
		starterMessageAuthor?: string;
	}) => {
		const {i18n} = useLingui();
		const form = useForm<ThreadFormInputs>({
			defaultValues: getDefaultValues(deriveThreadNameFromMessage(starterMessageContent)),
		});
		const onSubmit = async (data: ThreadFormInputs) => {
			await createThread(guildId, parentChannelId, data, starterMessageId);
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
						{starterMessageContent != null && starterMessageContent.length > 0 && (
							<div
								data-flx="channel.thread-create-modal.starter-preview"
								style={{
									marginBottom: 16,
									padding: '8px 12px',
									borderRadius: 6,
									background: 'var(--background-secondary)',
									borderLeft: '3px solid var(--brand-experiment, #5865f2)',
								}}
							>
								<div style={{marginBottom: 4, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)'}}>
									{i18n._(STARTING_FROM_DESCRIPTOR)}
								</div>
								<div style={{fontSize: 13, color: 'var(--text-normal)'}}>
									{starterMessageAuthor != null && starterMessageAuthor.length > 0 && (
										<span style={{fontWeight: 600, marginRight: 6}}>{starterMessageAuthor}</span>
									)}
									<span
										style={{
											display: '-webkit-box',
											WebkitLineClamp: 3,
											WebkitBoxOrient: 'vertical',
											overflow: 'hidden',
											wordBreak: 'break-word',
										}}
									>
										{starterMessageContent}
									</span>
								</div>
							</div>
						)}
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
						<div style={{marginTop: 16}}>
							<div style={{marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #b5bac1)'}}>
								{i18n._(AUTO_ARCHIVE_DESCRIPTOR)}
							</div>
							<Controller
								name="autoArchiveDuration"
								control={form.control}
								render={({field}) => (
									<RadioGroup
										aria-label={i18n._(AUTO_ARCHIVE_DESCRIPTOR)}
										value={Number(field.value)}
										onChange={(value) => field.onChange(value.toString())}
										options={AUTO_ARCHIVE_OPTIONS.map((o) => ({value: o.value, name: o.name, desc: ''}))}
										data-flx="channel.thread-create-modal.auto-archive-radio-group"
									/>
								)}
							/>
						</div>
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
