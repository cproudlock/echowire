// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: threads and forum posts are channel rows and they sit in the gateway's channel index,
// so any count taken from that index includes them. The guild channel cap must be measured against
// real channels only: counting posts let a busy forum exhaust max_guild_channels and block channel
// creation permanently. Threads carry their own caps instead.

import type {Channel} from '@app/api/models/Channel';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';

export function countCapacityChannels(channels: ReadonlyArray<Pick<Channel, 'type'>>): number {
	return channels.filter((channel) => !THREAD_CHANNEL_TYPES.has(channel.type)).length;
}

export function countActiveThreads(
	channels: ReadonlyArray<Pick<Channel, 'type' | 'threadMetadata'>>,
): number {
	return channels.filter((channel) => THREAD_CHANNEL_TYPES.has(channel.type) && !channel.threadMetadata?.archived).length;
}
