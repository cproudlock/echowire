// SPDX-License-Identifier: AGPL-3.0-or-later

export const APP_PROTOCOL = 'fluxer';
export const STABLE_APP_URL = 'https://echowire.org';
// Canary loads the same origin as stable on purpose. The SPA's REST transport
// withholds Authorization (and the sudo + features headers) whenever the API is
// off-origin — see isOffOrigin/assembleHeaders in RestTransport — and instance
// config hands every client an absolute api_client of https://echowire.org/api.
// Pointing canary at canary.echowire.org therefore broke login outright and
// would have broken every authenticated request even with CORS opened up.
// canary.echowire.org is still served (same backend) and is still the update
// feed host in Updater.ts, which runs in the main process where CORS does not
// apply. Revisit only if canary becomes a genuinely separate deployment with
// its own per-host instance config.
export const CANARY_APP_URL = 'https://echowire.org';

// Echowire: upstream is migrating to a second domain and gained these four
// exports, which their DesktopConfig, Window and preload code now imports, so
// they must exist. This instance is not migrating anywhere, so they are
// neutralised rather than removed: the migrated origin is our own origin and
// the entry path is empty, which makes getAppUrl() return the same URL down
// both branches and getOfficialAppOrigins() a list of one origin repeated.
// PASSKEY_RP_IDS reaches the renderer through the preload bridge, so it names
// our relying party, never upstream's.
export const STABLE_MIGRATED_APP_ORIGIN = 'https://echowire.org';
export const CANARY_MIGRATED_APP_ORIGIN = 'https://echowire.org';
export const MIGRATED_APP_ENTRY_PATH = '';
export const PASSKEY_RP_IDS = ['echowire.org'] as const;
export const STATIC_CDN_URL = 'https://fluxerstatic.com';
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
