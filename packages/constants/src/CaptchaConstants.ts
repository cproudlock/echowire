// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ValueOf} from '@fluxer/constants/src/ValueOf';

export const CaptchaProviders = {
	NONE: 'none',
	ALTCHA: 'altcha',
	// Echowire: upstream #3035 narrowed this to none or altcha. This fork keeps hcaptcha and
	// turnstile, which the mobile clients already on the stores implement and ALTCHA is not a
	// substitute for. See docs/adr/0008.
	HCAPTCHA: 'hcaptcha',
	TURNSTILE: 'turnstile',
} as const;

export type CaptchaProvider = ValueOf<typeof CaptchaProviders>;
