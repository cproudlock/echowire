// SPDX-License-Identifier: AGPL-3.0-or-later

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Echowire: a client that is already installed keeps fetching the asset paths it was built
// with. So an upstream change that moves an asset from network-fetched to bundle-included is
// correct for clients built after it and broken for every client in the field, and the repo's
// own gates cannot see it, because the stale client is not in the tree.
//
// Upstream #3087 did exactly that with the DeepFilterNet3 wasm and model: it bundled them in
// the app and deleted fluxer_static/libs. Desktop stable 2026.825.12857 (25 August 2026) was
// built before #3087 and requests them from the static host by absolute path, so deploying
// that deletion would have silently killed DeepFilter noise suppression for every desktop
// user on stable. A browser self-heals on reload; a desktop install does not.
//
// This file turns that from invisible into a red gate, in two parts.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const STATIC_ROOT = join(REPO_ROOT, 'fluxer_static');
const VOICE_ROOT = join(REPO_ROOT, 'fluxer_app', 'src', 'features', 'voice');

/**
 * Part two cannot be derived from this repository, and that is the point: the paths an
 * installed client requests live in that client's bundle, not here. So they are enumerated,
 * each with the reason it is still required and the condition that retires it.
 *
 * Add a row when an upstream change stops the current app from fetching an asset the previous
 * app fetched. Delete a row only when every desktop build still in support bundles that asset
 * itself, which means checking the published desktop stable version, not the repo.
 */
const PATHS_DEPLOYED_CLIENTS_STILL_FETCH: ReadonlyArray<{
	readonly path: string;
	readonly fetchedBy: string;
	readonly retiredWhen: string;
}> = [
	{
		path: 'libs/deepfilternet3/v2/pkg/df_bg.wasm',
		fetchedBy: 'desktop stable 2026.825.12857 and any build before upstream #3087',
		retiredWhen: 'desktop stable ships a renderer that bundles the DeepFilterNet3 wasm',
	},
	{
		path: 'libs/deepfilternet3/v2/models/DeepFilterNet3_onnx.tar.gz',
		fetchedBy: 'desktop stable 2026.825.12857 and any build before upstream #3087',
		retiredWhen: 'desktop stable ships a renderer that bundles the DeepFilterNet3 model',
	},
	{
		path: 'libs/deepfilternet3/v3/pkg/df_bg.wasm',
		fetchedBy: 'desktop stable 2026.825.12857 and any build before upstream #3087',
		retiredWhen: 'desktop stable ships a renderer that bundles the DeepFilterNet3 wasm',
	},
	{
		path: 'libs/deepfilternet3/v3/models/DeepFilterNet3_onnx.tar.gz',
		fetchedBy: 'desktop stable 2026.825.12857 and any build before upstream #3087',
		retiredWhen: 'desktop stable ships a renderer that bundles the DeepFilterNet3 model',
	},
];

/** Every path prefix the current voice code builds on top of the static CDN endpoint. */
const STATIC_CDN_TEMPLATE = /staticCdnEndpoint\}(\/[A-Za-z0-9._\-/]*)/g;

function sourceFiles(root: string): Array<string> {
	if (!existsSync(root)) return [];
	const out: Array<string> = [];
	for (const name of readdirSync(root)) {
		const full = join(root, name);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
			continue;
		}
		if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
	}
	return out;
}

describe('the static asset contract with clients already in the field', () => {
	it('serves every path a deployed, still-supported client fetches', () => {
		const missing = PATHS_DEPLOYED_CLIENTS_STILL_FETCH.filter(
			(entry) => !existsSync(join(STATIC_ROOT, entry.path)),
		).map((entry) => `${entry.path} (fetched by ${entry.fetchedBy}; retires when ${entry.retiredWhen})`);

		// If this fails after a merge, an upstream commit deleted an asset that installed
		// clients still request. Restore it rather than deleting the row: the row is retired
		// by the published desktop build catching up, not by the repo no longer needing it.
		expect(missing).toEqual([]);
	});

	it('serves every static path the current voice code constructs', () => {
		const constructed = new Map<string, string>();
		for (const file of sourceFiles(VOICE_ROOT)) {
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(STATIC_CDN_TEMPLATE)) {
				const path = match[1].replace(/^\/+/, '');
				if (path) constructed.set(path, relative(REPO_ROOT, file));
			}
		}

		const unserved = [...constructed.entries()]
			.filter(([path]) => !existsSync(join(STATIC_ROOT, path)))
			.map(([path, file]) => `${path} (built in ${file})`)
			.sort();

		// Derived, so it needs no maintenance: it catches a new network-fetched asset being
		// added without the file, which is the same hazard pointing the other way.
		//
		// Note what this currently measures: since #3087 the voice code constructs no static
		// CDN paths at all, so `constructed` is empty and this assertion compares [] to [].
		// That is one step from a check that cannot go red, so it was mutation-checked rather
		// than trusted: adding one unserved `${RuntimeConfig.staticCdnEndpoint}/...` path to
		// the voice tree turns it red and names the file. It is kept for the re-introduction
		// case, which is when it starts measuring something again.
		expect(unserved).toEqual([]);
	});

	it('keeps the in-bundle copy as well, since current clients use that one', () => {
		const bundled = join(VOICE_ROOT, 'utils', 'noise_suppression', 'deepfilternet3');
		expect(existsSync(join(bundled, 'df_bg.wasm'))).toBe(true);
		expect(existsSync(join(bundled, 'DeepFilterNet3_onnx.tar.gz'))).toBe(true);
	});

	it('copies the served tree into the static image', () => {
		const dockerfile = readFileSync(join(STATIC_ROOT, 'Dockerfile'), 'utf8');
		// Restoring the files without restoring the COPY would pass the checks above and still
		// ship an image that 404s, so assert the build step too.
		expect(dockerfile).toContain('fluxer_static/libs /srv/fluxer-static/libs');
	});
});
