// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire fork test. Upstream #3035 made ALTCHA the only captcha; this fork keeps
// hCaptcha and Turnstile because the mobile clients already on the stores (1.7.32
// and earlier) implement those two only, and fall back to hCaptcha for any provider
// string they do not recognise. An ALTCHA-only server therefore locks every
// installed client out of registration and login. See docs/adr/0008.

import {Config} from '@app/api/Config';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {CaptchaMiddleware} from '@app/api/middleware/CaptchaMiddleware';
import {type CaptchaErrorBody, solveCaptchaChallenge} from '@app/api/test/CaptchaTestUtils';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {AppErrorHandler} from '@fluxer/errors/src/domains/core/ErrorHandlers';
import {type CaptchaConfig, DEFAULT_CAPTCHA_CONFIG} from '@fluxer/schema/src/domains/admin/CaptchaSchemas';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const TURNSTILE_CONFIG: CaptchaConfig = {
	...DEFAULT_CAPTCHA_CONFIG,
	provider: 'turnstile',
	cost: 1000,
	max_counter: 100,
};

function createHarness(captcha: CaptchaConfig): (headers: Record<string, string>) => Promise<Response> {
	const repository = {
		getCaptchaConfig: async () => captcha,
	} as unknown as InstanceConfigRepository;
	const app = new Hono<HonoEnv>();
	app.use(async (ctx, next) => {
		ctx.set('instanceConfigRepository', repository);
		await next();
	});
	app.use(CaptchaMiddleware);
	app.post('/auth/register', (ctx) => ctx.text('ok'));
	app.onError(AppErrorHandler);
	return async (headers) => app.request('http://localhost/auth/register', {method: 'POST', headers});
}

function stubSiteverify(success: boolean): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({success}), {headers: {'Content-Type': 'application/json'}})),
	);
}

describe('captcha provider dispatch', () => {
	let previousTestModeEnabled: boolean;
	let previousCaptcha: Pick<typeof Config.captcha, 'enabled' | 'provider' | 'turnstile'>;

	beforeEach(() => {
		previousTestModeEnabled = Config.dev.testModeEnabled;
		const {enabled, provider, turnstile} = Config.captcha;
		previousCaptcha = {enabled, provider, turnstile};
		Config.dev.testModeEnabled = false;
		Config.captcha.enabled = true;
		Config.captcha.provider = 'turnstile';
		Config.captcha.turnstile = {siteKey: 'turnstile-site-key', secretKey: 'turnstile-secret-key'};
	});

	afterEach(() => {
		Config.dev.testModeEnabled = previousTestModeEnabled;
		Config.captcha.enabled = previousCaptcha.enabled;
		Config.captcha.provider = previousCaptcha.provider;
		Config.captcha.turnstile = previousCaptcha.turnstile;
		vi.unstubAllGlobals();
	});

	// The guard that keeps every installed client able to log in. A client that
	// cannot solve ALTCHA has to be told a provider it implements. If this starts
	// answering "altcha", every mobile install at 1.7.32 or earlier falls back to
	// hCaptcha, which this instance does not serve, and login breaks for all of them.
	//
	// Mutation-checked: making challengeData always report altcha fails this test.
	it('names turnstile in the challenge so a shipped client can answer it', async () => {
		const response = await createHarness(TURNSTILE_CONFIG)({});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({code: 'CAPTCHA_REQUIRED', captcha_provider: 'turnstile'});
	});

	// The web app runs upstream's headless ALTCHA solver, so the same challenge has
	// to carry an ALTCHA challenge for it to solve.
	it('carries an ALTCHA challenge in the same response for clients that can solve one', async () => {
		const response = await createHarness(TURNSTILE_CONFIG)({});

		expect(await response.json()).toMatchObject({
			altcha_challenge: {parameters: {algorithm: 'PBKDF2/SHA-256', cost: 1000}},
		});
	});

	it('accepts a turnstile token that Cloudflare confirms', async () => {
		stubSiteverify(true);

		const response = await createHarness(TURNSTILE_CONFIG)({'x-captcha-token': 'turnstile-token'});

		expect(response.status).toBe(200);
	});

	it('rejects a turnstile token that Cloudflare refuses', async () => {
		stubSiteverify(false);

		const response = await createHarness(TURNSTILE_CONFIG)({'x-captcha-token': 'turnstile-token'});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({code: 'INVALID_CAPTCHA', captcha_provider: 'turnstile'});
	});

	it('verifies a solved ALTCHA token while turnstile is the offered provider', async () => {
		const request = createHarness(TURNSTILE_CONFIG);
		const challenge = await request({});
		const token = await solveCaptchaChallenge((await challenge.json()) as CaptchaErrorBody);

		const response = await request({'x-captcha-token': token, 'x-captcha-type': 'altcha'});

		expect(response.status).toBe(200);
	});

	it('refuses a turnstile token when the instance holds no secret key', async () => {
		Config.captcha.turnstile = undefined;

		const response = await createHarness(TURNSTILE_CONFIG)({'x-captcha-token': 'turnstile-token'});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({code: 'INVALID_CAPTCHA'});
	});

	it('leaves an instance that chose no provider on ALTCHA', async () => {
		const response = await createHarness({...DEFAULT_CAPTCHA_CONFIG, cost: 1000, max_counter: 100})({});

		expect(await response.json()).toMatchObject({captcha_provider: 'altcha'});
	});
});
