// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL} from '@electron/common/BuildChannel';

// Echowire: display name, lowercase like the brand. Identifiers below (bundle id, desktop entry id,
// AppUserModelID, toast CLSID) deliberately keep their existing values.
export const DESKTOP_APP_NAME = BUILD_CHANNEL === 'canary' ? 'echowire canary' : 'echowire';
export const MACOS_BUNDLE_ID = BUILD_CHANNEL === 'canary' ? 'org.echowire.canary' : 'org.echowire.app';
// Echowire: this MUST match the packaged Linux name (electron-builder linuxPackageName =
// 'echowire'/'echowire-canary'), otherwise the app's runtime .desktop generator can't find
// the system entry the .deb installed ('echowire.desktop') and writes a SECOND user-local
// entry ('fluxer.desktop', same Name), producing a duplicate "Echowire (Echowire)" launcher.
// It also feeds StartupWMClass + the freedesktop notification desktop-entry hint, so it has
// to line up with the installed file. Was left as the upstream 'fluxer' id during the rebrand.
export const LINUX_DESKTOP_ENTRY_ID = BUILD_CHANNEL === 'canary' ? 'echowire-canary' : 'echowire';
// Old ids previous builds wrote; used to clean up stale user-local duplicates on upgrade.
export const LINUX_LEGACY_DESKTOP_ENTRY_IDS = BUILD_CHANNEL === 'canary' ? ['fluxer-canary'] : ['fluxer'];
export const WINDOWS_SHORTCUT_AUTHOR = 'echowire';
const WINDOWS_VELOPACK_ID = BUILD_CHANNEL === 'canary' ? 'fluxer_desktop_canary' : 'fluxer_desktop';
// Echowire: an identifier, not display text. Changing it would orphan pinned taskbar entries and
// the registered toast activator, so it keeps the original casing.
export const WINDOWS_APP_USER_MODEL_ID = BUILD_CHANNEL === 'canary' ? 'Echowire.Echowire.Canary' : 'Echowire.Echowire';
export const WINDOWS_LEGACY_APP_USER_MODEL_IDS = [`velopack.${WINDOWS_VELOPACK_ID}`];
export const WINDOWS_TOAST_ACTIVATOR_CLSID =
	BUILD_CHANNEL === 'canary' ? '{9CEDB5C0-3552-43B0-A279-2232E0CDF74C}' : '{48EEF21B-F3AE-431E-8CF2-386FFB2143F2}';
