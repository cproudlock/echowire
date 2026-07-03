// SPDX-License-Identifier: AGPL-3.0-or-later

export const ExternalUrls = {
	// Echowire: Instatus status page (https://echowire.instatus.com — free tier, so no
	// custom domain). The in-app incident banner + splash fetch {SERVICE_STATUS}/summary.json
	// + /components.json (Instatus format), which this page serves natively. Monitors: Web
	// App, API, Realtime Gateway, Voice ORD/EWR/ATL, Help. Managed via the Instatus API
	// (key in repo-root .secrets as INSTATUS_API_KEY).
	SERVICE_STATUS: 'https://echowire.instatus.com',
	BLUESKY: 'https://bsky.app/profile/echowire.org',
} as const;
