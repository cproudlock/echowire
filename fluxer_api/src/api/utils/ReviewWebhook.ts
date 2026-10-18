// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';

const REVIEW_WEBHOOK_TIMEOUT_MS = 5000;
const THREAD_NAME_MAX_LENGTH = 100;

function clampThreadName(name: string): string {
	const oneLine = name.replace(/\s+/g, ' ').trim();
	return oneLine.length <= THREAD_NAME_MAX_LENGTH ? oneLine : `${oneLine.slice(0, THREAD_NAME_MAX_LENGTH - 1)}…`;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REVIEW_WEBHOOK_TIMEOUT_MS);
	try {
		return await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Looks up the id of an unmoderated tag with the given name on the forum that owns the webhook, so operators
 * can set a tag by name instead of copying ids. Returns undefined when the webhook is not on a forum, no such
 * tag exists, or the tag is moderated (a webhook cannot apply a moderated tag).
 */
export async function resolveForumTagId(url: string, tagName: string | undefined): Promise<string | undefined> {
	const name = tagName?.trim().toLowerCase();
	if (!name) return undefined;
	try {
		const webhookId = /\/webhooks\/(\d+)\//.exec(url)?.[1];
		if (!webhookId) return undefined;
		const {getChannelRepository, getWebhookRepository} = await import('@app/api/middleware/ServiceSingletons');
		const {createWebhookID} = await import('@app/api/BrandedTypes');
		const webhook = await getWebhookRepository().findUnique(createWebhookID(BigInt(webhookId)));
		if (!webhook?.channelId) return undefined;
		const channels = getChannelRepository();
		const channel = await channels.channelData.findUnique(webhook.channelId);
		if (!channel?.guildId) return undefined;
		const config = await channels.threads.getParentConfig(channel.guildId, channel.id);
		const tag = config?.availableTags.find((candidate) => candidate.name.trim().toLowerCase() === name);
		if (!tag) return undefined;
		if (tag.moderated) {
			Logger.warn({tag: tagName}, '[ReviewWebhook] Forum tag is moderated, so the webhook cannot apply it');
			return undefined;
		}
		return tag.id.toString();
	} catch (error) {
		Logger.warn({error}, '[ReviewWebhook] Failed to look up the forum tag');
		return undefined;
	}
}

/**
 * Posts a review-queue notification to a channel webhook without ever blocking or failing the caller.
 * The webhook may belong to a forum channel, which needs a thread name and opens one post per event,
 * or to a plain text channel, which rejects a thread name with a 400. The post is therefore sent with a
 * thread name first and retried as a plain message when the webhook refuses it, and an embed link the server
 * rejects is dropped on a retry rather than losing the post. An optional forum tag id
 * is applied to the new post, which lets a forum that requires a tag accept these posts. The tag must be
 * one that members without the moderator permission can apply.
 */
export function notifyReviewWebhook(
	url: string | undefined,
	params: {
		threadName: string;
		content: string;
		label: string;
		embeds?: Array<Record<string, unknown>> | undefined;
		appliedTagId?: string | undefined;
		appliedTagName?: string | undefined;
	},
): void {
	if (!url) return;
	void (async () => {
		try {
			const tagId = params.appliedTagId?.trim() || (await resolveForumTagId(url, params.appliedTagName));
			const withLinks = params.embeds;
			const withoutLinks = params.embeds?.map(({url: _url, ...rest}) => rest);
			const thread = clampThreadName(params.threadName);
			const threadFields = {thread_name: thread, ...(tagId ? {applied_tags: [tagId]} : {})};
			// A forum webhook needs a thread name; a text channel webhook refuses one. An embed whose link the server
			// rejects (for example a self-hosted admin address without a public host name) is retried without the link,
			// so the notification is never lost to a bad link.
			const attempts: Array<Record<string, unknown>> = [
				{content: params.content, ...(withLinks ? {embeds: withLinks} : {}), ...threadFields},
				...(withoutLinks ? [{content: params.content, embeds: withoutLinks, ...threadFields}] : []),
				{content: params.content, ...(withLinks ? {embeds: withLinks} : {})},
				...(withoutLinks ? [{content: params.content, embeds: withoutLinks}] : []),
			];
			let response = await postJson(url, attempts[0] as Record<string, unknown>);
			for (const attempt of attempts.slice(1)) {
				if (response.status !== 400) break;
				response = await postJson(url, attempt);
			}
			if (!response.ok) {
				Logger.warn({status: response.status}, `[ReviewWebhook] ${params.label} webhook was refused`);
			}
		} catch (error) {
			Logger.warn({error}, `[ReviewWebhook] Failed to POST ${params.label} webhook`);
		}
	})();
}
