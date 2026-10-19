// SPDX-License-Identifier: AGPL-3.0-or-later

import {decidedEmbeds, notifyReviewWebhook, resolveForumTagId, updateReviewCard} from '@app/api/utils/ReviewWebhook';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const kvStore = new Map<string, string>();
vi.mock('@app/api/middleware/ServiceRegistry', () => ({
	getKVClient: () => ({
		setex: async (key: string, _ttl: number, value: string) => void kvStore.set(key, value),
		get: async (key: string) => kvStore.get(key) ?? null,
		del: async (key: string) => void kvStore.delete(key),
	}),
}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getUserRepository: () => ({findUnique: async () => ({username: 'ada'})}),
}));

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

describe('review card updates', () => {
	const fetchMock = vi.fn();
	const embeds = [{title: 'New registration: bob', color: 0xf5a524, fields: [{name: 'Username', value: 'bob'}]}];

	beforeEach(() => {
		kvStore.clear();
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('colours the card, states the outcome and keeps the fields', () => {
		const [card] = decidedEmbeds(embeds, 'approved', 'ada');
		expect(card?.['color']).toBe(0x3ba55d);
		expect(card?.['description']).toBe('Approved by ada');
		expect(card?.['fields']).toEqual([
			{name: 'Status', value: 'Approved by ada', inline: true},
			{name: 'Username', value: 'bob'},
		]);
		expect(decidedEmbeds(embeds, 'denied')[0]?.['color']).toBe(0x8a8f98);
	});

	it('asks for the created message and remembers the forum post', async () => {
		fetchMock.mockResolvedValue(Response.json({id: '77', channel_id: '88'}));
		notifyReviewWebhook(URL_FORUM, {
			threadName: 't',
			content: 'c',
			label: 'test',
			embeds,
			track: {kind: 'registration', id: '5'},
		});
		await settle();
		await settle();
		expect(fetchMock.mock.calls[0][0]).toBe(`${URL_FORUM}?wait=true`);
		expect(JSON.parse(kvStore.get('review_webhook_card:registration:5') as string)).toMatchObject({
			url: URL_FORUM,
			messageId: '77',
			threadId: '88',
		});
	});

	it('does not track or ask for the message without a track key', async () => {
		fetchMock.mockResolvedValue(Response.json({id: '77', channel_id: '88'}));
		notifyReviewWebhook(URL_FORUM, {threadName: 't', content: 'c', label: 'test', embeds});
		await settle();
		expect(fetchMock.mock.calls[0][0]).toBe(URL_FORUM);
		expect(kvStore.size).toBe(0);
	});

	it('does not remember a plain text channel post as a thread', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, {status: 400}))
			.mockResolvedValueOnce(new Response(null, {status: 400}))
			.mockResolvedValueOnce(Response.json({id: '90', channel_id: '91'}));
		notifyReviewWebhook(URL_FORUM, {
			threadName: 't',
			content: 'c',
			label: 'test',
			embeds,
			track: {kind: 'report', id: '9'},
		});
		await settle();
		await settle();
		expect(JSON.parse(kvStore.get('review_webhook_card:report:9') as string).threadId).toBeNull();
	});

	it('edits the card, replies in the post and forgets the record', async () => {
		kvStore.set(
			'review_webhook_card:registration:5',
			JSON.stringify({url: URL_FORUM, messageId: '77', threadId: '88', embeds}),
		);
		fetchMock.mockResolvedValue(new Response(null, {status: 200}));
		await updateReviewCard('registration', '5', 'approved', {actorUserId: 1n, note: 'welcome'});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [editUrl, editInit] = fetchMock.mock.calls[0];
		expect(editUrl).toBe(`${URL_FORUM}/messages/77?thread_id=88`);
		expect(editInit.method).toBe('PATCH');
		expect(JSON.parse(editInit.body).embeds[0].color).toBe(0x3ba55d);
		const [replyUrl, replyInit] = fetchMock.mock.calls[1];
		expect(replyUrl).toBe(`${URL_FORUM}?thread_id=88`);
		expect(JSON.parse(replyInit.body).content).toBe('Approved by ada: welcome');
		expect(kvStore.size).toBe(0);
	});

	it('does nothing when no card was recorded and never throws', async () => {
		await updateReviewCard('report', '404', 'resolved');
		expect(fetchMock).not.toHaveBeenCalled();
		kvStore.set(
			'review_webhook_card:report:1',
			JSON.stringify({url: URL_FORUM, messageId: '1', threadId: null, embeds}),
		);
		fetchMock.mockRejectedValue(new Error('network down'));
		await expect(updateReviewCard('report', '1', 'resolved')).resolves.toBeUndefined();
	});
});
