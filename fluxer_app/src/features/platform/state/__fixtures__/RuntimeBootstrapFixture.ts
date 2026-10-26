// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstanceAppPublic} from '@fluxer/instance_bootstrap/src/Types';

export const BOOTSTRAP_APP_PUBLIC: InstanceAppPublic = {
	branding: {
		product_name: 'Fluxer',
		icon_url: null,
		symbol_url: null,
		logo_url: null,
		wordmark_url: null,
		favicon_url: null,
		theme_color: null,
		status_page_url: null,
		status_page_incident_history_url: null,
		premium_product_name: 'Plutonium',
		premium_info_url: null,
		favicon_dark_url: null,
		sign_in_backdrop_url: null,
		custom_css: null,
		trusted_domains: [],
		upload_limit_message: null,
	},
	setup: {configured: true, admin_url: null},
	legal: {terms_url: null, privacy_url: null, guidelines_url: null},
	registration: {collect_date_of_birth: true},
};
