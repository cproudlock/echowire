// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	APP_PROTOCOL_SCHEMES,
	APP_PROTOCOLS,
	appProtocolSchemeLengthAt,
	isAppProtocolScheme,
} from '@fluxer/constants/src/AppProtocolConstants';
import {describe, expect, it} from 'vitest';

describe('app protocol schemes', () => {
	it('answers to echowire and keeps fluxer for links from other instances', () => {
		expect([...APP_PROTOCOLS]).toEqual(['echowire', 'fluxer']);
		expect([...APP_PROTOCOL_SCHEMES]).toEqual(['echowire:', 'fluxer:']);
	});

	it('recognises a URL.protocol value in either scheme and any case', () => {
		expect(isAppProtocolScheme('echowire:')).toBe(true);
		expect(isAppProtocolScheme('FLUXER:')).toBe(true);
		expect(isAppProtocolScheme('https:')).toBe(false);
		expect(isAppProtocolScheme('echowirex:')).toBe(false);
		expect(isAppProtocolScheme('')).toBe(false);
	});

	it('measures the scheme at an index, or returns 0', () => {
		expect(appProtocolSchemeLengthAt('echowire://invite/abc')).toBe('echowire:'.length);
		expect(appProtocolSchemeLengthAt('fluxer://invite/abc')).toBe('fluxer:'.length);
		expect(appProtocolSchemeLengthAt('see fluxer:/channels/1', 4)).toBe('fluxer:'.length);
		expect(appProtocolSchemeLengthAt('see fluxer:/channels/1', 0)).toBe(0);
		expect(appProtocolSchemeLengthAt('https://echowire.org')).toBe(0);
	});
});
