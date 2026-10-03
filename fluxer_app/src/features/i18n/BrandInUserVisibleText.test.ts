// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Echowire: the fork's merge rules say to grep for upstream brand names after every merge,
// and on 2026-10-03 that grep found three user-visible strings naming Fluxer that had been
// shipping for an unknown number of merges. A rule that depends on remembering to grep is a
// reviewer's memory, so this is the grep, run as a gate.
//
// Display positions only. Translator `comment:` fields legitimately say "productName is
// Fluxer" to explain a placeholder to a translator, identifiers are named after upstream's
// components on purpose, and `@fluxer/*` package specifiers are the real package names.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP_SRC = join(HERE, '..', '..');
const REPO_ROOT = join(APP_SRC, '..', '..');

/** A Lingui descriptor body: `message: '...'`, which is what a user reads. */
const MESSAGE_BODY = /message:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;
/** A t`...` template, the other way a user-visible string is written here. */
const T_TEMPLATE = /\bt`((?:\\.|[^`\\])*)`/gs;

const UPSTREAM_BRANDS = /\b(Fluxer|Plutonium|Neko)\b/;

/**
 * Upstream hostnames and the addresses at them, as a pattern separate from the brand words.
 * A lowercase host never matches the brand pattern above, which is exactly why
 * support@fluxer.app, weblate.fluxer.tools, fluxer.dev, irc.fluxer.com and @fluxer.app sat
 * in this app's own constants through every previous brand sweep, three of them as live
 * links sending our users to upstream's property.
 *
 * Deliberately no \b in it. The 2026-10-03 catalog work established that word-boundary
 * assumptions betray you in this kind of check, and a dotted host is the clearest case: a
 * boundary falls between a letter and a dot, so a trailing \b would reject "fluxer.app"
 * inside "fluxer.app/download" precisely when it matters most.
 */
const UPSTREAM_HOST = /(?:[A-Za-z0-9._+-]*@)?(?:[A-Za-z0-9-]+\.)*fluxer\.(?:app|com|dev|tools)/i;

/**
 * Deliberate exceptions, each with the reason it is not a leak. Keep this list at zero
 * growth: a new entry means a new upstream brand name is on screen, which needs a decision
 * rather than an entry.
 */
const ALLOWED: ReadonlyArray<{readonly text: string; readonly why: string}> = [
	{
		text: 'Neko',
		why: 'settings-search synonym kept on purpose so searching the upstream name still finds Pickles; documented in AGENTS.md',
	},
];

function sourceFiles(root: string): Array<string> {
	const out: Array<string> = [];
	for (const name of readdirSync(root)) {
		const full = join(root, name);
		if (statSync(full).isDirectory()) {
			// The catalogs hold the translated copies, not the source of truth.
			if (name === 'locales') continue;
			out.push(...sourceFiles(full));
			continue;
		}
		if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
	}
	return out;
}

describe('user-visible text never names the upstream brand', () => {
	it('has no unapproved upstream brand name in any display string', () => {
		const allowed = new Set(ALLOWED.map((entry) => entry.text));
		const leaks: Array<string> = [];

		for (const file of sourceFiles(APP_SRC)) {
			const text = readFileSync(file, 'utf8');
			if (!UPSTREAM_BRANDS.test(text)) continue;
			const where = relative(REPO_ROOT, file).split('\\').join('/');
			for (const pattern of [MESSAGE_BODY, T_TEMPLATE]) {
				pattern.lastIndex = 0;
				for (const match of text.matchAll(pattern)) {
					const body = (match[2] ?? match[1]).trim();
					if (!UPSTREAM_BRANDS.test(body) || allowed.has(body)) continue;
					leaks.push(`${where}: ${body.slice(0, 120)}`);
				}
			}
		}

		// If this fails, a display string names upstream's product. Interpolate the product
		// name instead, the way dozens of strings here already do: {productName} from
		// PRODUCT_NAME, or {premiumProductName} from PREMIUM_PRODUCT_NAME. Do not add an
		// ALLOWED entry to make it pass, and do not hard-code "echowire" either, because the
		// brand is instance-config driven and the catalogs should not carry it.
		expect(leaks.sort()).toEqual([]);
	});

	it('never capitalises the brand in display text', () => {
		// The brand rule: lowercase echowire everywhere a user reads it, including at the start
		// of a sentence. Reverb and EchoTag keep their casing, and identifiers, env names and
		// `org.echowire.*` ids are not display text, which is why this looks only at message
		// bodies and t`...` templates.
		const leaks: Array<string> = [];
		for (const file of sourceFiles(APP_SRC)) {
			const text = readFileSync(file, 'utf8');
			if (!text.includes('Echowire')) continue;
			const where = relative(REPO_ROOT, file).split('\\').join('/');
			for (const pattern of [MESSAGE_BODY, T_TEMPLATE]) {
				pattern.lastIndex = 0;
				for (const match of text.matchAll(pattern)) {
					const body = (match[2] ?? match[1]).trim();
					if (/\bEchowire\b/.test(body)) leaks.push(`${where}: ${body.slice(0, 120)}`);
				}
			}
		}
		expect(leaks.sort()).toEqual([]);
	});

	it('has no fork-renamed string translated back to the upstream name', () => {
		// The .po procedure's step 6, asked per entry rather than per file. Counting
		// occurrences of /\bNeko\b/ across a catalog gives a false positive, because it also
		// matches Croatian and Bosnian words; the real question is whether a *Pickles* msgid
		// has a *Neko* value, which only makes sense entry by entry.
		const RENAMES: ReadonlyArray<readonly [string, string]> = [
			['Pickles', 'Neko'],
			['Reverb', 'Plutonium'],
			['EchoTag', 'FluxerTag'],
			['echowire', 'Fluxer'],
		];
		const localesDir = join(APP_SRC, 'features', 'i18n', 'locales');
		const leaks: Array<string> = [];
		let catalogsScanned = 0;
		let entriesScanned = 0;

		for (const locale of readdirSync(localesDir)) {
			const catalog = join(localesDir, locale, 'messages.po');
			if (!statSync(localesDir).isDirectory()) continue;
			let text: string;
			try {
				text = readFileSync(catalog, 'utf8');
			} catch {
				continue; // not a locale directory
			}
			catalogsScanned += 1;
			for (const block of text.split('\n\n').slice(1)) {
				const id = /^msgid "((?:\\.|[^"\\])*)"/m.exec(block)?.[1];
				const value = /^msgstr "((?:\\.|[^"\\])*)"/m.exec(block)?.[1];
				if (!id || !value) continue;
				entriesScanned += 1;
				for (const [fork, upstream] of RENAMES) {
					const forkInId = new RegExp(`\\b${fork}\\b`).test(id);
					const upstreamInValue = new RegExp(`\\b${upstream}\\b`).test(value);
					// The one deliberate exception: msgid "Fluxer" is itself translated to the
					// fork brand, so it is the inverse of a leak rather than one.
					if (forkInId && upstreamInValue && id !== upstream) {
						leaks.push(`${locale}: ${id.slice(0, 60)} -> ${value.slice(0, 60)}`);
					}
				}
			}
		}
		// Say how much was looked at, so a broken walk fails here instead of reporting a
		// clean sweep of nothing. 34 locales is the shipped set; raise this when one is added.
		expect(catalogsScanned).toBe(34);
		expect(entriesScanned).toBeGreaterThan(200_000);
		expect(leaks.sort()).toEqual([]);
	});

	it('puts no upstream host in a display string', () => {
		// A host never matches the brand pattern above, which is why support@fluxer.app and
		// weblate.fluxer.tools survived every brand sweep before this one.
		const leaks: Array<string> = [];
		for (const file of sourceFiles(APP_SRC)) {
			const text = readFileSync(file, 'utf8');
			if (!/fluxer\./i.test(text)) continue;
			const where = relative(REPO_ROOT, file).split('\\').join('/');
			for (const pattern of [MESSAGE_BODY, T_TEMPLATE]) {
				pattern.lastIndex = 0;
				for (const match of text.matchAll(pattern)) {
					const body = (match[2] ?? match[1]).trim();
					const found = UPSTREAM_HOST.exec(body);
					if (found) leaks.push(`${where}: ${found[0]}`);
				}
			}
		}
		expect(leaks.sort()).toEqual([]);
	});

	it('points no user-facing constant at an upstream host', () => {
		// Every one of the six leaks found on 2026-10-03 lived in this one file: SUPPORT_EMAIL,
		// I18N_EMAIL, I18N_WEBLATE_DOMAIN, FLUXER_DOCS_DOMAIN, FLUXER_BLUESKY_HANDLE and
		// SPLASH_IRC_SERVER. It is the file of user-facing constants by definition, so it is the
		// right place to assert, and narrow enough that no exception list is needed.
		//
		// Deliberately NOT asserted over the whole app: the link-recognition allowlists in
		// InviteUtils, GiftCodeUtils, DeepLinkUtils, ThemeUtils, WorkerAssetUrl, Updater and
		// DomainMigrationCore hold upstream hosts in order to recognise URLs a user pastes, and
		// deleting those breaks link handling instead of fixing a leak. TrustedDomain's
		// BUILT_IN_TRUST_PATTERNS is a separate open question, since it auto-trusts upstream's
		// domains for link navigation and names none of ours.
		const constants = join(APP_SRC, 'features', 'app', 'config', 'I18nDisplayConstants.ts');
		const leaks: Array<string> = [];
		let linesScanned = 0;
		for (const [index, line] of readFileSync(constants, 'utf8').split('\n').entries()) {
			linesScanned += 1;
			// A comment may cite upstream's host to record what the divergence replaced.
			if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
			const found = UPSTREAM_HOST.exec(line);
			if (found) leaks.push(`I18nDisplayConstants.ts:${index + 1}: ${found[0]}`);
		}

		// Coverage, asserted: this file existing but being empty would otherwise pass.
		expect(linesScanned).toBeGreaterThan(80);

		// If this fails, a user-facing constant points at a host this fork does not run.
		// Repoint it at an address already established here, or remove the affordance it feeds.
		expect(leaks.sort()).toEqual([]);
	});

	it('keeps the brand out of the catalogs entirely', () => {
		// The placeholder approach only pays off if no msgid carries the brand, since a msgid
		// is what a translator sees and what a keep-theirs resolution would restore.
		const enUs = join(APP_SRC, 'features', 'i18n', 'locales', 'en-US', 'messages.po');
		const msgids = readFileSync(enUs, 'utf8')
			.split('\n\n')
			.slice(1)
			.map((block) => /^msgid "((?:\\.|[^"\\])*)"/m.exec(block)?.[1])
			.filter((id): id is string => Boolean(id));

		const allowed = new Set(ALLOWED.map((entry) => entry.text));
		expect(msgids.filter((id) => UPSTREAM_BRANDS.test(id) && !allowed.has(id)).sort()).toEqual([]);
	});
});
