// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SsoService} from '@app/api/auth/services/SsoService';
import {Config} from '@app/api/Config';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InstanceController} from '@app/api/instance/InstanceController';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {DEFAULT_DOMAIN_MIGRATION_CONFIG} from '@fluxer/schema/src/domains/admin/DomainMigrationSchemas';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

interface DiscoveryCaptcha {
	provider: string;
	hcaptcha_site_key: string | null;
	turnstile_site_key: string | null;
}

describe('InstanceController discovery captcha', () => {
	const repositories: Array<InstanceConfigRepository> = [];
	let previousCaptcha: Pick<typeof Config.captcha, 'enabled' | 'provider' | 'turnstile' | 'hcaptcha'>;

	beforeEach(() => {
		const {enabled, provider, turnstile, hcaptcha} = Config.captcha;
		previousCaptcha = {enabled, provider, turnstile, hcaptcha};
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
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		const repository = new InstanceConfigRepository(new MockKVProvider());
		repositories.push(repository);
		return repository;
	}

	function createApp(repository: InstanceConfigRepository): Hono<HonoEnv> {
		const app = new Hono<HonoEnv>({strict: true});
		app.use('*', async (ctx, next) => {
			ctx.set('instanceConfigRepository', repository);
			ctx.set('limitConfigService', {
				getConfigWireFormat: () => ({version: 2, traitDefinitions: [], rules: [], defaultsHash: 'test'}),
			} as unknown as LimitConfigService);
			ctx.set('ssoService', {
				getPublicStatus: async () => ({
					enabled: false,
					enforced: false,
					display_name: null,
					redirect_uri: '',
				}),
			} as unknown as SsoService);
			await next();
		});
		InstanceController(app);
		return app;
	}

	async function readCaptcha(repository: InstanceConfigRepository): Promise<DiscoveryCaptcha> {
		const response = await createApp(repository).request('http://localhost/.well-known/fluxer');
		expect(response.status).toBe(200);
		return ((await response.json()) as {captcha: DiscoveryCaptcha}).captcha;
	}

	it('advertises altcha by default', async () => {
		await expect(readCaptcha(createRepository())).resolves.toEqual({
			provider: 'altcha',
			hcaptcha_site_key: null,
			turnstile_site_key: null,
		});
	});

	it('advertises no provider once an admin turns the captcha off', async () => {
		const repository = createRepository();
		await repository.updateCaptchaConfig({enabled: false});

		await expect(readCaptcha(repository)).resolves.toEqual({
			provider: 'none',
			hcaptcha_site_key: null,
			turnstile_site_key: null,
		});
	});

	// Echowire: the other half of the guard in CaptchaProviderDispatch.test.ts. A
	// mobile client already on the stores renders its widget from the provider and
	// site key advertised here, so dropping either one breaks login for every
	// install at 1.7.32 or earlier. See docs/adr/0008.
	it('advertises turnstile and its site key when the environment selects turnstile', async () => {
		Config.captcha.enabled = true;
		Config.captcha.provider = 'turnstile';
		Config.captcha.turnstile = {siteKey: 'turnstile-site-key', secretKey: 'turnstile-secret-key'};

		await expect(readCaptcha(createRepository())).resolves.toEqual({
			provider: 'turnstile',
			hcaptcha_site_key: null,
			turnstile_site_key: 'turnstile-site-key',
		});
	});

	it('advertises no provider when turnstile is selected but its keys are missing', async () => {
		// Falling back to ALTCHA here would hand those clients a challenge they cannot
		// solve, so a misconfigured provider turns the check off instead.
		Config.captcha.enabled = true;
		Config.captcha.provider = 'turnstile';

		await expect(readCaptcha(createRepository())).resolves.toEqual({
			provider: 'none',
			hcaptcha_site_key: null,
			turnstile_site_key: null,
		});
	});

	it('publishes the domain migration kill switch and anonymous rollout without the targeting lists', async () => {
		const repository = createRepository();
		const app = createApp(repository);

		const initial = await app.request('http://localhost/.well-known/fluxer');
		expect(((await initial.json()) as {domain_migration: unknown}).domain_migration).toEqual({
			enabled: false,
			anonymous_rollout_basis_points: 0,
			rollout_salt: 'domain-migration-v1',
			standalone_forwarding: false,
		});

		await repository.setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 2,
			rollout_basis_points: 100,
			anonymous_rollout_basis_points: 1500,
			included_user_ids: ['1400000000000000001'],
			standalone_forwarding: true,
		});

		const updated = await app.request('http://localhost/.well-known/fluxer');
		expect(updated.headers.get('etag')).not.toBe(initial.headers.get('etag'));
		expect(((await updated.json()) as {domain_migration: unknown}).domain_migration).toEqual({
			enabled: true,
			anonymous_rollout_basis_points: 1500,
			rollout_salt: 'domain-migration-v1',
			standalone_forwarding: true,
		});
	});
});
