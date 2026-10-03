// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHmac} from 'node:crypto';
import {Config} from '@app/api/Config';
import {sharedListHas} from '@app/api/infrastructure/activity/SharedLists';
import {Logger} from '@app/api/Logger';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {extractEmailDomain} from '@app/api/utils/EmailDomainUtils';
import {Headers} from '@fluxer/constants/src/Headers';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {CaptchaRequiredError, InvalidCaptchaError} from '@fluxer/errors/src/CaptchaErrors';
import {extractClientIp} from '@fluxer/ip_utils/src/ClientIp';
import type {CaptchaConfig, CaptchaProvider} from '@fluxer/schema/src/domains/admin/CaptchaSchemas';
import type {ICaptchaProvider} from '@pkgs/captcha/src/ICaptchaProvider';
import {AltchaProvider} from '@pkgs/captcha/src/providers/AltchaProvider';
import {HcaptchaProvider} from '@pkgs/captcha/src/providers/HcaptchaProvider';
import {TurnstileProvider} from '@pkgs/captcha/src/providers/TurnstileProvider';
import type {Context} from 'hono';
import {createMiddleware} from 'hono/factory';

const ALTCHA_SPENT_CHALLENGE_KEY_PREFIX = 'captcha:altcha:spent:';
const TEST_ENABLE_CAPTCHA_HEADER = 'x-fluxer-test-enable-captcha';

function deriveAltchaSecret(label: string): string {
	return createHmac('sha256', Config.auth.sudoModeSecret).update(label).digest('hex');
}

function createAltchaProvider(config: CaptchaConfig): AltchaProvider {
	return new AltchaProvider({
		hmacSignatureSecret: deriveAltchaSecret('fluxer-altcha-challenge-signature-v1'),
		hmacKeySignatureSecret: deriveAltchaSecret('fluxer-altcha-key-signature-v1'),
		cost: config.cost,
		maxCounter: config.max_counter,
		claimChallenge: (signature, ttlSeconds) =>
			getKVClient().setnx(`${ALTCHA_SPENT_CHALLENGE_KEY_PREFIX}${signature}`, '1', ttlSeconds),
		logger: Logger,
	});
}

// Echowire: the provider offered to a client that cannot solve ALTCHA. A null
// provider means nobody chose one, which is ALTCHA, the upstream default.
function offeredProvider(config: CaptchaConfig): CaptchaProvider {
	return config.provider ?? 'altcha';
}

// Echowire: hCaptcha and Turnstile secrets live in the environment only, never in
// the database. See docs/adr/0008.
function createHttpProvider(provider: 'hcaptcha' | 'turnstile'): ICaptchaProvider | null {
	const keys = provider === 'hcaptcha' ? Config.captcha.hcaptcha : Config.captcha.turnstile;
	const secretKey = keys?.secretKey;
	if (!secretKey) {
		Logger.error({provider}, 'Captcha provider is configured but its secret key is missing');
		return null;
	}
	const options = {secretKey, logger: Logger};
	return provider === 'hcaptcha' ? new HcaptchaProvider(options) : new TurnstileProvider(options);
}

// Echowire: every challenge carries the ALTCHA challenge alongside the provider
// name, so one response serves both client families. The web app solves the ALTCHA
// challenge and retries with X-Captcha-Type: altcha; a mobile client already on the
// stores reads captcha_provider and renders the widget it implements. Naming the
// offered provider here is what keeps those clients able to log in, because they
// fall back to hCaptcha for any provider string they do not recognise.
async function challengeData(provider: CaptchaProvider, altcha: AltchaProvider): Promise<Record<string, unknown>> {
	return {captcha_provider: provider, altcha_challenge: await altcha.createChallenge()};
}

function requestedProvider(ctx: Context<HonoEnv>): CaptchaProvider | null {
	const requested = ctx.req.header(Headers.X_CAPTCHA_TYPE);
	return requested === 'altcha' || requested === 'hcaptcha' || requested === 'turnstile' ? requested : null;
}

export async function verifyCaptchaToken(ctx: Context<HonoEnv>): Promise<boolean> {
	if (Config.dev.testModeEnabled && ctx.req.header(TEST_ENABLE_CAPTCHA_HEADER) !== 'true') return false;
	const config = await ctx.get('instanceConfigRepository').getCaptchaConfig();
	if (!config.enabled) return false;
	const user = ctx.get('user') as User | undefined;
	if (sharedListHas('email_domain_exempt', extractEmailDomain(user?.email))) return false;
	if (userHasCaptchaExemptFlag(user)) return false;
	if (await requestUserHasCaptchaExemptFlag(ctx)) return false;
	const altcha = createAltchaProvider(config);
	const offered = offeredProvider(config);
	const token = ctx.req.header(Headers.X_CAPTCHA_TOKEN);
	if (!token) {
		throw new CaptchaRequiredError(await challengeData(offered, altcha));
	}
	const resolved = requestedProvider(ctx) ?? offered;
	if (resolved === 'altcha') {
		if (!(await altcha.verify({token}))) {
			throw new InvalidCaptchaError(await challengeData(offered, altcha));
		}
		return true;
	}
	const provider = createHttpProvider(resolved);
	if (!provider) {
		throw new InvalidCaptchaError(await challengeData(offered, altcha));
	}
	const remoteIp =
		extractClientIp(ctx.req.raw, {
			trustClientIpHeader: Config.proxy.trust_client_ip_header,
			clientIpHeaderName: Config.proxy.client_ip_header,
		}) ?? undefined;
	if (!(await provider.verify({token, remoteIp}))) {
		throw new InvalidCaptchaError(await challengeData(offered, altcha));
	}
	return true;
}

function userHasCaptchaExemptFlag(user: User | null | undefined): boolean {
	return user != null && (user.flags & UserFlags.APP_STORE_REVIEWER) !== 0n;
}

async function requestUserHasCaptchaExemptFlag(ctx: Context<HonoEnv>): Promise<boolean> {
	try {
		const body = (await ctx.req.raw.clone().json()) as unknown;
		if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
		const email = (body as Record<string, unknown>).email;
		if (typeof email !== 'string') return false;
		const user = await ctx.get('userRepository').findByEmail(email);
		return userHasCaptchaExemptFlag(user);
	} catch {
		return false;
	}
}

export const CaptchaMiddleware = createMiddleware<HonoEnv>(async (ctx, next) => {
	await verifyCaptchaToken(ctx);
	await next();
});
