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
 * Posts a review-queue notification to a channel webhook without ever blocking or failing the caller.
 * The webhook may belong to a forum channel, which needs a thread name and opens one post per event,
 * or to a plain text channel, which rejects a thread name with a 400. The post is therefore sent with a
 * thread name first and retried as a plain message when the webhook refuses it. An optional forum tag id
 * is applied to the new post, which lets a forum that requires a tag accept these posts. The tag must be
 * one that members without the moderator permission can apply.
 */
export function notifyReviewWebhook(
	url: string | undefined,
	params: {threadName: string; content: string; label: string; appliedTagId?: string | undefined},
): void {
	if (!url) return;
	void (async () => {
		try {
			const tagId = params.appliedTagId?.trim();
			let response = await postJson(url, {
				content: params.content,
				thread_name: clampThreadName(params.threadName),
				...(tagId ? {applied_tags: [tagId]} : {}),
			});
			if (response.status === 400) {
				response = await postJson(url, {content: params.content});
			}
			if (!response.ok) {
				Logger.warn({status: response.status}, `[ReviewWebhook] ${params.label} webhook was refused`);
			}
		} catch (error) {
			Logger.warn({error}, `[ReviewWebhook] Failed to POST ${params.label} webhook`);
		}
	})();
}
