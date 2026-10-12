// SPDX-License-Identifier: AGPL-3.0-or-later

import {isAltchaPayload} from '@app/api/middleware/CaptchaMiddleware';
import {describe, expect, it} from 'vitest';

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('isAltchaPayload', () => {
	it('recognises a token the web client builds from a solved ALTCHA challenge', () => {
		const token = encode({
			challenge: {parameters: {algorithm: 'SHA-256'}, signature: 'sig'},
			solution: {counter: 7, derivedKey: 'abc', time: 12},
		});
		expect(isAltchaPayload(token)).toBe(true);
	});

	it('leaves Turnstile and hCaptcha tokens alone', () => {
		expect(isAltchaPayload('0.Zm9vYmFyLXR1cm5zdGlsZS10b2tlbg')).toBe(false);
		expect(isAltchaPayload('P1_eyJ0eXAiOiJKV1QifQ.abc')).toBe(false);
	});

	it('rejects JSON that is not shaped like a solved challenge', () => {
		expect(isAltchaPayload(encode({challenge: {}}))).toBe(false);
		expect(isAltchaPayload(encode({solution: {}}))).toBe(false);
		expect(isAltchaPayload(encode({challenge: 'x', solution: 'y'}))).toBe(false);
		expect(isAltchaPayload(encode(null))).toBe(false);
		expect(isAltchaPayload(encode([]))).toBe(false);
		expect(isAltchaPayload('')).toBe(false);
	});
});
