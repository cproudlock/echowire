// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ANNOUNCEMENT_CONVERTIBLE_CHANNEL_TYPES,
	CHANNEL_FOLLOW_TARGET_TYPES,
	ChannelTypes,
	CROSSPOST_SERVER_FLAGS,
	GUILD_TEXT_BASED_CHANNEL_TYPES,
	isMessageTypeDeletable,
	MessageFlags,
	MessageTypes,
	Permissions,
	SENDABLE_MESSAGE_FLAGS,
	TEXT_BASED_CHANNEL_TYPES,
	WebhookTypes,
} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it} from 'vitest';

describe('announcement channel constants', () => {
	it('treats announcement channels as guild text-based channels', () => {
		expect(GUILD_TEXT_BASED_CHANNEL_TYPES.has(ChannelTypes.GUILD_ANNOUNCEMENT)).toBe(true);
		expect(TEXT_BASED_CHANNEL_TYPES.has(ChannelTypes.GUILD_ANNOUNCEMENT)).toBe(true);
	});

	it('converts only between text and announcement channels', () => {
		expect([...ANNOUNCEMENT_CONVERTIBLE_CHANNEL_TYPES].sort()).toEqual([
			ChannelTypes.GUILD_TEXT,
			ChannelTypes.GUILD_ANNOUNCEMENT,
		]);
	});

	it('lets follows post only into text channels', () => {
		expect([...CHANNEL_FOLLOW_TARGET_TYPES]).toEqual([ChannelTypes.GUILD_TEXT]);
	});

	it('lets members delete channel follow system messages', () => {
		expect(isMessageTypeDeletable(MessageTypes.CHANNEL_FOLLOW_ADD)).toBe(true);
	});

	it('keeps the crosspost flags out of the sendable flags', () => {
		expect(CROSSPOST_SERVER_FLAGS).toBe(
			MessageFlags.CROSSPOSTED | MessageFlags.IS_CROSSPOST | MessageFlags.SOURCE_MESSAGE_DELETED,
		);
		expect(CROSSPOST_SERVER_FLAGS & SENDABLE_MESSAGE_FLAGS).toBe(0);
	});

	it('names both webhook types', () => {
		expect(WebhookTypes).toEqual({INCOMING: 1, CHANNEL_FOLLOWER: 2});
	});
});

// Echowire: the fork's reserved wire values, asserted so that an upstream addition
// claiming one of them fails here instead of merging cleanly and changing what a
// number means. A collision is invisible to every other gate: both sides add a
// distinct name, git reports no conflict, and nothing type-checks the meaning.
//
// Why these particular numbers are safe, and why they are not moved. They are
// Discord's own values, reserved by the convention both sides already follow: the
// thread permission bits 34, 35, 36 and 38, channel types 11, 12 and 15, and message
// type 18. Bit 37 is skipped because Discord uses it for USE_EXTERNAL_STICKERS, which
// upstream holds. Upstream's own inventions sit above Discord's range, at permission
// bits 51 to 54 and channel types 998 and 999, so a fork-invented value should go
// high too rather than into a gap. For upstream to collide here it would have to
// implement threads at non-Discord numbers, and were it to use Discord's numbers the
// meaning would match ours anyway.
//
// Renumbering is also the worse remedy, which is why this is a guard and not a
// migration: role permissions are stored as bitmasks, so moving a bit means rewriting
// every stored role integer on live data, and desktop and mobile clients already in
// the field evaluate permissions locally from that mask.
describe('the fork reserved wire values', () => {
	const permissionsByBit = new Map<bigint, Array<string>>();
	for (const [name, value] of Object.entries(Permissions)) {
		const existing = permissionsByBit.get(value) ?? [];
		existing.push(name);
		permissionsByBit.set(value, existing);
	}

	it('keeps Discord thread permission bits for the fork thread permissions alone', () => {
		expect(permissionsByBit.get(1n << 34n)).toEqual(['MANAGE_THREADS']);
		expect(permissionsByBit.get(1n << 35n)).toEqual(['CREATE_PUBLIC_THREADS']);
		expect(permissionsByBit.get(1n << 36n)).toEqual(['CREATE_PRIVATE_THREADS']);
		expect(permissionsByBit.get(1n << 38n)).toEqual(['SEND_MESSAGES_IN_THREADS']);
	});

	it('leaves bit 37 to upstream, which holds Discord USE_EXTERNAL_STICKERS there', () => {
		expect(permissionsByBit.get(1n << 37n)).toEqual(['USE_EXTERNAL_STICKERS']);
	});

	it('gives every permission bit exactly one name', () => {
		const shared = [...permissionsByBit.entries()].filter(([, names]) => names.length > 1);
		expect(shared).toEqual([]);
	});

	it('keeps the fork channel types and message type unshared', () => {
		const typesByValue = new Map<number, Array<string>>();
		for (const [name, value] of Object.entries(ChannelTypes)) {
			const existing = typesByValue.get(value) ?? [];
			existing.push(name);
			typesByValue.set(value, existing);
		}
		expect(typesByValue.get(11)).toEqual(['PUBLIC_THREAD']);
		expect(typesByValue.get(12)).toEqual(['PRIVATE_THREAD']);
		expect(typesByValue.get(15)).toEqual(['GUILD_FORUM']);

		const messagesByValue = new Map<number, Array<string>>();
		for (const [name, value] of Object.entries(MessageTypes)) {
			const existing = messagesByValue.get(value) ?? [];
			existing.push(name);
			messagesByValue.set(value, existing);
		}
		expect(messagesByValue.get(18)).toEqual(['THREAD_CREATED']);
	});

	it('keeps the fork message flags clear of upstream crosspost bits', () => {
		const flagsByValue = new Map<number, Array<string>>();
		for (const [name, value] of Object.entries(MessageFlags)) {
			const existing = flagsByValue.get(value) ?? [];
			existing.push(name);
			flagsByValue.set(value, existing);
		}
		const shared = [...flagsByValue.entries()].filter(([, names]) => names.length > 1);
		expect(shared).toEqual([]);
	});
});
