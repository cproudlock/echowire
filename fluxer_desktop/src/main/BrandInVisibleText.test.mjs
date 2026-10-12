import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
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

// The upstream Fluxer images this fork replaced, by sha256. If a merge restores one of them, the splash
// or the macOS tray shows the Fluxer logo again with no text conflict to notice.
const UPSTREAM_IMAGE_SHA256 = new Map([
	['6fbfbefdb697fbb20770717aaaf2f007640032d0ff93232e3eb717361f85c429', 'splash/symbol.svg (Fluxer mark)'],
	['a8db79e9ede805d367b807cf454b20049bb429840eba0a71e35baf8345176771', 'FluxerTrayTemplate.png (Fluxer mark)'],
	['da9774ed429b944db4d1d01d2bd182dfbffdbcaf5052c4bf4740f8f410ae388e', 'FluxerTrayTemplate@2x.png (Fluxer mark)'],
]);

test('no upstream Fluxer image has been restored', () => {
	const root = join(SRC, '..');
	const candidates = [join(SRC, 'splash', 'symbol.svg')];
	for (const dir of readdirSync(join(root, 'build_resources'))) {
		if (!dir.startsWith('icons-')) continue;
		for (const name of ['FluxerTrayTemplate.png', 'FluxerTrayTemplate@2x.png']) {
			candidates.push(join(root, 'build_resources', dir, name));
		}
	}
	const restored = [];
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
		if (UPSTREAM_IMAGE_SHA256.has(digest)) {
			restored.push(`${relative(root, file)} is the upstream ${UPSTREAM_IMAGE_SHA256.get(digest)}`);
		}
	}
	assert.deepEqual(restored, []);
});

// The upstream Fluxer images that new accounts and the press kit show: the six default avatars (the web
// bundle and the CDN copy) and the press logo and symbol files. A merge that restores one brings the Fluxer
// mark back with no text conflict to notice.
const UPSTREAM_PUBLIC_IMAGE_SHA256 = new Map([
	['764a79adf1670806bdf51be85dab2d8ec807350cd7f55fc9495aaf7aec948942', 'fluxer_app/src/media/images/avatars/0.png (Fluxer default avatar)'],
	['a4a6924454696f4dcf58da68da703c388799ac409e1d8025e80bc64e91f5e2e7', 'fluxer_app/src/media/images/avatars/1.png (Fluxer default avatar)'],
	['ab2f55984f8a1d2da1ddc66efde144e8a486c0bc30acff4060834fc179367b50', 'fluxer_app/src/media/images/avatars/2.png (Fluxer default avatar)'],
	['49175e13d5e2467ad5f93d28a750213d2bca9cc73bb0525c490c5b111b67a40a', 'fluxer_app/src/media/images/avatars/3.png (Fluxer default avatar)'],
	['8f44b76866b25e66e1fc9691be1b5554a240eb455135bb462460aba7df9fad86', 'fluxer_app/src/media/images/avatars/4.png (Fluxer default avatar)'],
	['0c8a8a1404b045aa23bff5dde4b7089918dae472d353f78372f61221f6791bb5', 'fluxer_app/src/media/images/avatars/5.png (Fluxer default avatar)'],
	['18cd70ec44990d43832aa9049630975710a59125267e710da529f6c828450f4a', 'fluxer_static/avatars/0.png (Fluxer default avatar)'],
	['0e5341565b36804f4c8202f9ebbb85822e74f7ae9561c91719e89c0cfd5e8e42', 'fluxer_static/avatars/1.png (Fluxer default avatar)'],
	['a2adf40afe1f882d8166a0f24e92ce597f7328dccdeffd66072180a21ae2b9b3', 'fluxer_static/avatars/2.png (Fluxer default avatar)'],
	['3a819b39216830598524151eaffa50ec84eba8ec3d3a0d1453114de603af860a', 'fluxer_static/avatars/3.png (Fluxer default avatar)'],
	['e1b67aebf24a3dd2bb8aa6fa9c540d77ee1ca41b52f57eab75815ef18a4b6582', 'fluxer_static/avatars/4.png (Fluxer default avatar)'],
	['31f8554da33ed907de1e1ad29dad7d8bf7767b5817ee953f7cfd2d2124b2635e', 'fluxer_static/avatars/5.png (Fluxer default avatar)'],
	['981f836165daac46e625a29620dade8010fb22e02dbc8fffb20eb48972085ff5', 'fluxer_static/marketing/branding/logo-black.svg (Fluxer press mark)'],
	['4209869de3a0ad7e97cf73e39d38884cb8eda04e8d697dfdc79372873188972e', 'fluxer_static/marketing/branding/logo-color.svg (Fluxer press mark)'],
	['6eeaf71ef1f9d9e08fedc3b517b97b4b08820b4f8046a8b9601b5e4b4a30dd01', 'fluxer_static/marketing/branding/logo-white.svg (Fluxer press mark)'],
	['5315d3b80a0b1a39797f836074e46f47bf6614470a93ff14b18f71036637e4ab', 'fluxer_static/marketing/branding/symbol-black.svg (Fluxer press mark)'],
	['50bc1dbd3190592a7642da59d3ff6ad1e6ea241ef64513f58033b5f946f19e5f', 'fluxer_static/marketing/branding/symbol-color.svg (Fluxer press mark)'],
	['6fbfbefdb697fbb20770717aaaf2f007640032d0ff93232e3eb717361f85c429', 'fluxer_static/marketing/branding/symbol-white.svg (Fluxer press mark)'],
]);

test('no upstream Fluxer default avatar or press image has been restored', () => {
	const repo = join(SRC, '..', '..');
	const dirs = [
		join(repo, 'fluxer_app', 'src', 'media', 'images', 'avatars'),
		join(repo, 'fluxer_static', 'avatars'),
		join(repo, 'fluxer_static', 'marketing', 'branding'),
	];
	const restored = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!/\.(png|svg)$/.test(name)) continue;
			const digest = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
			if (UPSTREAM_PUBLIC_IMAGE_SHA256.has(digest)) {
				restored.push(`${relative(repo, join(dir, name))} is the upstream ${UPSTREAM_PUBLIC_IMAGE_SHA256.get(digest)}`);
			}
		}
	}
	assert.deepEqual(restored, []);
});
