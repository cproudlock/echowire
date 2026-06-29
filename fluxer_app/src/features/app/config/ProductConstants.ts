// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire branding. PRODUCT_NAME is instance-config driven (branding.product_name); the fallback
// is "Echowire" so the app brands correctly even before/without instance config. Premium tier is
// "Reverb" (was upstream "Plutonium").
function getBootstrapProductName(): string {
	if (typeof window === 'undefined') {
		return 'Echowire';
	}
	const productName = window.__FLUXER_BOOTSTRAP__?.instance.app_public?.branding?.product_name?.trim();
	return productName || 'Echowire';
}

export const PRODUCT_NAME = getBootstrapProductName();
export const PREMIUM_PRODUCT_NAME = 'Reverb';
export const PREMIUM_PRODUCT_FULL_NAME = `${PRODUCT_NAME} ${PREMIUM_PRODUCT_NAME}`;
