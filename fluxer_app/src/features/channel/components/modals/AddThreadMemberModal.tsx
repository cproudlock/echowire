// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: add a guild member to a thread or forum post. The server decides who may add and
// refuses a target who cannot see the parent channel, so this lists the guild's members and
// reports what the server says rather than trying to predict it.

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {
	getOverrideMemberLabel,
	selectOverrideMembers,
} from '@app/features/app/components/dialogs/shared/AddOverrideMemberSearch';
import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import styles from '@app/features/channel/components/modals/AddThreadMemberModal.module.css';
import type {Channel} from '@app/features/channel/models/Channel';
import ThreadMembers from '@app/features/channel/state/ThreadMembers';
import {classifyThreadMemberFailure} from '@app/features/channel/utils/ThreadMemberActions';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import GuildMembers from '@app/features/member/state/GuildMembers';
import MemberSearch, {type SearchContext} from '@app/features/member/state/MemberSearch';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import {Input} from '@app/features/ui/components/form/FormInput';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {MagnifyingGlassIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useMemo, useRef, useState} from 'react';

const MEMBERS_LIMIT = 20;
const WORKER_RESULT_LIMIT = 25;
const SERVER_DEBOUNCE_MS = 300;

const SEARCH_MEMBERS_DESCRIPTOR = msg({
	message: 'Search members',
	comment: 'Placeholder in the search box for adding someone to a thread or forum post.',
});
const ADD_MEMBER_DESCRIPTOR = msg({
	message: 'Add member',
	comment: 'Title of the dialog for adding someone to a thread or forum post.',
});

export const AddThreadMemberModal = observer(({thread}: {thread: Channel}) => {
	const {i18n} = useLingui();
	const guildId = thread.guildId ?? '';
	const [searchQuery, setSearchQuery] = useState('');
	const [serverMemberIds, setServerMemberIds] = useState<Array<string>>([]);
	const [pendingUserId, setPendingUserId] = useState<string | null>(null);
	const searchContextRef = useRef<SearchContext | null>(null);
	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
	const existingMemberIds = useMemo(
		() => new Set(ThreadMembers.getMembers(thread.id).map((member) => member.userId)),
		[thread.id],
	);

	useEffect(() => {
		const context = MemberSearch.getSearchContext((results) => {
			setServerMemberIds(results.map((result) => result.id));
		}, WORKER_RESULT_LIMIT);
		searchContextRef.current = context;
		return () => {
			context.destroy();
			searchContextRef.current = null;
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		const trimmed = searchQuery.trim();
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
		const context = searchContextRef.current;
		if (trimmed.length === 0) {
			context?.cancelSearch();
			setServerMemberIds([]);
			return;
		}
		context?.beginSearch(trimmed, {guild: guildId});
		if (GuildMembers.isGuildFullyLoaded(guildId)) {
			return;
		}
		debounceTimerRef.current = setTimeout(() => {
			debounceTimerRef.current = null;
			void MemberSearch.fetchMembersInBackground(trimmed, [guildId], guildId);
		}, SERVER_DEBOUNCE_MS);
	}, [searchQuery, guildId]);

	const members = useMemo(() => {
		if (!guildId) return [];
		return selectOverrideMembers({
			cachedMembers: GuildMembers.getMembers(guildId),
			workerMemberIds: serverMemberIds,
			resolveMember: (userId) => GuildMembers.getMember(guildId, userId),
			excludedIds: existingMemberIds,
			guildId,
			query: searchQuery,
			limit: MEMBERS_LIMIT,
		});
	}, [guildId, existingMemberIds, searchQuery, serverMemberIds]);

	const add = async (userId: string) => {
		setPendingUserId(userId);
		try {
			await ThreadCommands.addThreadMember(thread.id, userId);
			ModalCommands.pop();
		} catch (error) {
			const failure = classifyThreadMemberFailure(failureCode(error));
			ToastCommands.createToast({
				type: 'error',
				children:
					failure === 'cap' ? (
						<Trans>This thread is full, so nobody else can be added.</Trans>
					) : failure === 'unknown_member' ? (
						<Trans>That member can't see this channel, so they can't be added.</Trans>
					) : failure === 'forbidden' ? (
						<Trans>You don't have permission to add members here.</Trans>
					) : (
						<Trans>Couldn't add that member. Try again.</Trans>
					),
			});
		} finally {
			setPendingUserId(null);
		}
	};

	return (
		<Modal.Root size="small" centered data-flx="channel.add-thread-member-modal.modal-root">
			<Modal.Header title={i18n._(ADD_MEMBER_DESCRIPTOR)} data-flx="channel.add-thread-member-modal.modal-header" />
			<Modal.Content data-flx="channel.add-thread-member-modal.modal-content">
				<Input
					value={searchQuery}
					onChange={(event) => setSearchQuery(event.target.value)}
					placeholder={i18n._(SEARCH_MEMBERS_DESCRIPTOR)}
					autoComplete="off"
					autoFocus={true}
					leftIcon={<MagnifyingGlassIcon size={16} />}
					data-flx="channel.add-thread-member-modal.search"
				/>
				<div className={styles.list}>
					{members.length === 0 ? (
						<div className={styles.empty}>
							<Trans>No members to add.</Trans>
						</div>
					) : (
						members.map((member) => {
							const label = getOverrideMemberLabel(member, guildId);
							return (
								<button
									key={member.user.id}
									type="button"
									className={styles.row}
									disabled={pendingUserId !== null}
									onClick={() => void add(member.user.id)}
									data-flx="channel.add-thread-member-modal.row"
								>
									<Avatar user={member.user} size={24} guildId={guildId} />
									<span className={styles.rowLabel}>{label}</span>
								</button>
							);
						})
					)}
				</div>
			</Modal.Content>
			<Modal.Footer data-flx="channel.add-thread-member-modal.modal-footer">
				<Button
					onClick={ModalCommands.pop}
					variant="secondary"
					data-flx="channel.add-thread-member-modal.button.cancel"
				>
					{i18n._(CANCEL_DESCRIPTOR)}
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
