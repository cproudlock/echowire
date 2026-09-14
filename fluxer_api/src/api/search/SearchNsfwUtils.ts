// SPDX-License-Identifier: AGPL-3.0-or-later

import {channelToContentWarningView, computeEffectiveChannelNsfw} from '@app/api/channel/utils/EffectiveContentWarning';
import type {Channel} from '@app/api/models/Channel';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {ContentWarningLevel} from '@fluxer/constants/src/GuildConstants';

export function channelRequiresAgeVerification(
	channel: Channel,
	channelsById: ReadonlyMap<string, Channel>,
	guildNsfw: boolean,
): boolean {
	// Echowire: a thread takes its age gate from its parent channel and that channel's category, not
	// from the nsfw value copied onto the thread when it was created. A thread whose parent is not
	// in the lookup is treated as gated.
	if (THREAD_CHANNEL_TYPES.has(channel.type)) {
		const parent = channel.parentId != null ? channelsById.get(channel.parentId.toString()) : undefined;
		return parent ? channelRequiresAgeVerification(parent, channelsById, guildNsfw) : true;
	}
	const parentCategory = channel.parentId != null ? (channelsById.get(channel.parentId.toString()) ?? null) : null;
	return computeEffectiveChannelNsfw(
		channelToContentWarningView(channel),
		parentCategory ? channelToContentWarningView(parentCategory) : null,
		{nsfw: guildNsfw, contentWarningLevel: ContentWarningLevel.INHERIT, contentWarningText: null},
	);
}
