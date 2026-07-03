// SPDX-License-Identifier: AGPL-3.0-or-later

export const ExternalUrls = {
	// Echowire: status page (was fluxerstatus.com / Instatus). status.echowire.org
	// is served by Uptime Kuma on the edge. NOTE: the in-app incident banner fetches
	// {SERVICE_STATUS}/summary.json + /components.json (Instatus format); Uptime Kuma
	// doesn't serve those, so the banner degrades gracefully (no incidents shown) —
	// point this at an Instatus page if full in-app incident history is wanted.
	SERVICE_STATUS: 'https://status.echowire.org',
	BLUESKY: 'https://bsky.app/profile/echowire.org',
} as const;
