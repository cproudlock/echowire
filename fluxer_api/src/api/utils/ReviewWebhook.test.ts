// SPDX-License-Identifier: AGPL-3.0-or-later

import {notifyReviewWebhook, resolveForumTagId} from '@app/api/utils/ReviewWebhook';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const URL_FORUM = 'https://example.test/api/webhooks/1/token';

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('notifyReviewWebhook', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('does nothing without a url', async () => {
		notifyReviewWebhook(undefined, {threadName: 't', content: 'c', label: 'test'});
		await settle();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('posts a thread name and content for a forum webhook', async () => {
		fetchMock.mockResolvedValue(new Response(null, {status: 200}));
		notifyReviewWebhook(URL_FORUM, {threadName: 'Registration: ada', content: 'hello', label: 'test'});
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
			content: 'hello',
			thread_name: 'Registration: ada',
		});
	});

	it('applies the configured forum tag to the new post', async () => {
		fetchMock.mockResolvedValue(new Response(null, {status: 200}));
		notifyReviewWebhook(URL_FORUM, {threadName: 't', content: 'c', label: 'test', appliedTagId: ' 123 '});
		await settle();
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({applied_tags: ['123']});
	});

	it('retries as a plain message when a text channel webhook refuses the thread name', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, {status: 400}))
			.mockResolvedValueOnce(new Response(null, {status: 200}));
		notifyReviewWebhook(URL_FORUM, {threadName: 'Report 1', content: 'hello', label: 'test'});
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({content: 'hello'});
	});

	it('keeps the thread name within 100 characters on one line', async () => {
		fetchMock.mockResolvedValue(new Response(null, {status: 200}));
		notifyReviewWebhook(URL_FORUM, {threadName: `a\nb ${'x'.repeat(200)}`, content: 'c', label: 'test'});
		await settle();
		const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {thread_name: string};
		expect(sent.thread_name.length).toBeLessThanOrEqual(100);
		expect(sent.thread_name).not.toContain('\n');
	});

	it('never throws when the request fails', async () => {
		fetchMock.mockRejectedValue(new Error('network'));
		expect(() => notifyReviewWebhook(URL_FORUM, {threadName: 't', content: 'c', label: 'test'})).not.toThrow();
		await settle();
	});

	it('retries without the embed link when the server rejects it, keeping the thread post', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, {status: 400}))
			.mockResolvedValueOnce(new Response(null, {status: 200}));
		const embeds = [{title: 'New report', url: 'http://localhost/admin', description: 'd'}];
		notifyReviewWebhook(URL_FORUM, {threadName: 't', content: 'c', label: 'test', embeds});
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as Record<string, unknown>;
		expect(second.thread_name).toBe('t');
		expect(second.embeds).toEqual([{title: 'New report', description: 'd'}]);
	});

	it('sends embeds with the thread post and again on the plain retry', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, {status: 400}))
			.mockResolvedValueOnce(new Response(null, {status: 400}))
			.mockResolvedValueOnce(new Response(null, {status: 200}));
		const embeds = [{title: 'New registration: ada', url: 'https://example.test/admin/pending-registrations'}];
		notifyReviewWebhook(URL_FORUM, {threadName: 't', content: 'c', label: 'test', embeds});
		await settle();
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({thread_name: 't', embeds});
		const retry = JSON.parse(fetchMock.mock.calls[2][1].body as string) as Record<string, unknown>;
		expect(retry.embeds).toEqual(embeds);
		expect(retry.thread_name).toBeUndefined();
	});
});

describe('resolveForumTagId', () => {
	it('returns undefined without a tag name or a webhook id in the url', async () => {
		expect(await resolveForumTagId(URL_FORUM, undefined)).toBeUndefined();
		expect(await resolveForumTagId(URL_FORUM, '  ')).toBeUndefined();
		expect(await resolveForumTagId('https://example.test/not-a-webhook', 'new')).toBeUndefined();
	});
});
