// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Echowire: this file has leaked before. On 2026-09-07 the two IP-ban messages were found
// showing "Fluxer API" and support@fluxer.app, and the fix corrected the English source and
// left all 33 translations saying it, so the leak kept rendering in every locale but English
// for weeks. Nothing caught that, because the merge rules only said to grep and nobody greps
// a translation they did not write.
//
// Two properties, deliberately separate from the fluxer_app brand gate rather than folded
// into it, because what leaks here is different in kind:
//
//   - these strings are translator-facing as well as rendered. A translator reading
//     messages.json copies whatever contact address it shows into 33 languages, which is how
//     one wrong address becomes 33.
//   - the leak is usually a *contact point*, not the brand word. "support@fluxer.app" does
//     not contain /\bFluxer\b/, so a brand-word check passes straight over it. Addresses and
//     domains are what this asserts first.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEBLATE = join(HERE, '..', 'i18n', 'weblate');
const SOURCE = join(WEBLATE, 'messages.json');
const LOCALES = join(WEBLATE, 'locales');

/** Upstream contact points. A leak here sends a real user to a host we do not run. */
const UPSTREAM_CONTACT = /(?:[\w.+-]+@)?fluxer\.(?:app|com|dev|tools)\b/i;
/** Upstream product names in rendered text. */
const UPSTREAM_BRAND = /\b(?:Fluxer|Plutonium|Neko)\b/;

function values(path: string): Record<string, string> {
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
	if (!parsed || typeof parsed !== 'object') throw new Error(`${path} is not an object`);
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		),
	);
}

function catalogs(): Array<{readonly name: string; readonly entries: Record<string, string>}> {
	const out = [{name: 'messages.json', entries: values(SOURCE)}];
	for (const name of readdirSync(LOCALES)) {
		if (!name.endsWith('.json')) continue;
		out.push({name: `locales/${name}`, entries: values(join(LOCALES, name))});
	}
	return out;
}

describe('the error catalogs never point at upstream', () => {
	it('names no upstream contact address or domain, in the source or any translation', () => {
		const leaks: Array<string> = [];
		let filesScanned = 0;
		let valuesScanned = 0;

		for (const {name, entries} of catalogs()) {
			filesScanned += 1;
			for (const [key, value] of Object.entries(entries)) {
				valuesScanned += 1;
				const found = UPSTREAM_CONTACT.exec(value);
				if (found) leaks.push(`${name} ${key}: ${found[0]}`);
			}
		}

		// Coverage, asserted rather than assumed. The loop skips a non-JSON entry, which is
		// correct for a stray file and is also exactly how a sweep decays into a check that
		// cannot fail, so state how much was swept and fail if it collapses.
		expect(filesScanned).toBe(34);
		expect(valuesScanned).toBeGreaterThan(15_000);

		// If this fails, a message sends users to a host this fork does not run. Fix the
		// English source AND every translation: correcting only the source is what happened
		// on 2026-09-07 and it left the leak rendering in 33 languages.
		expect(leaks.sort()).toEqual([]);
	});

	it('names no upstream product, in the source or any translation', () => {
		const leaks: Array<string> = [];
		for (const {name, entries} of catalogs()) {
			for (const [key, value] of Object.entries(entries)) {
				if (UPSTREAM_BRAND.test(value)) leaks.push(`${name} ${key}: ${value.slice(0, 80)}`);
			}
		}
		expect(leaks.sort()).toEqual([]);
	});

	it('hardcodes no upstream contact point anywhere in the package', () => {
		// Leak five on 2026-10-03 was `const SUPPORT_EMAIL = 'support@fluxer.app'` in
		// IpBannedError.ts, interpolated into a message at runtime. No catalog assertion can
		// see that, because the leak sits upstream of the catalog, so sweep the source too.
		const root = join(HERE, '..');
		const leaks: Array<string> = [];
		let filesScanned = 0;

		const walk = (dir: string): void => {
			for (const name of readdirSync(dir, {withFileTypes: true})) {
				const full = join(dir, name.name);
				if (name.isDirectory()) {
					if (name.name === 'weblate' || name.name === 'locales') continue; // asserted above
					walk(full);
					continue;
				}
				if (!/\.ts$/.test(name.name)) continue;
				// This file names the addresses it exists to forbid.
				if (name.name === 'WeblateBrand.test.ts') continue;
				filesScanned += 1;
				const text = readFileSync(full, 'utf8');
				for (const line of text.split('\n')) {
					// Comments may cite upstream's address to explain the divergence.
					if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
					const found = UPSTREAM_CONTACT.exec(line);
					if (found) leaks.push(`${name.name}: ${found[0]}`);
				}
			}
		};
		walk(root);

		expect(filesScanned).toBeGreaterThan(50);
		expect(leaks.sort()).toEqual([]);
	});

	it('keeps every translation keyed to a source message', () => {
		// A key that exists only in a translation is a string no source review ever sees, which
		// is where a leak can sit indefinitely. Upstream's own tooling should prevent it; this
		// says so out loud.
		const source = new Set(Object.keys(values(SOURCE)));
		const orphans: Array<string> = [];
		for (const {name, entries} of catalogs()) {
			if (name === 'messages.json') continue;
			for (const key of Object.keys(entries)) {
				if (!source.has(key)) orphans.push(`${name} ${key}`);
			}
		}
		expect(orphans.sort()).toEqual([]);
	});
});
