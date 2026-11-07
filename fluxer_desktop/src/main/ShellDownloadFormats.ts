// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL, type BuildChannel} from '@electron/common/BuildChannel';

type DesktopDownloadArch = 'x64' | 'arm64';

function getDesktopDownloadArch(arch: NodeJS.Architecture): DesktopDownloadArch {
	return arch === 'arm64' ? 'arm64' : 'x64';
}

const DESKTOP_DOWNLOAD_ARCH = getDesktopDownloadArch(process.arch);
const PACKAGE_ORIGIN_ENV = 'FLUXER_DESKTOP_PACKAGE_ORIGIN';
// Echowire serves the API (and its /dl download routes) behind the /api path on the main domain,
// with no separate api. subdomain. The edge Caddy strips /api and the DownloadController serves /dl
// at the api root, and the API generates binary URLs under this same base, so the origin must end
// in /api/dl. Canary uses its own host for the update feed.
const CHANNEL_PACKAGE_ORIGINS: Record<BuildChannel, string> = {
	stable: 'https://echowire.org/api/dl',
	canary: 'https://canary.echowire.org/api/dl',
	development: 'http://127.0.0.1:48780',
};

export const DESKTOP_PACKAGE_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isUsablePackageOrigin(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return url.protocol === 'https:' || (url.protocol === 'http:' && DESKTOP_PACKAGE_LOOPBACK_HOSTS.has(url.hostname));
}

export function resolveDesktopPackageOrigin(): string {
	const override = process.env?.[PACKAGE_ORIGIN_ENV];
	const trimmed = override?.trim() ?? '';
	if (trimmed.length === 0 || !isUsablePackageOrigin(trimmed)) {
		return CHANNEL_PACKAGE_ORIGINS[BUILD_CHANNEL];
	}
	return trimmed.replace(/\/+$/u, '');
}

export function getUpdateBaseUrl(platform: NodeJS.Platform = process.platform): string {
	// Echowire: Windows ships build variants; the feed is scoped per variant. DESKTOP_BUILD_VARIANT
	// is substituted by esbuild define in scripts/build.mjs; the typeof guard keeps unbundled
	// loads (tests, tooling) on the default variant instead of throwing a ReferenceError.
	const variant = typeof DESKTOP_BUILD_VARIANT === 'string' ? DESKTOP_BUILD_VARIANT : 'default';
	const variantSegment = platform === 'win32' && variant !== 'default' ? `/${variant}` : '';
	return `${resolveDesktopPackageOrigin()}/desktop/${BUILD_CHANNEL}/${platform}/${DESKTOP_DOWNLOAD_ARCH}${variantSegment}`;
}

export const MANUAL_DESKTOP_FORMATS = ['setup', 'dmg', 'zip', 'appimage', 'deb', 'rpm', 'tar_gz'] as const;

export type ManualDesktopFormat = (typeof MANUAL_DESKTOP_FORMATS)[number];
