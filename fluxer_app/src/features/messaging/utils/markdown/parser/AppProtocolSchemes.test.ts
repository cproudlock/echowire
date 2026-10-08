// SPDX-License-Identifier: AGPL-3.0-or-later

import {startsWithUrl} from '@app/features/messaging/utils/markdown/parser/StringUtils';
import {convertToAsciiUrl, isValidUrl} from '@app/features/messaging/utils/markdown/parser/UrlUtils';
import {describe, expect, it} from 'vitest';

describe.each(['echowire', 'fluxer'])('%s links in markdown', (scheme) => {
	it('start a URL, with or without the slashes', () => {
		expect(startsWithUrl(`${scheme}://invite/abc`)).toBe(true);
		expect(startsWithUrl(`${scheme}:/channels/1/2`)).toBe(true);
		expect(startsWithUrl(`${scheme}:gift/xyz`)).toBe(true);
	});

	it('are valid URLs and are left alone by ASCII conversion', () => {
		expect(isValidUrl(`${scheme}://invite/abc`)).toBe(true);
		expect(convertToAsciiUrl(`${scheme}://invite/abc`)).toBe(`${scheme}://invite/abc`);
	});

	it('do not match a longer word that merely begins the same', () => {
		expect(startsWithUrl(`${scheme}x://invite/abc`)).toBe(false);
		expect(startsWithUrl(`${scheme}: nope`)).toBe(false);
	});
});

describe('other schemes', () => {
	it('stay rejected', () => {
		expect(startsWithUrl('javascript:alert(1)')).toBe(false);
		expect(isValidUrl('javascript:alert(1)')).toBe(false);
		expect(isValidUrl('discord://invite/abc')).toBe(false);
	});
});
