// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the api and the gateway each decide who may see a thread, in TypeScript and in Erlang.
// The api tests used to prove the api against NoopGatewayService, which is a second TypeScript
// copy of the Erlang rules, so the two real implementations could drift without any test noticing.
//
// This test runs the production api rules (ThreadAccess.ts) against contracts/thread_visibility_
// cases.json, and thread_visibility_contract_test in guild_permissions_overwrites.erl runs the
// production gateway rules against the same file. A rule that changes on one side without the
// other fails here or there.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import type {ThreadMemberRepository} from '@app/api/channel/repositories/ThreadMemberRepository';
import {canAccessPrivateThread, hasPermissionBits, threadParentExists} from '@app/api/channel/services/ThreadAccess';
import type {Channel} from '@app/api/models/Channel';
import {type ChannelType, ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, test} from 'vitest';

interface ContractCase {
	name: string;
	thread_type: number;
	parent_permissions: Array<string>;
	parent_missing: boolean;
	user_id: string;
	member_ids: Array<string>;
	expect_can_view: boolean;
}

const CONTRACT_PATH = join(import.meta.dirname, '../../../../../contracts/thread_visibility_cases.json');

const PERMISSION_BITS: Record<string, bigint> = {
	VIEW_CHANNEL: Permissions.VIEW_CHANNEL,
	MANAGE_CHANNELS: Permissions.MANAGE_CHANNELS,
};

function loadCases(): Array<ContractCase> {
	const parsed = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as {cases: Array<ContractCase>};
	return parsed.cases;
}

function permissionsOf(names: Array<string>): bigint {
	return names.reduce((acc, name) => {
		const bit = PERMISSION_BITS[name];
		if (bit === undefined) {
			throw new Error(`Contract case names an unmapped permission: ${name}`);
		}
		return acc | bit;
	}, 0n);
}

const THREAD_ID = createChannelID(9000n);
const PARENT_ID = createChannelID(9001n);

// The fixture names a thread type by number, which is how both implementations see it on the wire.
function threadType(contractCase: ContractCase): ChannelType {
	switch (contractCase.thread_type) {
		case ChannelTypes.PUBLIC_THREAD:
			return ChannelTypes.PUBLIC_THREAD;
		case ChannelTypes.PRIVATE_THREAD:
			return ChannelTypes.PRIVATE_THREAD;
		default:
			throw new Error(`Contract case names a channel type that is not a thread: ${contractCase.thread_type}`);
	}
}

// An orphaned thread still stores its parent ID: the parent row is what has gone, which is why the
// lookup below is the thing that returns null.
function threadChannel(contractCase: ContractCase): Pick<Channel, 'id' | 'type' | 'parentId'> {
	return {
		id: THREAD_ID,
		type: threadType(contractCase),
		parentId: PARENT_ID,
	};
}

function channelLookup(contractCase: ContractCase) {
	return {
		findUnique: async (channelId: ReturnType<typeof createChannelID>) => {
			if (contractCase.parent_missing || channelId !== PARENT_ID) {
				return null;
			}
			return {id: PARENT_ID, type: ChannelTypes.GUILD_TEXT, isSoftDeleted: false} as unknown as Channel;
		},
	};
}

function threadMembers(contractCase: ContractCase): ThreadMemberRepository {
	return {
		getMember: async (_threadId: unknown, userId: unknown) =>
			contractCase.member_ids.includes(String(userId)) ? {userId} : null,
	} as unknown as ThreadMemberRepository;
}

// What the api grants, expressed as the one outcome the gateway also decides: can this user see
// this thread at all.
async function apiCanView(contractCase: ContractCase): Promise<boolean> {
	const channel = threadChannel(contractCase);
	if (!(await threadParentExists(channelLookup(contractCase), channel))) {
		return false;
	}
	const parentPermissions = permissionsOf(contractCase.parent_permissions);
	if (!hasPermissionBits(parentPermissions, Permissions.VIEW_CHANNEL)) {
		return false;
	}
	return canAccessPrivateThread({
		channel,
		userId: createUserID(BigInt(contractCase.user_id)),
		parentPermissions,
		threadMemberRepository: threadMembers(contractCase),
	});
}

describe('thread visibility contract', () => {
	const cases = loadCases();

	test('the contract file carries cases for both implementations', () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const contractCase of cases) {
			expect(
				contractCase.thread_type === ChannelTypes.PUBLIC_THREAD ||
					contractCase.thread_type === ChannelTypes.PRIVATE_THREAD,
			).toBe(true);
		}
	});

	test.each(
		cases.map((contractCase) => [contractCase.name, contractCase] as const),
	)('api agrees with the contract: %s', async (_name, contractCase) => {
		expect(await apiCanView(contractCase)).toBe(contractCase.expect_can_view);
	});
});
