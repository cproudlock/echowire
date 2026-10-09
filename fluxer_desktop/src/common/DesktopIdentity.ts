// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL, type BuildChannel} from '@electron/common/BuildChannel';

// Echowire: display names are lowercase like the brand. Identifiers below (bundle id, desktop entry id,
// AppUserModelID, toast CLSID) deliberately keep the fork's existing values, not upstream's.
const DESKTOP_APP_NAMES: Record<BuildChannel, string> = {
	stable: 'echowire',
	canary: 'echowire canary',
	development: 'echowire development',
};
// Echowire: the artifact product name prefixes every published installer and must match what the
// DownloadService publishes (echowire / echowire-canary).
const DESKTOP_ARTIFACT_PRODUCT_NAMES: Record<BuildChannel, string> = {
	stable: 'echowire',
	canary: 'echowire-canary',
	development: 'echowire-development',
};
const MACOS_BUNDLE_IDS: Record<BuildChannel, string> = {
	stable: 'org.echowire.app',
	canary: 'org.echowire.canary',
	development: 'org.echowire.development',
};
// Echowire: this MUST match the packaged Linux name (electron-builder linuxPackageName =
// 'echowire'/'echowire-canary'), otherwise the app's runtime .desktop generator can't find
// the system entry the .deb installed ('echowire.desktop') and writes a SECOND user-local
// entry ('fluxer.desktop', same Name), producing a duplicate launcher.
// It also feeds StartupWMClass + the freedesktop notification desktop-entry hint, so it has
// to line up with the installed file. Upstream #3185 moved to app.fluxer.FluxerDesktop; we do not.
const LINUX_DESKTOP_ENTRY_IDS: Record<BuildChannel, string> = {
	stable: 'echowire',
	canary: 'echowire-canary',
	development: 'echowire-development',
};
// Old id previous builds wrote; used to clean up stale user-local duplicates on upgrade.
const LEGACY_LINUX_DESKTOP_ENTRY_IDS: Record<BuildChannel, string> = {
	stable: 'fluxer',
	canary: 'fluxer-canary',
	development: 'fluxer-development',
};
const LINUX_PORTAL_SESSION_TOKENS: Record<BuildChannel, string> = {
	stable: 'echowire_global_shortcuts',
	canary: 'echowire_canary_global_shortcuts',
	development: 'echowire_development_global_shortcuts',
};
const WINDOWS_VELOPACK_IDS: Record<BuildChannel, string> = {
	stable: 'fluxer_desktop',
	canary: 'fluxer_desktop_canary',
	development: 'fluxer_desktop_development',
};
// Echowire: an identifier, not display text. Changing it would orphan pinned taskbar entries and
// the registered toast activator, so it keeps the original casing.
const WINDOWS_APP_USER_MODEL_IDS: Record<BuildChannel, string> = {
	stable: 'Echowire.Echowire',
	canary: 'Echowire.Echowire.Canary',
	development: 'Echowire.Echowire.Development',
};
const WINDOWS_TOAST_ACTIVATOR_CLSIDS: Record<BuildChannel, string> = {
	stable: '{48EEF21B-F3AE-431E-8CF2-386FFB2143F2}',
	canary: '{9CEDB5C0-3552-43B0-A279-2232E0CDF74C}',
	development: '{B277AB5D-371C-4098-A76D-1DAE00AC0863}',
};

export const DESKTOP_APP_NAME = DESKTOP_APP_NAMES[BUILD_CHANNEL];
export const DESKTOP_ARTIFACT_PRODUCT_NAME = DESKTOP_ARTIFACT_PRODUCT_NAMES[BUILD_CHANNEL];
export const MACOS_BUNDLE_ID = MACOS_BUNDLE_IDS[BUILD_CHANNEL];
export const LINUX_DESKTOP_ENTRY_ID = LINUX_DESKTOP_ENTRY_IDS[BUILD_CHANNEL];
export const LINUX_PORTAL_SESSION_TOKEN = LINUX_PORTAL_SESSION_TOKENS[BUILD_CHANNEL];
export const LEGACY_LINUX_DESKTOP_ENTRY_ID = LEGACY_LINUX_DESKTOP_ENTRY_IDS[BUILD_CHANNEL];
// Echowire: the hicolor icons are installed under the entry id, as before.
export const LINUX_ICON_NAME = LINUX_DESKTOP_ENTRY_ID;
export const WINDOWS_SHORTCUT_AUTHOR = 'echowire';
export const WINDOWS_VELOPACK_ID = WINDOWS_VELOPACK_IDS[BUILD_CHANNEL];
// Echowire: the directory older Squirrel-based installs used, kept at upstream's value because it
// names installs that already exist on disk. Rebranding it would make the cleanup match nothing.
export const WINDOWS_LEGACY_SQUIRREL_ID = 'fluxer_app';
export const WINDOWS_APP_USER_MODEL_ID = WINDOWS_APP_USER_MODEL_IDS[BUILD_CHANNEL];
export const WINDOWS_LEGACY_APP_USER_MODEL_IDS = [`velopack.${WINDOWS_VELOPACK_ID}`];
export const WINDOWS_TOAST_ACTIVATOR_CLSID = WINDOWS_TOAST_ACTIVATOR_CLSIDS[BUILD_CHANNEL];
