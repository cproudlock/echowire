// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

export const name = 'forum channel, thread and reply';

export async function run(ctx) {
	const user = ctx.state.userA;
	check(ctx.state.guildId, 'no guild from scenario 05');
	const forum = await ctx.call('POST', `/guilds/${ctx.state.guildId}/channels`, user.token, {name: 'forum', type: 15});
	checkStatus(forum, 200, 'create forum channel');
	const thread = await ctx.call('POST', `/channels/${forum.json.id}/threads`, user.token, {
		name: 'first post',
		message: {content: 'hello thread'},
	});
	checkStatus(thread, [200, 201], 'create forum thread');
	check(thread.json?.id, 'create thread returned no id');
	const reply = await ctx.call('POST', `/channels/${thread.json.id}/messages`, user.token, {content: 'a reply'});
	checkStatus(reply, 200, 'reply in thread');
	const messages = await ctx.call('GET', `/channels/${thread.json.id}/messages?limit=10`, user.token);
	checkStatus(messages, 200, 'list thread messages');
	check(
		(messages.json ?? []).some((m) => m.content === 'a reply'),
		'the reply is not in the thread',
	);
	return `thread ${thread.json.id}`;
}
