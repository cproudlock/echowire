// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the URL schemes the apps answer to. echowire:// is ours. fluxer:// stays accepted
// everywhere so a link from another instance (federation, or a page written for the upstream app)
// still opens here. Links carry no instance: the app resolves them against the instance it is
// connected to, so both schemes mean the same thing. See docs/adr/0011-echowire-url-scheme.md.
//
// fluxer_desktop/src/common/Constants.ts keeps its own copy of this list, because the Electron main
// process does not import from the workspace packages. Change both together.
export const APP_PROTOCOLS = ['echowire', 'fluxer'] as const;

export type AppProtocolName = (typeof APP_PROTOCOLS)[number];

// "echowire:" and "fluxer:", the form URL.protocol reports.
export const APP_PROTOCOL_SCHEMES: ReadonlyArray<string> = APP_PROTOCOLS.map((name) => `${name}:`);

// Whether a URL.protocol value (any case) is one of ours.
export function isAppProtocolScheme(protocol: string): boolean {
	return APP_PROTOCOL_SCHEMES.includes(protocol.toLowerCase());
}

// The length of the app scheme ("echowire:" or "fluxer:") that `text` carries at `index`, or 0.
// Case sensitive, like the markdown parsers that call it.
export function appProtocolSchemeLengthAt(text: string, index = 0): number {
	for (const scheme of APP_PROTOCOL_SCHEMES) {
		if (text.startsWith(scheme, index)) {
			return scheme.length;
		}
	}
	return 0;
}
