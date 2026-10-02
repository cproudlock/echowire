// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire branding. PRODUCT_NAME is instance-config driven (branding.product_name); the fallback
// is "echowire" (the brand is all lowercase) so the app brands correctly even before/without instance config. Premium tier is
// "Reverb" (was upstream "Plutonium").
function getBootstrapProductName(): string {
	if (typeof window === 'undefined') {
		return 'echowire';
	}
	const productName = window.__FLUXER_BOOTSTRAP__?.instance.app_public?.branding?.product_name?.trim();
	return productName || 'echowire';
}

function getBootstrapPremiumProductName(): string {
	if (typeof window === 'undefined') {
		return 'Reverb';
	}
	const premiumProductName = window.__FLUXER_BOOTSTRAP__?.instance.app_public?.branding?.premium_product_name?.trim();
	return premiumProductName || 'Reverb';
}

export const PRODUCT_NAME = getBootstrapProductName();
export const PREMIUM_PRODUCT_NAME = getBootstrapPremiumProductName();
export const PREMIUM_PRODUCT_FULL_NAME = `${PRODUCT_NAME} ${PREMIUM_PRODUCT_NAME}`;
