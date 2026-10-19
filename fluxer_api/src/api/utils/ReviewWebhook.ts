// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';

const REVIEW_WEBHOOK_TIMEOUT_MS = 5000;
const THREAD_NAME_MAX_LENGTH = 100;

function clampThreadName(name: string): string {
	const oneLine = name.replace(/\s+/g, ' ').trim();
	return oneLine.length <= THREAD_NAME_MAX_LENGTH ? oneLine : `${oneLine.slice(0, THREAD_NAME_MAX_LENGTH - 1)}…`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REVIEW_WEBHOOK_TIMEOUT_MS);
	try {
		return await fetch(url, {...init, signal: controller.signal});
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

export type ReviewItemKind = 'registration' | 'report' | 'discovery';
export type ReviewOutcome = 'approved' | 'denied' | 'resolved' | 'removed';

const CARD_TTL_SECONDS = 60 * 24 * 60 * 60;
const OUTCOME_COLOR: Record<ReviewOutcome, number> = {
	approved: 0x3ba55d,
	resolved: 0x3ba55d,
	denied: 0x8a8f98,
	removed: 0x8a8f98,
};
const OUTCOME_LABEL: Record<ReviewOutcome, string> = {
	approved: 'Approved',
	denied: 'Denied',
	resolved: 'Resolved',
	removed: 'Removed',
};

interface TrackedCard {
	url: string;
	messageId: string;
	threadId: string | null;
	embeds: Array<Record<string, unknown>>;
}

function cardKey(kind: ReviewItemKind, id: string): string {
	return `review_webhook_card:${kind}:${id}`;
}

function stripQuery(url: string): string {
	return url.split('?')[0] ?? url;
}

/**
 * Returns the posted embeds with the outcome applied: the colour changes, the card says how it ended, and the
 * card is stamped with who decided. The card's title link and fields are kept so it stays useful as a record.
 */
export function decidedEmbeds(
	embeds: ReadonlyArray<Record<string, unknown>>,
	outcome: ReviewOutcome,
	actor?: string,
): Array<Record<string, unknown>> {
	return embeds.map((embed, index) => {
		if (index > 0) return {...embed};
		const fields = Array.isArray(embed['fields']) ? (embed['fields'] as Array<Record<string, unknown>>) : [];
		const status = actor ? `${OUTCOME_LABEL[outcome]} by ${actor}` : OUTCOME_LABEL[outcome];
		return {
			...embed,
			color: OUTCOME_COLOR[outcome],
			description: status,
			fields: [{name: 'Status', value: status, inline: true}, ...fields.filter((field) => field['name'] !== 'Status')],
		};
	});
}

async function lookupActorName(userId: bigint | string | undefined): Promise<string | undefined> {
	if (userId === undefined) return undefined;
	try {
		const {getUserRepository} = await import('@app/api/middleware/ServiceSingletons');
		const {createUserID} = await import('@app/api/BrandedTypes');
		const user = await getUserRepository().findUnique(createUserID(BigInt(userId)));
		return user?.username || undefined;
	} catch {
		return undefined;
	}
}

async function rememberCard(kind: ReviewItemKind, id: string, card: TrackedCard): Promise<void> {
	const {getKVClient} = await import('@app/api/middleware/ServiceRegistry');
	await getKVClient().setex(cardKey(kind, id), CARD_TTL_SECONDS, JSON.stringify(card));
}

/**
 * Updates the card posted for a review item once an admin has decided it: the embed is edited to show the
 * outcome and a short reply is posted in the same forum post. Never throws and does nothing when no card
 * was recorded (no webhook set, the post failed, or the record expired).
 */
export async function updateReviewCard(
	kind: ReviewItemKind,
	id: string,
	outcome: ReviewOutcome,
	options: {actorUserId?: bigint | string | undefined; note?: string | undefined} = {},
): Promise<void> {
	try {
		const {getKVClient} = await import('@app/api/middleware/ServiceRegistry');
		const kv = getKVClient();
		const raw = await kv.get(cardKey(kind, id));
		if (!raw) return;
		const actor = await lookupActorName(options.actorUserId);
		const card = JSON.parse(raw) as TrackedCard;
		const threadQuery = card.threadId ? `?thread_id=${encodeURIComponent(card.threadId)}` : '';
		const edit = await fetchWithTimeout(`${card.url}/messages/${card.messageId}${threadQuery}`, {
			method: 'PATCH',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({embeds: decidedEmbeds(card.embeds, outcome, actor)}),
		});
		if (!edit.ok) {
			Logger.warn({status: edit.status, kind}, '[ReviewWebhook] Editing the review card was refused');
		}
		const who = actor ? ` by ${actor}` : '';
		const note = options.note ? `: ${options.note}` : '';
		const reply = await fetchWithTimeout(`${card.url}${threadQuery}`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({content: `${OUTCOME_LABEL[outcome]}${who}${note}`.slice(0, 1900)}),
		});
		if (!reply.ok) {
			Logger.warn({status: reply.status, kind}, '[ReviewWebhook] Posting the review outcome was refused');
		}
		await kv.del(cardKey(kind, id));
	} catch (error) {
		Logger.warn({error, kind}, '[ReviewWebhook] Failed to update the review card');
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
		track?: {kind: ReviewItemKind; id: string} | undefined;
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
			const base = stripQuery(url);
			const postUrl = params.track ? `${base}?wait=true` : url;
			const send = (body: Record<string, unknown>) =>
				fetchWithTimeout(postUrl, {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify(body),
				});
			let sent = attempts[0] as Record<string, unknown>;
			let response = await send(sent);
			for (const attempt of attempts.slice(1)) {
				if (response.status !== 400) break;
				sent = attempt;
				response = await send(attempt);
			}
			if (response.ok && params.track && params.embeds) {
				const message = (await response.json().catch(() => null)) as {id?: string; channel_id?: string} | null;
				if (message?.id) {
					await rememberCard(params.track.kind, params.track.id, {
						url: base,
						messageId: message.id,
						threadId: 'thread_name' in sent ? (message.channel_id ?? null) : null,
						embeds: (sent['embeds'] as Array<Record<string, unknown>> | undefined) ?? params.embeds,
					});
				}
			}
			if (!response.ok) {
				Logger.warn({status: response.status}, `[ReviewWebhook] ${params.label} webhook was refused`);
			}
		} catch (error) {
			Logger.warn({error}, `[ReviewWebhook] Failed to POST ${params.label} webhook`);
		}
	})();
}
