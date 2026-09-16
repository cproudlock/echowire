// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the guild channel cap must ignore threads and forum posts. They are channel rows in
// the same index, so counting them let a forum with enough posts exhaust max_guild_channels and
// block channel creation for good.

import {countActiveThreads, countCapacityChannels} from '@app/api/channel/services/ChannelCapacity';
import type {Channel} from '@app/api/models/Channel';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, test} from 'vitest';

type CapacityChannel = Pick<Channel, 'type' | 'threadMetadata'>;

function channel(type: number, archived?: boolean): CapacityChannel {
	return {
		type,
		threadMetadata: archived === undefined ? null : {archived, autoArchiveDuration: 1440},
	} as CapacityChannel;
}

describe('channel capacity counting', () => {
	test('counts real channels and ignores threads and forum posts', () => {
		const channels = [
			channel(ChannelTypes.GUILD_TEXT),
			channel(ChannelTypes.GUILD_VOICE),
			channel(ChannelTypes.GUILD_CATEGORY),
			channel(ChannelTypes.GUILD_FORUM),
			channel(ChannelTypes.PUBLIC_THREAD, false),
			channel(ChannelTypes.PUBLIC_THREAD, true),
			channel(ChannelTypes.PRIVATE_THREAD, false),
		];

		expect(countCapacityChannels(channels)).toBe(4);
	});

	test('counts only active threads towards the thread caps', () => {
		const channels = [
			channel(ChannelTypes.GUILD_FORUM),
			channel(ChannelTypes.PUBLIC_THREAD, false),
			channel(ChannelTypes.PUBLIC_THREAD, true),
			channel(ChannelTypes.PRIVATE_THREAD, false),
		];

		expect(countActiveThreads(channels)).toBe(2);
	});

	test('a forum full of posts leaves the channel cap untouched', () => {
		const posts = Array.from({length: 600}, () => channel(ChannelTypes.PUBLIC_THREAD, false));

		expect(countCapacityChannels([channel(ChannelTypes.GUILD_FORUM), ...posts])).toBe(1);
	});
});
