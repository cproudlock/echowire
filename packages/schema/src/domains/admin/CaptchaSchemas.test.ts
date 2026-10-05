// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	CaptchaConfigSchema,
	CaptchaConfigUpdateRequest,
	DEFAULT_CAPTCHA_CONFIG,
} from '@fluxer/schema/src/domains/admin/CaptchaSchemas';
import {describe, expect, test} from 'vitest';

describe('captcha configuration', () => {
	test('defaults to enabled at the mobile-friendly difficulty', () => {
		expect(CaptchaConfigSchema.parse({})).toEqual({enabled: true, provider: null, cost: 5000, max_counter: 1000});
		expect(DEFAULT_CAPTCHA_CONFIG).toEqual({enabled: true, provider: null, cost: 5000, max_counter: 1000});
	});

	// Echowire: the guard that keeps every installed client able to log in.
	//
	// The mobile clients on the stores (1.7.32 and earlier) implement hCaptcha and
	// Turnstile only, and fall back to hCaptcha for any provider string they do not
	// recognise. Production therefore has to be able to say turnstile. If this stops
	// accepting turnstile, the instance can no longer be configured for a captcha its
	// own clients can solve, and registration and login break for all of them.
	//
	// Mutation-checked: flipping the enum to z.enum([altcha]) fails this test.
	test('keeps accepting turnstile and hcaptcha as captcha providers', () => {
		expect(CaptchaConfigUpdateRequest.safeParse({provider: 'turnstile'}).success).toBe(true);
		expect(CaptchaConfigUpdateRequest.safeParse({provider: 'hcaptcha'}).success).toBe(true);
		expect(CaptchaConfigUpdateRequest.safeParse({provider: 'altcha'}).success).toBe(true);
		expect(CaptchaConfigSchema.parse({provider: 'turnstile'}).provider).toBe('turnstile');
		expect(CaptchaConfigSchema.parse({provider: 'hcaptcha'}).provider).toBe('hcaptcha');
	});

	test('rejects a provider nobody implements', () => {
		expect(CaptchaConfigUpdateRequest.safeParse({provider: 'recaptcha'}).success).toBe(false);
		expect(CaptchaConfigUpdateRequest.safeParse({provider: 'none'}).success).toBe(false);
	});

	test('rejects difficulty outside the supported range', () => {
		expect(CaptchaConfigUpdateRequest.safeParse({cost: 999}).success).toBe(false);
		expect(CaptchaConfigUpdateRequest.safeParse({cost: 20001}).success).toBe(false);
		expect(CaptchaConfigUpdateRequest.safeParse({max_counter: 99}).success).toBe(false);
		expect(CaptchaConfigUpdateRequest.safeParse({max_counter: 20001}).success).toBe(false);
		expect(CaptchaConfigSchema.safeParse({cost: 20001}).success).toBe(false);
	});

	test('keeps a partial update partial without filling defaults', () => {
		expect(CaptchaConfigUpdateRequest.parse({})).toEqual({});
		expect(CaptchaConfigUpdateRequest.parse({enabled: false})).toEqual({enabled: false});
		expect(CaptchaConfigUpdateRequest.parse({cost: 1000, max_counter: 100})).toEqual({cost: 1000, max_counter: 100});
	});
});
