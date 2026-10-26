// SPDX-License-Identifier: AGPL-3.0-or-later

import {generateKeyPairSync} from 'node:crypto';
import {loadConfig, resetConfig} from '@fluxer/config/src/ConfigLoader';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const MINIMAL_ENV: Record<string, string> = {
	FLUXER_ENV: 'test',
	FLUXER_BASE_DOMAIN: 'localhost',
	FLUXER_PUBLIC_SCHEME: 'http',
	FLUXER_PUBLIC_PORT: '8088',
	FLUXER_CASSANDRA_HOSTS: '127.0.0.1',
	FLUXER_CASSANDRA_PORT: '9042',
	FLUXER_CASSANDRA_KEYSPACE: 'fluxer_test',
	FLUXER_CASSANDRA_LOCAL_DC: 'datacenter1',
	FLUXER_CASSANDRA_USERNAME: 'test-user',
	FLUXER_CASSANDRA_PASSWORD: 'test-password',
	FLUXER_S3_ENDPOINT: 'http://127.0.0.1:3900',
	FLUXER_S3_ACCESS_KEY_ID: 'test-key',
	FLUXER_S3_SECRET_ACCESS_KEY: 'test-secret',
	FLUXER_MEDIA_PROXY_SECRET_KEY: 'test-media-secret',
	FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	FLUXER_ADMIN_SECRET_KEY_BASE: 'test-admin-secret',
	FLUXER_ADMIN_OAUTH_CLIENT_SECRET: 'test-admin-oauth-secret',
	FLUXER_GATEWAY_RPC_AUTH_TOKEN: 'test-gateway-token',
	FLUXER_SUDO_MODE_SECRET: 'test-sudo-secret',
	FLUXER_CONNECTION_INITIATION_SECRET: 'test-connection-secret',
	FLUXER_PROFILE_PSEUDONYM_SECRET: 'test-profile-pseudonym-secret',
	FLUXER_VAPID_PUBLIC_KEY: 'BB76bTFIuoqmxJtTfZX0yGTn1f_qu9H03B_nkj8OyExJFkN7Y-HBZZzShnHZoEhXKc5ZRy3jFu7OkBbnaQG-4aw',
	FLUXER_VAPID_PRIVATE_KEY: 'Xgi-3P8J-I3Q6U1HlCcXMuc_tKLGAM9nIfznX3Hz68o',
};

function generateVapidPair(): {publicKey: string; privateKey: string} {
	const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
	const jwk = privateKey.export({format: 'jwk'});
	const x = Buffer.from(jwk.x ?? '', 'base64url');
	const y = Buffer.from(jwk.y ?? '', 'base64url');
	const d = Buffer.from(jwk.d ?? '', 'base64url');
	return {
		publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
		privateKey: d.toString('base64url'),
	};
}

function stubMinimalEnv(overrides: Record<string, string> = {}): void {
	for (const [key, value] of Object.entries({...MINIMAL_ENV, ...overrides})) {
		vi.stubEnv(key, value);
	}
}

function clearFluxerEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('FLUXER_')) {
			vi.stubEnv(key, undefined);
		}
	}
}

describe('ConfigLoader', () => {
	beforeEach(() => {
		resetConfig();
		clearFluxerEnv();
	});

	afterEach(() => {
		resetConfig();
		vi.unstubAllEnvs();
	});

	test('a self-hosted instance without FLUXER_ENV runs in production', async () => {
		stubMinimalEnv({
			FLUXER_SELF_HOSTED: 'true',
			FLUXER_PROFILE_PSEUDONYM_SECRET: 'self-hosted-secret',
			FLUXER_POSTGRES_HOST: 'postgres',
			FLUXER_POSTGRES_DATABASE: 'fluxer',
			FLUXER_POSTGRES_PASSWORD: 'self-hosted-password',
		});
		vi.stubEnv('FLUXER_ENV', undefined);
		expect((await loadConfig()).env).toBe('production');
	});

	test('reads the profile pseudonym secret and requires it in production', async () => {
		stubMinimalEnv();
		expect((await loadConfig()).auth.profile_pseudonym_secret).toBe('test-profile-pseudonym-secret');
		resetConfig();
		stubMinimalEnv({FLUXER_PROFILE_PSEUDONYM_SECRET: ''});
		expect((await loadConfig()).auth.profile_pseudonym_secret).toBe('fluxer-dev-profile-pseudonym-secret');
		resetConfig();
		stubMinimalEnv({
			FLUXER_ENV: 'production',
			FLUXER_POSTGRES_HOST: 'postgres.internal',
			FLUXER_POSTGRES_DATABASE: 'fluxer_prod',
			FLUXER_POSTGRES_USERNAME: 'fluxer_app',
			FLUXER_POSTGRES_PASSWORD: 'prod-postgres-secret',
			FLUXER_POSTGRES_SSL: 'true',
			FLUXER_PROFILE_PSEUDONYM_SECRET: '',
		});
		await expect(loadConfig()).rejects.toThrow('FLUXER_PROFILE_PSEUDONYM_SECRET is required');
	});

	test('rejects unsafe production Postgres defaults', async () => {
		stubMinimalEnv({FLUXER_ENV: 'production'});
		await expect(loadConfig()).rejects.toThrow('FLUXER_POSTGRES_HOST');
	});

	test('allows self-hosted production Postgres without TLS', async () => {
		stubMinimalEnv({
			FLUXER_ENV: 'production',
			FLUXER_SELF_HOSTED: 'true',
			FLUXER_POSTGRES_HOST: 'postgres',
			FLUXER_POSTGRES_DATABASE: 'fluxer',
			FLUXER_POSTGRES_USERNAME: 'fluxer',
			FLUXER_POSTGRES_PASSWORD: 'self-hosted-postgres-secret',
			FLUXER_POSTGRES_SSL: 'false',
		});

		const config = await loadConfig();

		expect(config.instance.self_hosted).toBe(true);
		expect(config.database.postgres.ssl).toBe(false);
	});

	test('still requires TLS for non-self-hosted production Postgres', async () => {
		stubMinimalEnv({
			FLUXER_ENV: 'production',
			FLUXER_POSTGRES_HOST: 'postgres.internal',
			FLUXER_POSTGRES_DATABASE: 'fluxer_prod',
			FLUXER_POSTGRES_USERNAME: 'fluxer_app',
			FLUXER_POSTGRES_PASSWORD: 'prod-postgres-secret',
			FLUXER_POSTGRES_SSL: 'false',
		});

		await expect(loadConfig()).rejects.toThrow('FLUXER_POSTGRES_SSL must be true');
	});

	test('parses self-host branding, setup, and search engine environment variables', async () => {
		stubMinimalEnv({
			FLUXER_SEARCH_ENGINE: 'meilisearch',
			FLUXER_SEARCH_URL: 'http://meilisearch:7700',
			FLUXER_SEARCH_API_KEY: 'meili-key',
			FLUXER_SELF_HOSTED: 'true',
			FLUXER_APP_PRODUCT_NAME: 'Example Chat',
			FLUXER_APP_ICON_URL: 'https://assets.example/icon.png',
			FLUXER_APP_SYMBOL_URL: 'https://assets.example/symbol.png',
			FLUXER_APP_LOGO_URL: 'https://assets.example/logo.png',
			FLUXER_APP_WORDMARK_URL: 'https://assets.example/wordmark.png',
			FLUXER_APP_FAVICON_URL: 'https://assets.example/favicon.png',
			FLUXER_APP_THEME_COLOR: '#123456',
			FLUXER_APP_STATUS_PAGE_URL: 'https://status.example',
			FLUXER_APP_STATUS_PAGE_INCIDENT_HISTORY_URL: 'https://status.example/history',
			FLUXER_INSTANCE_SETUP_CONFIGURED: 'true',
		});

		const config = await loadConfig();

		expect(config.integrations.search.engine).toBe('meilisearch');
		expect(config.integrations.search.url).toBe('http://meilisearch:7700');
		expect(config.integrations.search.api_key).toBe('meili-key');
		expect(config.instance.self_hosted).toBe(true);
		expect(config.instance.branding).toEqual({
			product_name: 'Example Chat',
			icon_url: 'https://assets.example/icon.png',
			symbol_url: 'https://assets.example/symbol.png',
			logo_url: 'https://assets.example/logo.png',
			wordmark_url: 'https://assets.example/wordmark.png',
			favicon_url: 'https://assets.example/favicon.png',
			theme_color: '#123456',
			status_page_url: 'https://status.example',
			status_page_incident_history_url: 'https://status.example/history',
		});
		expect(config.instance.setup.configured).toBe(true);
	});

	test('rejects an enabled captcha with no keys for the selected provider', async () => {
		stubMinimalEnv({FLUXER_CAPTCHA_ENABLED: 'true', FLUXER_CAPTCHA_PROVIDER: 'hcaptcha'});
		await expect(loadConfig()).rejects.toThrow('FLUXER_CAPTCHA_HCAPTCHA_SITE_KEY is required');
	});

	test('rejects an enabled captcha with a site key but no secret key', async () => {
		stubMinimalEnv({
			FLUXER_CAPTCHA_ENABLED: 'true',
			FLUXER_CAPTCHA_PROVIDER: 'turnstile',
			FLUXER_CAPTCHA_TURNSTILE_SITE_KEY: 'turnstile-site-key',
		});
		await expect(loadConfig()).rejects.toThrow('FLUXER_CAPTCHA_TURNSTILE_SECRET_KEY is required');
	});

	test('rejects an enabled captcha with no provider', async () => {
		stubMinimalEnv({FLUXER_CAPTCHA_ENABLED: 'true'});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_CAPTCHA_PROVIDER must be altcha, hcaptcha or turnstile when FLUXER_CAPTCHA_ENABLED is true',
		);
	});

	test('accepts an enabled captcha with both keys for the selected provider', async () => {
		stubMinimalEnv({
			FLUXER_CAPTCHA_ENABLED: 'true',
			FLUXER_CAPTCHA_PROVIDER: 'hcaptcha',
			FLUXER_CAPTCHA_HCAPTCHA_SITE_KEY: 'hcaptcha-site-key',
			FLUXER_CAPTCHA_HCAPTCHA_SECRET_KEY: 'hcaptcha-secret-key',
		});

		const config = await loadConfig();

		expect(config.integrations.captcha.enabled).toBe(true);
		expect(config.integrations.captcha.hcaptcha?.secret_key).toBe('hcaptcha-secret-key');
	});

	test('accepts an enabled altcha captcha with no keys at all', async () => {
		// Echowire: ALTCHA is keyless proof of work, so the key requirement that applies
		// to hCaptcha and Turnstile must not apply to it.
		stubMinimalEnv({FLUXER_CAPTCHA_ENABLED: 'true', FLUXER_CAPTCHA_PROVIDER: 'altcha'});

		const config = await loadConfig();

		expect(config.integrations.captcha.provider).toBe('altcha');
		expect(config.integrations.captcha.enabled).toBe(true);
	});

	test('reads the production turnstile captcha out of the environment', async () => {
		// Echowire: this is the configuration the deployed instance actually runs. If it
		// ever stops loading, every shipped mobile client loses login. See docs/adr/0008.
		stubMinimalEnv({
			FLUXER_CAPTCHA_ENABLED: 'true',
			FLUXER_CAPTCHA_PROVIDER: 'turnstile',
			FLUXER_CAPTCHA_TURNSTILE_SITE_KEY: 'turnstile-site-key',
			FLUXER_CAPTCHA_TURNSTILE_SECRET_KEY: 'turnstile-secret-key',
		});

		const config = await loadConfig();

		expect(config.integrations.captcha.provider).toBe('turnstile');
		expect(config.integrations.captcha.turnstile?.site_key).toBe('turnstile-site-key');
		expect(config.integrations.captcha.turnstile?.secret_key).toBe('turnstile-secret-key');
	});

	test('leaves a disabled captcha unvalidated', async () => {
		stubMinimalEnv({FLUXER_CAPTCHA_PROVIDER: 'hcaptcha'});
		expect((await loadConfig()).integrations.captcha.enabled).toBe(false);
	});

	test('leaves the account identity unset by default', async () => {
		stubMinimalEnv();
		const config = await loadConfig();
		expect(config.instance.account_identity).toBeNull();
	});

	test('treats an empty account identity as unset', async () => {
		stubMinimalEnv({FLUXER_ACCOUNT_IDENTITY: ' '});
		const config = await loadConfig();
		expect(config.instance.account_identity).toBeNull();
	});

	test.each([
		['email', 'email'],
		['username', 'username'],
		[' Username ', 'username'],
	])('parses FLUXER_ACCOUNT_IDENTITY=%j', async (raw, expected) => {
		stubMinimalEnv({FLUXER_ACCOUNT_IDENTITY: raw});
		const config = await loadConfig();
		expect(config.instance.account_identity).toBe(expected);
	});

	test.each([
		['none', 'none'],
		[' Random ', 'random'],
		['', null],
	])('parses FLUXER_TAG_STYLE=%j', async (raw, expected) => {
		stubMinimalEnv({FLUXER_TAG_STYLE: raw});
		const config = await loadConfig();
		expect(config.instance.tag_style).toBe(expected);
	});

	test.each([
		['implicit', 'implicit'],
		[' StartTLS ', 'starttls'],
		['opportunistic', 'opportunistic'],
		['none', 'none'],
		['', undefined],
	])('parses FLUXER_EMAIL_SMTP_TLS_MODE=%j', async (raw, expected) => {
		stubMinimalEnv({FLUXER_EMAIL_SMTP_HOST: 'smtp.example.com', FLUXER_EMAIL_SMTP_TLS_MODE: raw});
		const config = await loadConfig();
		expect(config.integrations.email.smtp?.tls_mode).toBe(expected);
	});

	test.each(['tls', 'true'])('rejects the SMTP TLS mode %j', async (raw) => {
		stubMinimalEnv({FLUXER_EMAIL_SMTP_TLS_MODE: raw});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_EMAIL_SMTP_TLS_MODE must be implicit, starttls, opportunistic or none',
		);
	});

	test('rejects an App Store product mapped to an unknown slot', async () => {
		stubMinimalEnv({FLUXER_APP_STORE_PRODUCTS: '{"com.fluxer.visionary":"visionary"}'});
		await expect(loadConfig()).rejects.toThrow(
			'Invalid FLUXER_APP_STORE_PRODUCTS slot for com.fluxer.visionary: visionary',
		);
	});

	test('rejects a Google Play product mapped to an unknown slot', async () => {
		stubMinimalEnv({FLUXER_GOOGLE_PLAY_PRODUCTS: '{"plutonium:weekly":"weekly"}'});
		await expect(loadConfig()).rejects.toThrow('Invalid FLUXER_GOOGLE_PLAY_PRODUCTS slot for plutonium:weekly: weekly');
	});

	test('rejects a Google Play product key that does not fit its slot kind', async () => {
		stubMinimalEnv({FLUXER_GOOGLE_PLAY_PRODUCTS: '{"plutonium":"monthly"}'});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_GOOGLE_PLAY_PRODUCTS key plutonium does not match its monthly slot',
		);
		resetConfig();
		stubMinimalEnv({FLUXER_GOOGLE_PLAY_PRODUCTS: '{"gift:one":"gift_1_month"}'});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_GOOGLE_PLAY_PRODUCTS key gift:one does not match its gift_1_month slot',
		);
	});

	test('rejects a cache purge endpoint that contains credentials', async () => {
		stubMinimalEnv({
			FLUXER_CACHE_PURGE_ADAPTER: 'http',
			FLUXER_CACHE_PURGE_HTTP_ENDPOINT: 'https://purger:secret@purge.internal/purge',
		});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_CACHE_PURGE_HTTP_ENDPOINT must be an absolute http or https URL without credentials',
		);
	});

	test('rejects a cache purge token with spaces or control characters without echoing it', async () => {
		for (const token of ['secret\nvalue', 'secret\rvalue', 'secret value', 'secret-value\n']) {
			stubMinimalEnv({
				FLUXER_CACHE_PURGE_ADAPTER: 'http',
				FLUXER_CACHE_PURGE_HTTP_ENDPOINT: 'https://purge.internal/purge',
				FLUXER_CACHE_PURGE_HTTP_TOKEN: token,
			});
			await expect(loadConfig()).rejects.toThrow(
				/^FLUXER_CACHE_PURGE_HTTP_TOKEN must contain only visible ASCII characters$/,
			);
		}
	});

	test('rejects a controller cache purge endpoint that is not https', async () => {
		stubMinimalEnv({
			FLUXER_CACHE_PURGE_ADAPTER: 'controller',
			FLUXER_CACHE_PURGE_CONTROLLER_ENDPOINT: 'http://controller.test/v1/orgs/a/sites/b/purge',
			FLUXER_CACHE_PURGE_CONTROLLER_TOKEN: 'pak_test',
		});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_CACHE_PURGE_CONTROLLER_ENDPOINT must be an absolute https URL without credentials',
		);
	});

	test('leaves the optional outbound lookups unset by default', async () => {
		stubMinimalEnv();

		const config = await loadConfig();

		expect(config.integrations.breached_password_check.enabled).toBeUndefined();
	});

	test('reads the optional outbound lookup switches from the environment', async () => {
		stubMinimalEnv({
			FLUXER_BREACHED_PASSWORD_CHECK_ENABLED: 'false',
		});

		const config = await loadConfig();

		expect(config.integrations.breached_password_check.enabled).toBe(false);
	});

	// Echowire: the fork ships Bluesky login on, pointing at its own legal pages,
	// where upstream ships it off with no URLs.
	test('enables Bluesky login with the fork legal URLs by default', async () => {
		stubMinimalEnv();

		const config = await loadConfig();

		expect(config.auth.bluesky.enabled).toBe(true);
		expect(config.auth.bluesky.tos_uri).toBe('https://echowire.org/terms');
		expect(config.auth.bluesky.policy_uri).toBe('https://echowire.org/privacy');
		expect(config.auth.bluesky.keys).toEqual([]);
	});

	test('applies explicit Bluesky legal URLs from the environment', async () => {
		stubMinimalEnv({
			FLUXER_AUTH_BLUESKY_ENABLED: 'true',
			FLUXER_AUTH_BLUESKY_TOS_URI: 'https://chat.example.com/terms',
			FLUXER_AUTH_BLUESKY_POLICY_URI: 'https://chat.example.com/privacy',
		});

		const config = await loadConfig();

		expect(config.auth.bluesky.enabled).toBe(true);
		expect(config.auth.bluesky.tos_uri).toBe('https://chat.example.com/terms');
		expect(config.auth.bluesky.policy_uri).toBe('https://chat.example.com/privacy');
	});

	test('reads the upload relay secret through the override table', async () => {
		const secret = Buffer.alloc(32, 9).toString('base64');
		stubMinimalEnv({FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64: secret});

		const config = await loadConfig();

		expect(config.services.media_proxy.upload_relay.secret_base64).toBe(secret);
	});

	test('defaults the upload relay body limit to the media proxy ceiling', async () => {
		stubMinimalEnv();
		expect((await loadConfig()).services.media_proxy.upload_relay.max_body_bytes).toBe(524_288_000);
	});

	test('rejects a missing upload relay secret', async () => {
		stubMinimalEnv();
		vi.stubEnv('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64', '');

		await expect(loadConfig()).rejects.toThrow('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64 is required');
	});

	test('rejects a non-base64 upload relay secret', async () => {
		stubMinimalEnv({FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64: 'not base64!'});
		await expect(loadConfig()).rejects.toThrow('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64 must be base64');
	});

	test('rejects an upload relay secret shorter than 32 bytes', async () => {
		stubMinimalEnv({FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64: Buffer.alloc(16, 7).toString('base64')});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64 must decode to at least 32 bytes',
		);
	});

	test('rejects a VAPID public key that is not a 65-byte uncompressed point', async () => {
		const {privateKey} = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: Buffer.alloc(64, 4).toString('base64url'),
			FLUXER_VAPID_PRIVATE_KEY: privateKey,
		});
		await expect(loadConfig()).rejects.toThrow(
			/^FLUXER_VAPID_PUBLIC_KEY must be the base64url 65-byte uncompressed P-256 point\. Run rexctl doctor --fix/u,
		);
	});

	test('rejects a VAPID private key that is not a 32-byte scalar', async () => {
		const {publicKey} = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: publicKey,
			FLUXER_VAPID_PRIVATE_KEY: Buffer.alloc(31, 9).toString('base64url'),
		});
		await expect(loadConfig()).rejects.toThrow(
			/^FLUXER_VAPID_PRIVATE_KEY must be the base64url 32-byte P-256 scalar\. Run rexctl doctor --fix/u,
		);
	});

	test('rejects a well formed VAPID scalar that does not derive the public point', async () => {
		const {publicKey} = generateVapidPair();
		const other = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: publicKey,
			FLUXER_VAPID_PRIVATE_KEY: other.privateKey,
		});
		await expect(loadConfig()).rejects.toThrow('FLUXER_VAPID_PRIVATE_KEY does not match FLUXER_VAPID_PUBLIC_KEY');
	});

	test('accepts a generated VAPID pair', async () => {
		const pair = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: pair.publicKey,
			FLUXER_VAPID_PRIVATE_KEY: pair.privateKey,
		});

		const config = await loadConfig();

		expect(config.auth.vapid.public_key).toBe(pair.publicKey);
		expect(config.auth.vapid.private_key).toBe(pair.privateKey);
	});

	test('inserts the public port into every other public url the config contains', async () => {
		stubMinimalEnv({
			FLUXER_S3_PUBLIC_ENDPOINT: 'http://localhost/s3',
			FLUXER_EMAIL_APP_BASE_URL: 'http://localhost',
			FLUXER_AUTH_BLUESKY_CLIENT_URI: 'http://localhost',
			FLUXER_AUTH_BLUESKY_TOS_URI: 'http://localhost/terms',
			FLUXER_APP_ICON_URL: 'http://localhost/icon.png',
			FLUXER_LIVEKIT_INTERNAL_URL: 'http://livekit:7880',
		});

		const config = await loadConfig();

		expect(config.s3?.presigned_url_base).toBe('http://localhost:8088/s3');
		expect(config.integrations.email.app_base_url).toBe('http://localhost:8088');
		expect(config.auth.bluesky.client_uri).toBe('http://localhost:8088');
		expect(config.auth.bluesky.tos_uri).toBe('http://localhost:8088/terms');
		expect(config.instance.branding.icon_url).toBe('http://localhost:8088/icon.png');
		expect(config.integrations.voice.internal_url).toBe('http://livekit:7880');
	});
});

describe('FLUXER_PUBLIC_ORIGIN', () => {
	beforeEach(() => {
		resetConfig();
		clearFluxerEnv();
	});

	afterEach(() => {
		resetConfig();
		vi.unstubAllEnvs();
	});

	test('a ported origin ports every derived endpoint and every compose override', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
			FLUXER_MARKETING_ENDPOINT: 'https://chat.example.com:29080',
			FLUXER_MEDIA_ENDPOINT: 'https://chat.example.com:29080/media',
			FLUXER_MEDIA_PROXY_UPLOAD_RELAY_ENDPOINT: 'https://chat.example.com:29080/media',
			FLUXER_LIVEKIT_URL: 'https://chat.example.com:29080/livekit',
			FLUXER_PASSKEY_ADDITIONAL_ALLOWED_ORIGINS: 'https://chat.example.com:29080',
		});

		const config = await loadConfig();

		expect(config.domain.public_port).toBe(29080);
		expect(config.domain.public_origin).toBe('https://chat.example.com:29080');
		expect(config.endpoints.api_client).toBe('https://chat.example.com:29080/api');
		expect(config.endpoints.app).toBe('https://chat.example.com:29080');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com:29080/gateway');
		expect(config.endpoints.admin).toBe('https://chat.example.com:29080/admin');
		expect(config.endpoints.marketing).toBe('https://chat.example.com:29080');
		expect(config.endpoints.media).toBe('https://chat.example.com:29080/media');
		expect(config.services.media_proxy.upload_relay.endpoint).toBe('https://chat.example.com:29080/media');
		expect(config.integrations.voice.url).toBe('https://chat.example.com:29080/livekit');
		expect(config.auth.passkeys.additional_allowed_origins).toEqual(['https://chat.example.com:29080']);
	});

	test('the origin port wins over a FLUXER_PUBLIC_PORT that disagrees', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '443',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
		});

		const config = await loadConfig();

		expect(config.domain.public_port).toBe(29080);
		expect(config.endpoints.app).toBe('https://chat.example.com:29080');
		expect(config.endpoints.api_client).toBe('https://chat.example.com:29080/api');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com:29080/gateway');
		expect(config.endpoints.admin).toBe('https://chat.example.com:29080/admin');
	});

	test('accepts an origin whose port matches FLUXER_PUBLIC_PORT', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '29080',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
		});

		expect((await loadConfig()).endpoints.gateway).toBe('wss://chat.example.com:29080/gateway');
	});

	test('normalizes an origin written with an explicit default port', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '443',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:443',
			FLUXER_ADMIN_ENDPOINT: 'https://chat.example.com/admin',
		});

		const config = await loadConfig();

		expect(config.domain.public_port).toBe(443);
		expect(config.domain.public_origin).toBe('https://chat.example.com');
		expect(config.endpoints.admin).toBe('https://chat.example.com/admin');
		expect(config.endpoints.app).toBe('https://chat.example.com');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com/gateway');
	});

	test('takes the scheme and the domain from the origin when neither is set', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: '',
			FLUXER_PUBLIC_SCHEME: '',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
		});

		const config = await loadConfig();

		expect(config.domain.base_domain).toBe('chat.example.com');
		expect(config.domain.public_scheme).toBe('https');
		expect(config.domain.public_port).toBe(29080);
	});

	test('the origin scheme wins over a FLUXER_PUBLIC_SCHEME that disagrees', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'http',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com',
		});

		const config = await loadConfig();

		expect(config.domain.public_scheme).toBe('https');
		expect(config.endpoints.app).toBe('https://chat.example.com');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com/gateway');
	});

	test('the origin host wins over a FLUXER_BASE_DOMAIN that disagrees', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://other.example.com',
		});

		const config = await loadConfig();

		expect(config.domain.base_domain).toBe('other.example.com');
		expect(config.endpoints.app).toBe('https://other.example.com');
	});

	test('refuses to boot on an origin that is not a bare origin', async () => {
		stubMinimalEnv({FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com/app'});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_PUBLIC_ORIGIN must be a scheme, host and optional port such as https://chat.example.com:8443',
		);
	});

	test('leaves the derived origin canonical when nothing is set', async () => {
		stubMinimalEnv();
		expect((await loadConfig()).domain.public_origin).toBe('http://localhost:8088');
	});
});
