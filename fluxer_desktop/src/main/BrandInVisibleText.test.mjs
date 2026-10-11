import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// Echowire: the update splash shipped saying "Updating Fluxer..." with the Fluxer logo because the
// repo's brand guard (fluxer_app BrandInUserVisibleText.test.ts) only reads fluxer_app's Lingui
// messages. The desktop shell writes plain string literals and HTML, so it needs its own look.
// Display text only: identifiers, file names, comments and tests are not scanned.

const SRC = fileURLToPath(new URL('..', import.meta.url));
const UPSTREAM_BRANDS = /\b(Fluxer|Plutonium|Neko)\b/;
const LITERAL = /(["'`])((?:\\.|(?!\1).)*?)\1/g;

// Deliberate exceptions. A new entry means upstream's name is on screen or on the wire, which
// needs a decision, not an entry.
const ALLOWED = new Map([
	['X-Fluxer-Desktop-Protocol-Authorization', 'a wire header name shared with the renderer'],
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source text of a template in ShellSelfUpdate.ts
	['Fluxer/${app.getVersion()} (${process.platform}: ${process.arch})', 'the User-Agent string the update server sees'],
	[
		'[VulkanLayerCleanup] Failed to remove Fluxer Vulkan layer registry value',
		'developer log naming the registry value upstream created',
	],
	[
		'[VulkanLayerCleanup] Removed Fluxer Vulkan layer registry value',
		'developer log naming the registry value upstream created',
	],
	['400 12px "Fluxer Sans"', 'the real family name of the bundled UI font'],
	['500 16px "Fluxer Sans"', 'the real family name of the bundled UI font'],
]);

function sourceFiles(root) {
	const out = [];
	for (const name of readdirSync(root, {withFileTypes: true})) {
		const full = join(root, name.name);
		if (name.isDirectory()) {
			if (name.name === 'node_modules' || name.name === 'fonts') continue;
			out.push(...sourceFiles(full));
		} else if (/\.(ts|tsx|cjs|mjs|html)$/.test(name.name) && !/\.test\./.test(name.name)) {
			out.push(full);
		}
	}
	return out;
}

test('desktop display text never names the upstream brand', () => {
	const leaks = [];
	for (const file of sourceFiles(SRC)) {
		const where = relative(SRC, file).split('\\').join('/');
		const isHtml = file.endsWith('.html');
		for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
			const trimmed = line.trim();
			if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue;
			if (isHtml && UPSTREAM_BRANDS.test(trimmed)) {
				leaks.push(`${where}:${index + 1}: ${trimmed.slice(0, 100)}`);
				continue;
			}
			for (const match of line.matchAll(LITERAL)) {
				const body = match[2];
				if (UPSTREAM_BRANDS.test(body) && !ALLOWED.has(body)) {
					leaks.push(`${where}:${index + 1}: ${body.slice(0, 100)}`);
				}
			}
		}
	}
	assert.deepEqual(leaks, []);
});

test('the splash mark is the echowire mark, not the upstream one', () => {
	const mark = readFileSync(join(SRC, 'splash', 'symbol.svg'), 'utf8');
	assert.ok(mark.includes('url(#wg)'), 'symbol.svg should be the echowire waveform mark');
});
