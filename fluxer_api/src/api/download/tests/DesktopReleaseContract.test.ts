// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseDesktopReleaseDescriptor} from '@app/api/download/DesktopReleaseContract';
import {describe, expect, it} from 'vitest';

// Echowire: fixtures follow what tools/ci/src/release.rs serializes for each schema version,
// with the names its sample descriptor uses.
const CHANNEL = 'canary';
const VERSION = '2026.913.210037';
const PRODUCT = 'echowire-canary';
const SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';
const RELEASE_PREFIX = `${PRODUCT}-${VERSION}`;
const PLATFORM_TOKENS = {win32: 'win', darwin: 'mac', linux: 'linux'} as const;
const COORDINATES = (['win32', 'darwin', 'linux'] as const).flatMap((platform) =>
	(['x64', 'arm64'] as const).map((arch) => ({platform, arch})),
);

interface ReleaseEntry {
	storage_key: string;
	release_asset: string;
	sha256: string;
	size: number;
}

function hexSha256(ordinal: number): string {
	return ordinal.toString(16).padStart(64, '0');
}

function storageFilenames(platform: keyof typeof PLATFORM_TOKENS, arch: string): Array<string> {
	if (platform === 'win32') {
		return [
			`${RELEASE_PREFIX}-portable-win-${arch}.zip`,
			`${RELEASE_PREFIX}-win-${arch}.exe`,
			'RELEASES',
			'releases.win.json',
			'assets.win.json',
			`${RELEASE_PREFIX}-win-${arch}-full.nupkg`,
		];
	}
	if (platform === 'darwin') {
		return [
			`${RELEASE_PREFIX}-mac-universal.dmg`,
			`${RELEASE_PREFIX}-mac-universal.zip`,
			'RELEASES.json',
			'releases.json',
		];
	}
	return ['AppImage', 'deb', 'rpm', 'tar.gz'].map((extension) => `${RELEASE_PREFIX}-linux-${arch}.${extension}`);
}

function shellAssets(): Array<ReleaseEntry> {
	const contents = new Map<string, {sha256: string; size: number}>();
	const assets: Array<ReleaseEntry> = [];
	for (const {platform, arch} of COORDINATES) {
		for (const filename of storageFilenames(platform, arch)) {
			const basename = platform === 'darwin' && filename.toLowerCase() === 'releases.json' ? 'releases.json' : filename;
			const releaseAsset = filename.startsWith(`${RELEASE_PREFIX}-`)
				? filename
				: `${RELEASE_PREFIX}-${PLATFORM_TOKENS[platform]}-${arch}-${basename}`;
			const ordinal = contents.size + 1;
			const content = contents.get(releaseAsset) ?? {sha256: hexSha256(ordinal), size: ordinal * 1024};
			contents.set(releaseAsset, content);
			assets.push({
				storage_key: `desktop/${CHANNEL}/${platform}/${arch}/${filename}`,
				release_asset: releaseAsset,
				...content,
			});
		}
	}
	return assets.sort((left, right) => (left.storage_key < right.storage_key ? -1 : 1));
}

function moduleEntries(): Array<ReleaseEntry> {
	const manifests = COORDINATES.map(({platform, arch}, index) => ({
		storage_key: `desktop/${CHANNEL}/${platform}/${arch}/modules.json`,
		release_asset: `${RELEASE_PREFIX}-${PLATFORM_TOKENS[platform]}-${arch}-modules.json`,
		sha256: hexSha256(500 + index),
		size: 700,
	}));
	const packages = ['fluxer_renderer', 'fluxer_sourcemaps'].map((module, index) => {
		const sha256 = hexSha256(900 + index);
		return {
			storage_key: `desktop/${CHANNEL}/modules/${module}/${sha256}/package.br`,
			release_asset: `${RELEASE_PREFIX}-module-${module}-${sha256}.br`,
			sha256,
			size: 4096,
		};
	});
	return [...manifests, ...packages].sort((left, right) => (left.storage_key < right.storage_key ? -1 : 1));
}

function linuxRepoEntries(): Array<ReleaseEntry> {
	const kinds = [
		['flatpak', 'ostree.tar.zst'],
		['pacman', 'pkg.tar.zst'],
	] as const;
	return kinds.flatMap(([kind, extension], kindIndex) =>
		['aarch64', 'x86_64'].map((machine, machineIndex) => ({
			storage_key: `linux-repo/${CHANNEL}/${kind}/${machine}`,
			release_asset: `${RELEASE_PREFIX}-${kind}-${machine}.${extension}`,
			sha256: hexSha256(1200 + kindIndex * 2 + machineIndex),
			size: 8192,
		})),
	);
}

function header(schemaVersion: number, kind?: string) {
	return {
		schema_version: schemaVersion,
		...(kind === undefined ? {} : {kind}),
		channel: CHANNEL,
		version: VERSION,
		release_tag: `fluxer-desktop-${CHANNEL}@${VERSION}`,
		source_sha: SOURCE_SHA,
	};
}

function schemaOne() {
	return {...header(1), assets: shellAssets()};
}

function schemaTwoFull() {
	return {...header(2), assets: shellAssets(), modules: moduleEntries()};
}

function schemaTwoModulesOnly() {
	return {...header(2, 'modules'), assets: [], modules: moduleEntries()};
}

function schemaThree() {
	return {...header(3), assets: shellAssets(), modules: moduleEntries(), linux_repos: linuxRepoEntries()};
}

function schemaThreeWithoutLinuxRepos() {
	return {...header(3), assets: shellAssets(), modules: moduleEntries()};
}

function parse(descriptor: unknown) {
	const roundTripped: unknown = JSON.parse(JSON.stringify(descriptor));
	return parseDesktopReleaseDescriptor(roundTripped);
}

describe('desktop release descriptor schema versions', () => {
	it.each([
		['schema 1, shell assets only', schemaOne],
		['schema 2, full release with modules', schemaTwoFull],
		['schema 3, full release with modules and linux repos', schemaThree],
		['schema 3, full release that lists no linux repos', schemaThreeWithoutLinuxRepos],
	])('accepts %s', (_name, build) => {
		const descriptor = build();
		expect(parse(descriptor)).toEqual({...header(descriptor.schema_version), assets: shellAssets()});
	});

	it('accepts a schema 2 modules-only release and reports no shell assets', () => {
		expect(parse(schemaTwoModulesOnly())).toEqual({...header(2), assets: []});
	});

	it.each([0, 4, '3', null])('rejects unknown schema version %j', (schemaVersion) => {
		expect(parse({...schemaThree(), schema_version: schemaVersion})).toBeNull();
	});

	it('rejects a modules-only descriptor on any schema but 2', () => {
		expect(parse({...schemaTwoModulesOnly(), schema_version: 3})).toBeNull();
	});

	it('rejects a modules-only descriptor that lists shell assets or no modules', () => {
		expect(parse({...schemaTwoModulesOnly(), assets: shellAssets()})).toBeNull();
		expect(parse({...schemaTwoModulesOnly(), modules: []})).toBeNull();
	});

	it('rejects an unknown release kind', () => {
		expect(parse({...schemaThree(), kind: 'shell'})).toBeNull();
	});

	it('rejects sections a schema version does not have', () => {
		expect(parse({...schemaOne(), modules: moduleEntries()})).toBeNull();
		expect(parse({...schemaTwoFull(), linux_repos: linuxRepoEntries()})).toBeNull();
	});

	it('rejects a malformed modules or linux repos section', () => {
		const [firstModule, ...otherModules] = moduleEntries();
		expect(parse({...schemaThree(), modules: {}})).toBeNull();
		expect(parse({...schemaThree(), modules: [{...firstModule, sha256: 'ABC'}, ...otherModules]})).toBeNull();
		expect(parse({...schemaThree(), modules: [{...firstModule, size: 0}, ...otherModules]})).toBeNull();
		expect(parse({...schemaThree(), linux_repos: null})).toBeNull();
		expect(
			parse({...schemaThree(), linux_repos: [{...linuxRepoEntries()[0], storage_key: 'desktop/canary/flatpak'}]}),
		).toBeNull();
	});

	it('still requires the full shell route inventory on schema 3', () => {
		const assets = shellAssets().filter((asset) => !asset.storage_key.endsWith('.rpm'));
		expect(parse({...schemaThree(), assets})).toBeNull();
	});
});
