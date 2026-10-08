// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {afterEach, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const sourcePath = fileURLToPath(new URL('./DeepLinks.ts', import.meta.url));
const transformedSource = esbuild.transformSync(readFileSync(sourcePath, 'utf8'), {
	loader: 'ts',
	format: 'cjs',
	platform: 'node',
	target: 'node20',
}).code;

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const defaultAppDescriptor = Object.getOwnPropertyDescriptor(process, 'defaultApp');

function loadDeepLinks({platform = 'win32'} = {}) {
	Object.defineProperty(process, 'platform', {value: platform, configurable: true});
	Object.defineProperty(process, 'defaultApp', {value: false, configurable: true});
	const registered = [];
	const sent = [];
	const handlers = new Map();
	const mainWindow = {isDestroyed: () => false, webContents: {send: (...args) => sent.push(args)}};
	const module = {exports: {}};
	const context = vm.createContext({
		module,
		exports: module.exports,
		console,
		Date,
		Error,
		URL,
		process,
		require: (specifier) => {
			if (specifier === '@electron/common/Constants') {
				return {APP_PROTOCOLS: ['echowire', 'fluxer']};
			}
			if (specifier === '@electron/main/JumpList') return {parseJumpListTaskFromArgv: () => null};
			if (specifier === '@electron/main/RecentDocuments') return {recordRecentDeepLink: () => {}};
			if (specifier === '@electron/main/Window') return {getMainWindow: () => mainWindow, showWindow: () => {}};
			if (specifier === 'electron') {
				return {
					app: {setAsDefaultProtocolClient: (protocol) => registered.push(protocol)},
					ipcMain: {handle: (channel, handler) => handlers.set(channel, handler)},
				};
			}
			return require(specifier);
		},
	});
	vm.runInContext(transformedSource, context, {filename: sourcePath});
	return {...module.exports, registered, sent, handlers};
}

afterEach(() => {
	Object.defineProperty(process, 'platform', platformDescriptor);
	if (defaultAppDescriptor) {
		Object.defineProperty(process, 'defaultApp', defaultAppDescriptor);
	} else {
		delete process.defaultApp;
	}
});

describe('DeepLinks', () => {
	test('registers both schemes as the OS protocol client', () => {
		const {initializeDeepLinks, registered} = loadDeepLinks();
		initializeDeepLinks();
		assert.deepEqual(registered, ['echowire', 'fluxer']);
	});

	test('hands the renderer the same path for either scheme', () => {
		const {handleOpenUrl, sent} = loadDeepLinks();
		handleOpenUrl('echowire://invite/abc');
		handleOpenUrl('fluxer://channels/1/2');
		assert.deepEqual(sent, [
			['deep-link', '/invite/abc'],
			['deep-link', '/channels/1/2'],
		]);
	});

	test('ignores other schemes and links with characters the renderer must not receive', () => {
		const {handleOpenUrl, sent} = loadDeepLinks();
		handleOpenUrl('https://echowire.org/invite/abc');
		handleOpenUrl('discord://invite/abc');
		handleOpenUrl("echowire://invite/a'b");
		handleOpenUrl("fluxer://invite/a'b");
		assert.deepEqual(sent, []);
	});

	test('passes markup through only after the URL parser has percent-encoded it', () => {
		const {handleOpenUrl, sent} = loadDeepLinks();
		handleOpenUrl('echowire://invite/<script>');
		assert.deepEqual(sent, [['deep-link', '/invite/%3Cscript%3E']]);
	});

	test('answers get-initial-deep-link with the link the app was launched with', () => {
		const original = process.argv;
		process.argv = [...original, 'echowire://invite/launch'];
		try {
			const {initializeDeepLinks, handlers} = loadDeepLinks();
			initializeDeepLinks();
			const read = handlers.get('get-initial-deep-link');
			assert.equal(read(), '/invite/launch');
			assert.equal(read(), null);
		} finally {
			process.argv = original;
		}
	});
});
