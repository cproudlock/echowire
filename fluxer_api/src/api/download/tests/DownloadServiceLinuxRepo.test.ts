// SPDX-License-Identifier: AGPL-3.0-or-later

import {DownloadService, downloadCacheControlForKey} from '@app/api/download/DownloadService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {describe, expect, it} from 'vitest';

const OBJECT_KEYS = [
	'apt/dists/stable/InRelease',
	'apt/dists/stable/Release',
	'apt/dists/stable/Release.gpg',
	'apt/dists/stable/main/binary-amd64/Packages',
	'apt/pool/main/e/echowire/echowire_2026.825.12857_amd64.deb',
	'rpm/stable/x86_64/repodata/repomd.xml',
	'rpm/stable/x86_64/echowire-2026.825.12857-1.x86_64.rpm',
	'desktop/stable/linux/x64/manifest.json',
];

function createService() {
	const storageService = {
		getObjectMetadata: async (_bucket: string, key: string) =>
			OBJECT_KEYS.includes(key) ? {contentLength: 1, contentType: 'application/octet-stream'} : null,
	} as unknown as IStorageService;
	return new DownloadService(storageService);
}

describe('linux repository download keys', () => {
	it('resolves apt repository metadata and pool paths', async () => {
		const service = createService();
		for (const key of OBJECT_KEYS.filter((candidate) => candidate.startsWith('apt/'))) {
			expect(await service.resolveDownloadKey({path: `/dl/${key}`})).toBe(key);
		}
	});

	it('resolves rpm repository metadata and package paths', async () => {
		const service = createService();
		for (const key of OBJECT_KEYS.filter((candidate) => candidate.startsWith('rpm/'))) {
			expect(await service.resolveDownloadKey({path: `/dl/${key}`})).toBe(key);
		}
	});

	it('still rejects prefixes outside the allow list', async () => {
		const service = createService();
		for (const path of [
			'/dl/config/secrets.json',
			'/dl/attachments/1/2/3.png',
			'/dl/aptitude/dists/stable/Release',
			'/dl/rpmfusion/repodata/repomd.xml',
		]) {
			expect(await service.resolveDownloadKey({path})).toBeNull();
		}
	});

	it('rejects traversal out of a repository prefix', async () => {
		const service = createService();
		for (const path of [
			'/dl/apt/../config/secrets.json',
			'/dl/apt/dists/../../desktop-test/stable/linux/x64/manifest.json',
			'/dl/rpm/./stable/../../../etc/passwd',
		]) {
			expect(await service.resolveDownloadKey({path})).toBeNull();
		}
	});

	it('does not divert repository keys to the test bucket', async () => {
		const service = createService();
		expect(await service.resolveDownloadKey({path: '/dl/apt/dists/stable/InRelease', test: true})).toBe(
			'apt/dists/stable/InRelease',
		);
	});

	it('caches repository indexes briefly and repository packages forever', () => {
		expect(downloadCacheControlForKey('apt/dists/stable/InRelease')).toBe('public, max-age=60');
		expect(downloadCacheControlForKey('apt/dists/stable/main/binary-amd64/Packages')).toBe('public, max-age=60');
		expect(downloadCacheControlForKey('rpm/stable/x86_64/repodata/repomd.xml')).toBe('public, max-age=60');
		expect(downloadCacheControlForKey('apt/pool/main/e/echowire/echowire_2026.825.12857_amd64.deb')).toBe(
			'public, max-age=31536000',
		);
		expect(downloadCacheControlForKey('rpm/stable/x86_64/echowire-2026.825.12857-1.x86_64.rpm')).toBe(
			'public, max-age=31536000',
		);
	});
});
