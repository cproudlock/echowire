// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

// Echowire: upstream #3035 made ALTCHA the only captcha and dropped the provider
// dimension. This fork keeps it, because the mobile clients already on the stores
// (1.7.32 and earlier) implement hCaptcha and Turnstile only and fall back to
// hCaptcha for a provider they do not recognise, so an ALTCHA-only server locks
// every installed client out of registration and login. See docs/adr/0008.
export const CaptchaProviderSchema = z.enum(['altcha', 'hcaptcha', 'turnstile']);

export type CaptchaProvider = z.infer<typeof CaptchaProviderSchema>;

export const CAPTCHA_MIN_COST = 1000;
export const CAPTCHA_MAX_COST = 20000;
export const CAPTCHA_MIN_MAX_COUNTER = 100;
export const CAPTCHA_MAX_MAX_COUNTER = 20000;

const captchaConfigFields = {
	enabled: z.boolean(),
	// Null means nobody has chosen a provider through the admin surface, in which
	// case the repository resolves one from FLUXER_CAPTCHA_PROVIDER, falling back to
	// altcha so a fresh self-hosted instance behaves the way upstream intends.
	provider: CaptchaProviderSchema.nullable(),
	cost: z.number().int().min(CAPTCHA_MIN_COST).max(CAPTCHA_MAX_COST),
	max_counter: z.number().int().min(CAPTCHA_MIN_MAX_COUNTER).max(CAPTCHA_MAX_MAX_COUNTER),
};

export const CaptchaConfigSchema = z.object({
	enabled: captchaConfigFields.enabled.default(true),
	provider: captchaConfigFields.provider.default(null),
	cost: captchaConfigFields.cost.default(5000),
	max_counter: captchaConfigFields.max_counter.default(1000),
});

export type CaptchaConfig = z.infer<typeof CaptchaConfigSchema>;

export const DEFAULT_CAPTCHA_CONFIG: CaptchaConfig = CaptchaConfigSchema.parse({});

export const CaptchaConfigUpdateRequest = z.object(captchaConfigFields).partial();

export type CaptchaConfigUpdateRequest = z.infer<typeof CaptchaConfigUpdateRequest>;

export const CaptchaConfigResponse = CaptchaConfigSchema;

export type CaptchaConfigResponse = z.infer<typeof CaptchaConfigResponse>;
