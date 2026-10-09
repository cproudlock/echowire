// SPDX-License-Identifier: AGPL-3.0-or-later

import {appProtocolSchemeLengthAt} from '@fluxer/constants/src/AppProtocolConstants';

const HTTP_PREFIX = 'http://';
const HTTPS_PREFIX = 'https://';

export function startsWithUrl(text: string): boolean {
	if (text.length < HTTPS_PREFIX.length) return false;
	if (text.startsWith(HTTP_PREFIX)) {
		const prefixEnd = 7;
		return !text.substring(0, prefixEnd).includes('"') && !text.substring(0, prefixEnd).includes("'");
	}
	if (text.startsWith(HTTPS_PREFIX)) {
		const prefixEnd = 8;
		return !text.substring(0, prefixEnd).includes('"') && !text.substring(0, prefixEnd).includes("'");
	}
	const schemeLength = appProtocolSchemeLengthAt(text);
	if (schemeLength > 0) {
		if (text.startsWith('//', schemeLength)) {
			const prefixEnd = schemeLength + 2;
			return !text.substring(0, prefixEnd).includes('"') && !text.substring(0, prefixEnd).includes("'");
		}
		const nextChar = text[schemeLength] ?? '';
		return nextChar === '/' || /[A-Za-z0-9_-]/.test(nextChar);
	}
	return false;
}
