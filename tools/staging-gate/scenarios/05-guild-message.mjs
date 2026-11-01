// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'guild, text channel and message round trip';

export async function run(ctx) {
	const user = ctx.state.userA;
	check(user?.id, 'no claimed user from scenario 03');
	const guild = await ctx.call('POST', '/guilds', user.token, {name: 'gate guild'});
	checkStatus(guild, 200, 'create guild');
	const guildId = guild.json?.id;
	check(guildId, 'create guild returned no id');
	const channels = await ctx.call('GET', `/guilds/${guildId}/channels`, user.token);
	checkStatus(channels, 200, 'list channels');
	const text = (channels.json ?? []).find((c) => c.type === 0);
	check(text, 'the new guild has no text channel');
	const content = `gate message ${Date.now()}`;
	checkStatus(await ctx.call('POST', `/channels/${text.id}/messages`, user.token, {content}), 200, 'post message');
	const list = await ctx.call('GET', `/channels/${text.id}/messages?limit=10`, user.token);
	checkStatus(list, 200, 'list messages');
	check(
		(list.json ?? []).some((m) => m.content === content),
		'the posted message is not in the channel',
	);
	ctx.state.guildId = guildId;
	ctx.state.textChannelId = text.id;
	return `guild ${guildId}`;
}
