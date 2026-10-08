// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	APP_PROTOCOL,
	buildAppProtocolUrl,
	isAppProtocolUrl,
	stripAppProtocolScheme,
} from '@app/features/ui/utils/AppProtocol';
import {describe, expect, it} from 'vitest';

describe('AppProtocol', () => {
	it('still writes fluxer:// links until builds that register echowire:// are out', () => {
		expect(APP_PROTOCOL).toBe('fluxer');
		expect(buildAppProtocolUrl('/invite/abc')).toBe('fluxer:/invite/abc');
	});

	it('reads links in either scheme', () => {
		expect(isAppProtocolUrl('fluxer://invite/abc')).toBe(true);
		expect(isAppProtocolUrl('echowire://invite/abc')).toBe(true);
		expect(isAppProtocolUrl('ECHOWIRE://invite/abc')).toBe(true);
		expect(isAppProtocolUrl('https://echowire.org/invite/abc')).toBe(false);
		expect(isAppProtocolUrl('echowire:')).toBe(false);
	});

	it('strips whichever scheme a URL carries', () => {
		expect(stripAppProtocolScheme('echowire:/channels/1/2')).toBe('/channels/1/2');
		expect(stripAppProtocolScheme('fluxer:/channels/1/2')).toBe('/channels/1/2');
		expect(stripAppProtocolScheme('FLUXER:invite/x')).toBe('invite/x');
	});
});
