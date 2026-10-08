// SPDX-License-Identifier: AGPL-3.0-or-later

import {appProtocolSchemeLengthAt, isAppProtocolScheme} from '@fluxer/constants/src/AppProtocolConstants';

// Echowire: this is the scheme we WRITE (buildAppProtocolUrl and the settings links). It stays
// 'fluxer' until desktop and mobile builds that register echowire:// are what people have installed;
// switching it earlier would hand out links an older install cannot open. Everything we READ accepts
// both schemes, see AppProtocolConstants.ts.
export const APP_PROTOCOL = 'fluxer';
export const APP_PROTOCOL_SCHEME = `${APP_PROTOCOL}:`;
export const APP_PROTOCOL_PREFIX = `${APP_PROTOCOL}://`;

export function buildAppProtocolUrl(path: string): string {
	const cleaned = path.startsWith('/') ? path : `/${path.replace(/^\/+/, '')}`;
	return `${APP_PROTOCOL_SCHEME}${cleaned}`;
}

export function isAppProtocolUrl(url: string): boolean {
	const schemeLength = appProtocolSchemeLengthAt(url.toLowerCase());
	if (schemeLength === 0 || url.length <= schemeLength) return false;
	try {
		return isAppProtocolScheme(new URL(url).protocol);
	} catch {
		return true;
	}
}

// The part of an app-scheme URL after its scheme, for URLs the URL parser rejected.
export function stripAppProtocolScheme(url: string): string {
	return url.slice(appProtocolSchemeLengthAt(url.toLowerCase()));
}
