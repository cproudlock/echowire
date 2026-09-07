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
export const STATIC_CDN_URL = 'https://fluxerstatic.com';
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
