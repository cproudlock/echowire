// SPDX-License-Identifier: AGPL-3.0-or-later

import * as ThreadCommands from '@app/features/channel/commands/ThreadCommands';
import Channels from '@app/features/channel/state/Channels';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import GuildReadState from '@app/features/guild/state/GuildReadState';
import Permission from '@app/features/permissions/state/Permission';
import ReadStates from '@app/features/read_state/state/ReadStates';
import QuickSwitcher from '@app/features/search/state/QuickSwitcher';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {Channel} from '@fluxer/schema/src/domains/channel/ChannelSchemas';

interface ChannelPayload {
	id: string;
	type: number;
	guild_id?: string | null;
}

// Echowire: a channel that can hold threads brings its open threads with it when access arrives,
// and CHANNEL_CREATE says nothing about them. Reloading the guild's active thread list is the one
// authoritative answer, so it is used here rather than a second gateway event carrying its own.
// Coalesced per guild, because one role change can announce many channels at once.
const THREAD_PARENT_TYPES = new Set<number>([ChannelTypes.GUILD_TEXT, ChannelTypes.GUILD_FORUM]);
const THREAD_RELOAD_DELAY_MS = 500;
const pendingThreadReloads = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleThreadReload(guildId: string): void {
	const existing = pendingThreadReloads.get(guildId);
	if (existing) {
		clearTimeout(existing);
	}
	pendingThreadReloads.set(
		guildId,
		setTimeout(() => {
			pendingThreadReloads.delete(guildId);
			void ThreadCommands.listGuildActiveThreads(guildId);
		}, THREAD_RELOAD_DELAY_MS),
	);
}

export function handleChannelCreate(data: ChannelPayload, _context: GatewayHandlerContext): void {
	const channel = data as Channel;
	Channels.handleChannelCreate({channel});
	Permission.handleChannelUpdate(data.id);
	ReadStates.handleChannelCreate({channel});
	GuildReadState.handleGenericUpdate(data.id);
	QuickSwitcher.recomputeIfOpen();
	if (data.guild_id && THREAD_PARENT_TYPES.has(data.type)) {
		scheduleThreadReload(data.guild_id);
	}
}
