// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const CAPTCHA_CONFIG_KEY = 'captcha_config';

// Echowire: the guard that keeps every installed client able to log in. The mobile clients
// on the stores (1.7.32 and earlier) implement hCaptcha and Turnstile only. An instance that
// never chose a provider through the admin surface must keep serving the one
// FLUXER_CAPTCHA_PROVIDER names, not upstream's ALTCHA default. See docs/adr/0008.
describe('captcha provider resolution', () => {
	const repositories: Array<InstanceConfigRepository> = [];
	let previousCaptcha: Pick<typeof Config.captcha, 'enabled' | 'provider' | 'turnstile' | 'hcaptcha'>;

	beforeEach(() => {
		const {enabled, provider, turnstile, hcaptcha} = Config.captcha;
		previousCaptcha = {enabled, provider, turnstile, hcaptcha};
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	afterEach(() => {
		Config.captcha.enabled = previousCaptcha.enabled;
		Config.captcha.provider = previousCaptcha.provider;
		Config.captcha.turnstile = previousCaptcha.turnstile;
		Config.captcha.hcaptcha = previousCaptcha.hcaptcha;
		for (const repository of repositories) {
			repository.shutdown();
		}
		repositories.length = 0;
	});

	function createRepository(): InstanceConfigRepository {
		const repository = new InstanceConfigRepository(new MockKVProvider());
		repositories.push(repository);
		return repository;
	}

	function selectTurnstileInEnvironment(withKeys: boolean): void {
		Config.captcha.enabled = true;
		Config.captcha.provider = 'turnstile';
		Config.captcha.turnstile = withKeys
			? {siteKey: 'turnstile-site-key', secretKey: 'turnstile-secret-key'}
			: undefined;
	}

	it('serves turnstile when nothing is stored and the environment selects it', async () => {
		selectTurnstileInEnvironment(true);

		await expect(createRepository().getCaptchaConfig()).resolves.toMatchObject({provider: 'turnstile'});
	});

	it('serves altcha when nothing is stored and the environment selects nothing', async () => {
		Config.captcha.enabled = false;

		await expect(createRepository().getCaptchaConfig()).resolves.toMatchObject({
			provider: 'altcha',
			cost: 5000,
			max_counter: 1000,
		});
	});

	it('turns the captcha off when the selected provider has no keys', async () => {
		// Falling back to ALTCHA here would hand those clients a challenge they cannot
		// solve, so a misconfigured provider turns the check off instead.
		selectTurnstileInEnvironment(false);

		await expect(createRepository().getCaptchaConfig()).resolves.toMatchObject({provider: 'none'});
	});

	it('keeps a stored legacy enabled flag of true on the environment provider', async () => {
		selectTurnstileInEnvironment(true);
		const repository = createRepository();
		await repository.setConfig(CAPTCHA_CONFIG_KEY, JSON.stringify({enabled: true, cost: 2000, max_counter: 500}));

		await expect(repository.getCaptchaConfig()).resolves.toEqual({provider: 'turnstile', cost: 2000, max_counter: 500});
	});

	it('honours a stored legacy enabled flag of false even when the environment selects a provider', async () => {
		selectTurnstileInEnvironment(true);
		const repository = createRepository();
		await repository.setConfig(CAPTCHA_CONFIG_KEY, JSON.stringify({enabled: false}));

		await expect(repository.getCaptchaConfig()).resolves.toMatchObject({provider: 'none'});
	});

	it('lets an explicit stored provider win over the environment', async () => {
		selectTurnstileInEnvironment(true);
		const repository = createRepository();
		await repository.updateCaptchaConfig({provider: 'altcha'});

		await expect(repository.getCaptchaConfig()).resolves.toMatchObject({provider: 'altcha'});
	});
});
