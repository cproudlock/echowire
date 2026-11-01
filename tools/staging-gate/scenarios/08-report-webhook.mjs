// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {check, checkStatus, GateError} from '../lib/ctx.mjs';

export const name = 'a user report posts a tagged thread with an embed to the review forum';

const ENV_KEYS = ['FLUXER_REPORT_WEBHOOK_URL', 'FLUXER_REGISTRATION_PENDING_WEBHOOK_URL'];

// `down -v` wipes the database, so the stage .env still names the PREVIOUS run's webhook. Point it at the
// webhook this run created, or the report posts nowhere and looks like a product failure.
function writeWebhookEnv(stageDir, webhookUrl) {
	const file = path.join(stageDir, '.env');
	let text = fs.readFileSync(file, 'utf8');
	for (const key of ENV_KEYS) {
		const line = `${key}=${webhookUrl}`;
		text = new RegExp(`^${key}=.*$`, 'm').test(text)
			? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
			: `${text.trimEnd()}\n${line}\n`;
	}
	fs.writeFileSync(file, text);
}

async function waitApiHealthy(ctx) {
	const deadline = Date.now() + 180000;
	while (Date.now() < deadline) {
		const ps = JSON.parse(
			`[${ctx.compose(['ps', 'api', '--format', 'json']).trim().split('\n').filter(Boolean).join(',')}]`,
		);
		if (ps.some((c) => c.State === 'running' && c.Health === 'healthy')) {
			const res = await ctx.http('GET', '/api/v1/_health').catch(() => null);
			if (res?.status === 200) return;
		}
		await ctx.sleep(3000);
	}
	throw new GateError('api did not become healthy after it was recreated with the new webhook');
}

async function waitForReportThread(ctx, forumId, timeoutMs) {
	const sql = `select row_data->'thread_id'->>'value' from fluxer_kv where table_name='active_threads_by_guild' and row_data->'parent_id'->>'value'='${forumId}'`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = ctx.psql(sql).split('\n').filter(Boolean);
		if (found.length > 0) return found[0];
		await ctx.sleep(1500);
	}
	throw new GateError(`no thread appeared in the review forum within ${timeoutMs / 1000}s (webhook not posting?)`);
}

export async function run(ctx) {
	const owner = ctx.state.userA;
	check(ctx.state.guildId, 'no guild from scenario 05');
	const target = await ctx.newClaimedUser('target');
	const me = await ctx.call('GET', '/users/@me', target.token);
	checkStatus(me, 200, 'GET /users/@me for the reported user');
	const targetId = me.json.id;

	const forum = await ctx.call('POST', `/guilds/${ctx.state.guildId}/channels`, owner.token, {
		name: 'reports',
		type: 15,
	});
	checkStatus(forum, 200, 'create the review forum');
	const patched = await ctx.call('PATCH', `/channels/${forum.json.id}`, owner.token, {
		available_tags: [{name: 'new', moderated: false}],
	});
	checkStatus(patched, 200, 'add the "new" tag');
	const tagId = patched.json?.available_tags?.[0]?.id;
	check(tagId, 'the "new" tag has no id');
	const hook = await ctx.call('POST', `/channels/${forum.json.id}/webhooks`, owner.token, {name: 'reports'});
	checkStatus(hook, 200, 'create the webhook');
	check(hook.json?.id && hook.json?.token, 'the webhook response has no id or token');

	writeWebhookEnv(ctx.stageDir, `http://edge:8080/api/webhooks/${hook.json.id}/${hook.json.token}`);
	ctx.compose(['up', '-d', 'api']);
	await waitApiHealthy(ctx);
	ctx.flushCache();
	await ctx.sleep(1500);

	const report = await ctx.call('POST', '/reports/user', owner.token, {user_id: targetId, category: 'other'});
	checkStatus(report, [200, 201], 'file the user report');
	const threadId = await waitForReportThread(ctx, forum.json.id, 45000);
	const thread = await ctx.call('GET', `/channels/${threadId}`, owner.token);
	checkStatus(thread, 200, 'read the report thread');
	check(
		(thread.json?.applied_tags ?? []).includes(tagId),
		`the report thread did not get the "new" tag (applied_tags: ${JSON.stringify(thread.json?.applied_tags)})`,
	);
	const messages = await ctx.call('GET', `/channels/${threadId}/messages?limit=5`, owner.token);
	checkStatus(messages, 200, 'read the report thread messages');
	const embeds = (messages.json ?? []).flatMap((m) => m.embeds ?? []);
	check(embeds.length > 0, 'the report thread has no embed');
	return `thread ${threadId}, tag new, ${embeds.length} embed(s)`;
}
