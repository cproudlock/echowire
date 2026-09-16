// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the thread and forum post routes carry channel_id (or guild_id) only. A bucket that
// names a parameter the route does not have never resolves, so every caller would share one
// global bucket: before this was fixed, creating a post, editing tags, archiving, pinning and
// deleting all drew on a single 10/min allowance across every guild.

import {RateLimitMiddleware, type RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import type {
	BucketConfig,
	IRateLimitService,
	RateLimitConfig,
	RateLimitResult,
} from '@pkgs/rate_limit/src/IRateLimitService';
import {Hono} from 'hono';
import {describe, expect, test} from 'vitest';

const CLIENT_IP = '203.0.113.42';

function allowed(limit: number): RateLimitResult {
	return {allowed: true, limit, remaining: limit - 1, resetTime: new Date(Date.now() + 10000), resetAfterDecimal: 10};
}

class RecordingRateLimitService implements IRateLimitService {
	readonly buckets: Array<string> = [];

	async checkLimit(config: RateLimitConfig): Promise<RateLimitResult> {
		return allowed(config.maxAttempts);
	}

	async peekLimit(config: RateLimitConfig): Promise<RateLimitResult> {
		return allowed(config.maxAttempts);
	}

	async checkBucketLimit(bucket: string, config: BucketConfig): Promise<RateLimitResult> {
		this.buckets.push(bucket);
		return allowed(config.limit);
	}

	async checkGlobalLimit(_identifier: string, limit: number): Promise<RateLimitResult> {
		return allowed(limit);
	}

	async resetLimit(_identifier: string): Promise<void> {}

	async clearLimitsByIdentifierPrefix(_identifierPrefix: string): Promise<number> {
		return 0;
	}
}

// Every thread route, with the path pattern it is mounted on and the config it uses.
const CHANNEL_SCOPED_ROUTES: ReadonlyArray<{name: string; path: string; config: RouteRateLimitConfig}> = [
	{name: 'create thread', path: '/channels/:channel_id/threads', config: RateLimitConfigs.THREAD_CREATE},
	{name: 'list active threads', path: '/channels/:channel_id/threads', config: RateLimitConfigs.THREAD_LIST_ACTIVE},
	{name: 'update thread', path: '/channels/:channel_id/thread', config: RateLimitConfigs.THREAD_UPDATE},
	{name: 'delete thread', path: '/channels/:channel_id/thread', config: RateLimitConfigs.THREAD_DELETE},
	{
		name: 'list archived threads',
		path: '/channels/:channel_id/threads/archived',
		config: RateLimitConfigs.THREAD_LIST_ARCHIVED,
	},
	{
		name: 'join thread',
		path: '/channels/:channel_id/thread-members/@me',
		config: RateLimitConfigs.THREAD_MEMBER_JOIN,
	},
	{
		name: 'leave thread',
		path: '/channels/:channel_id/thread-members/@me',
		config: RateLimitConfigs.THREAD_MEMBER_LEAVE,
	},
	{
		name: 'list thread members',
		path: '/channels/:channel_id/thread-members',
		config: RateLimitConfigs.THREAD_MEMBER_LIST,
	},
];

function buildApp(
	path: string,
	config: RouteRateLimitConfig,
): {app: Hono<HonoEnv>; service: RecordingRateLimitService} {
	const service = new RecordingRateLimitService();
	const app = new Hono<HonoEnv>({strict: true});
	app.use('*', async (ctx, next) => {
		ctx.set('rateLimitService', service);
		await next();
	});
	app.get(path, RateLimitMiddleware(config), (ctx) => ctx.text('ok'));
	return {app, service};
}

async function call(app: Hono<HonoEnv>, url: string): Promise<Response> {
	return await app.request(`http://localhost${url}`, {
		headers: {'x-forwarded-for': CLIENT_IP, 'x-fluxer-test-enable-rate-limits': 'true'},
	});
}

describe('thread route rate limit buckets', () => {
	test('every channel-scoped thread route resolves its bucket to the channel id', async () => {
		for (const route of CHANNEL_SCOPED_ROUTES) {
			const {app, service} = buildApp(route.path, route.config);
			const response = await call(app, route.path.replace(':channel_id', '4071'));

			expect(response.status, route.name).toBe(200);
			expect(service.buckets, route.name).toHaveLength(1);
			expect(service.buckets[0], route.name).toContain('4071');
			expect(service.buckets[0], route.name).not.toContain(':channel_id');
			expect(service.buckets[0], route.name).not.toContain(':guild_id');
		}
	});

	test('two channels never share a thread bucket', async () => {
		for (const route of CHANNEL_SCOPED_ROUTES) {
			const {app, service} = buildApp(route.path, route.config);

			await call(app, route.path.replace(':channel_id', '111'));
			await call(app, route.path.replace(':channel_id', '222'));

			expect(service.buckets, route.name).toHaveLength(2);
			expect(service.buckets[0], route.name).not.toBe(service.buckets[1]);
		}
	});

	test('thread routes no longer share one bucket with each other', async () => {
		const buckets = new Set(CHANNEL_SCOPED_ROUTES.map((route) => route.config.bucket));

		expect(buckets.size).toBe(CHANNEL_SCOPED_ROUTES.length);
		for (const route of CHANNEL_SCOPED_ROUTES) {
			expect(route.config.bucket, route.name).not.toBe(RateLimitConfigs.GUILD_CHANNEL_CREATE.bucket);
		}
	});

	test('the guild-wide active thread list resolves its bucket to the guild id', async () => {
		const {app, service} = buildApp('/guilds/:guild_id/threads/active', RateLimitConfigs.GUILD_THREADS_ACTIVE_LIST);

		const response = await call(app, '/guilds/9090/threads/active');

		expect(response.status).toBe(200);
		expect(service.buckets).toEqual([`ip:${CLIENT_IP}:guild:threads:active:9090`]);
	});
});
