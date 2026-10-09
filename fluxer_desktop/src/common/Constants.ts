// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL, type BuildChannel} from '@electron/common/BuildChannel';
import {
	DESKTOP_LOCAL_APP_HOST,
	DESKTOP_LOCAL_APP_ORIGIN,
	DESKTOP_LOCAL_APP_SCHEME,
	DESKTOP_LOCAL_APP_URL,
} from '@fluxer/desktop_ipc/src/LocalAppRouteContract';

// Echowire: echowire:// is our own scheme; fluxer:// stays registered and accepted so a link from
// another instance (federation) still opens this app. Keep in step with
// packages/constants/src/AppProtocolConstants.ts, which the Electron main process cannot import.
// The development channel claims only its own scheme so a dev build never steals the production one.
export const CHANNEL_APP_PROTOCOLS: Record<BuildChannel, string> = {
	stable: 'echowire',
	canary: 'echowire',
	development: 'echowire-development',
};
export const APP_PROTOCOL = CHANNEL_APP_PROTOCOLS[BUILD_CHANNEL];
export const APP_PROTOCOLS: ReadonlyArray<string> =
	BUILD_CHANNEL === 'development' ? [APP_PROTOCOL] : [APP_PROTOCOL, 'fluxer'];
export const STABLE_APP_URL = 'https://echowire.org';
// Canary loads the same origin as stable on purpose. The SPA's REST transport
// withholds Authorization (and the sudo + features headers) whenever the API is
// off-origin (see isOffOrigin/assembleHeaders in RestTransport), and instance
// config hands every client an absolute api_client of https://echowire.org/api.
// Pointing canary at canary.echowire.org therefore broke login outright and
// would have broken every authenticated request even with CORS opened up.
// canary.echowire.org is still served (same backend) and is still the update
// feed host in ShellDownloadFormats.ts, which runs in the main process where CORS does not
// apply. Revisit only if canary becomes a genuinely separate deployment with
// its own per-host instance config.
export const CANARY_APP_URL = 'https://echowire.org';
const DEVELOPMENT_APP_URL = 'http://localhost:8088';
export const CHANNEL_APP_URLS: Record<BuildChannel, string> = {
	stable: STABLE_APP_URL,
	canary: CANARY_APP_URL,
	development: DEVELOPMENT_APP_URL,
};
export const LOCAL_DEVELOPMENT_INSTANCE_URL = BUILD_CHANNEL === 'development' ? DEVELOPMENT_APP_URL : null;
export const DOWNLOAD_PAGE_URLS: Record<BuildChannel, string> = {
	stable: 'https://echowire.org/download',
	canary: 'https://canary.echowire.org/download',
	development: 'http://localhost:8088/download',
};

// Echowire: upstream is migrating to a second domain, and DesktopConfig still imports these two
// origins. This instance is not migrating anywhere, so they are neutralised rather than removed:
// the migrated origin is our own origin, which makes getOfficialAppOrigins() a list of one origin
// repeated. (Upstream dropped MIGRATED_APP_ENTRY_PATH and PASSKEY_RP_IDS; nothing here uses them.)
export const STABLE_MIGRATED_APP_ORIGIN = 'https://echowire.org';
export const CANARY_MIGRATED_APP_ORIGIN = 'https://echowire.org';
export const DESKTOP_APP_SCHEME = DESKTOP_LOCAL_APP_SCHEME;
export const DESKTOP_APP_HOST = DESKTOP_LOCAL_APP_HOST;
export const DESKTOP_APP_ORIGIN = DESKTOP_LOCAL_APP_ORIGIN;
export const DESKTOP_APP_URL = DESKTOP_LOCAL_APP_URL;
export const DESKTOP_APP_LANDING_URL = `${DESKTOP_LOCAL_APP_URL}channels/@me`;
export const DESKTOP_PREBOOT_THEME_CHANNEL = 'desktop-preboot-theme:report';
export const DESKTOP_FIRST_CONTENT_PAINTED_CHANNEL = 'desktop-window:first-content-painted';
export const STATIC_CDN_URL = 'https://fluxerstatic.com';
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
