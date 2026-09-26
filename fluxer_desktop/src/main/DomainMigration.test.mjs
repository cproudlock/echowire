// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

function transform(relativePath) {
	const sourcePath = fileURLToPath(new URL(relativePath, import.meta.url));
	const code = esbuild.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
	}).code;
	return {sourcePath, code};
}

const constantsSource = transform('../common/Constants.ts');
const desktopConfigSource = transform('../common/DesktopConfig.ts');
const domainMigrationSource = transform('./DomainMigration.ts');

const silentLog = {debug() {}, info() {}, warn() {}, error() {}};

function runModule({sourcePath, code}, requireStub) {
	const module = {exports: {}};
	const context = vm.createContext({
		require: requireStub,
		module,
		exports: module.exports,
		process,
		console,
		URL,
		JSON,
	});
	vm.runInContext(code, context, {filename: sourcePath});
	return module.exports;
}

function loadDesktop({channel = 'stable', settings} = {}) {
	const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-domain-migration-test-'));
	const settingsPath = path.join(userDataPath, 'settings.json');
	if (settings !== undefined) {
		fs.writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8');
	}
	const constants = runModule(constantsSource, (specifier) => {
		throw new Error(`Unexpected import: ${specifier}`);
	});
	const desktopConfig = runModule(desktopConfigSource, (specifier) => {
		if (specifier === 'node:fs') return fs;
		if (specifier === 'node:path') return path;
		if (specifier === '@electron/common/BuildChannel') return {BUILD_CHANNEL: channel};
		if (specifier === '@electron/common/Constants') return constants;
		if (specifier === 'electron-log') return silentLog;
		throw new Error(`Unexpected import: ${specifier}`);
	});
	desktopConfig.loadDesktopConfig(userDataPath);
	const handlers = new Map();
	runModule(domainMigrationSource, (specifier) => {
		if (specifier === '@electron/common/DesktopConfig') return desktopConfig;
		if (specifier === '@electron/common/Logger') return {createChildLogger: () => silentLog};
		if (specifier === 'electron') {
			return {
				ipcMain: {
					handle: (name, handler) => {
						handlers.set(name, handler);
					},
				},
			};
		}
		throw new Error(`Unexpected import: ${specifier}`);
	}).registerDomainMigrationHandlers();
	const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
	const setAppOrigin = (frame, origin) => handlers.get('domain-migration:set-app-origin')({senderFrame: frame}, origin);
	return {desktopConfig, readSettings, setAppOrigin, settingsPath};
}

function topLevelFrame(url) {
	return {url, detached: false, parent: null};
}

const CONSTANTS = runModule(constantsSource, (specifier) => {
	throw new Error(`Unexpected import: ${specifier}`);
});

function legacyFor(channel) {
	return channel === 'canary' ? CONSTANTS.CANARY_APP_URL : CONSTANTS.STABLE_APP_URL;
}

function migratedFor(channel) {
	return channel === 'canary' ? CONSTANTS.CANARY_MIGRATED_APP_ORIGIN : CONSTANTS.STABLE_MIGRATED_APP_ORIGIN;
}

function migratedUrlFor(channel) {
	return `${migratedFor(channel)}${CONSTANTS.MIGRATED_APP_ENTRY_PATH}`;
}

describe('Echowire domain migration neutralisation', () => {
	// Upstream is migrating to a second domain. This instance is not, so
	// Constants.ts points the migrated origin at our own origin and leaves the
	// entry path empty. These assertions pin that arrangement: they are what
	// makes getAppUrl() return the same URL down both branches and the Window
	// fallback a no-op, and they would fail loudly if a merge reintroduced
	// upstream's domains.
	test('the migrated origin is our own origin on both channels', () => {
		assert.equal(migratedFor('stable'), new URL(legacyFor('stable')).origin);
		assert.equal(migratedFor('canary'), new URL(legacyFor('canary')).origin);
	});

	test('the entry path is empty so no build loads a migrated sub-path', () => {
		assert.equal(CONSTANTS.MIGRATED_APP_ENTRY_PATH, '');
	});

	test('the passkey relying party is ours, never upstream', () => {
		assert.deepEqual([...CONSTANTS.PASSKEY_RP_IDS], ['echowire.org']);
	});

	test('no constant names an upstream domain', () => {
		for (const value of [
			CONSTANTS.STABLE_APP_URL,
			CONSTANTS.CANARY_APP_URL,
			CONSTANTS.STABLE_MIGRATED_APP_ORIGIN,
			CONSTANTS.CANARY_MIGRATED_APP_ORIGIN,
			...CONSTANTS.PASSKEY_RP_IDS,
		]) {
			assert.equal(/fluxer\.(app|com)/.test(value), false, `${value} names an upstream domain`);
		}
	});
});

describe('DesktopConfig app origin', () => {
	test('keeps loading the legacy root when no app origin is stored', () => {
		assert.equal(loadDesktop().desktopConfig.getAppUrl(), legacyFor('stable'));
		assert.equal(loadDesktop({channel: 'canary'}).desktopConfig.getAppUrl(), legacyFor('canary'));
	});

	test('loads the app entry path for a stored migrated origin', () => {
		const stable = loadDesktop({settings: {app_origin: migratedFor('stable')}});
		const canary = loadDesktop({channel: 'canary', settings: {app_origin: migratedFor('canary')}});

		assert.equal(stable.desktopConfig.getAppUrl(), migratedUrlFor('stable'));
		assert.equal(canary.desktopConfig.getAppUrl(), migratedUrlFor('canary'));
	});

	test('loads the legacy root for a stored legacy origin', () => {
		const legacyOrigin = new URL(legacyFor('stable')).origin;
		const {desktopConfig} = loadDesktop({settings: {app_origin: legacyOrigin}});

		assert.equal(desktopConfig.getAppUrl(), legacyFor('stable'));
	});

	test('drops stored origins outside the allowlist', () => {
		const legacyOrigin = new URL(legacyFor('stable')).origin;
		for (const appOrigin of [
			'https://evil.example',
			`${legacyOrigin}/`,
			legacyOrigin.replace('https://', 'http://'),
			42,
		]) {
			const {desktopConfig} = loadDesktop({settings: {app_origin: appOrigin}});
			assert.equal(desktopConfig.getAppUrl(), legacyFor('stable'));
		}
	});

	test('only the migrated origin falls back to the legacy root', () => {
		const stable = loadDesktop({settings: {app_origin: migratedFor('stable')}}).desktopConfig;

		assert.equal(stable.getAppUrlFallback(`${migratedFor('stable')}/app`), legacyFor('stable'));
		assert.equal(stable.getAppUrlFallback('https://evil.example/app'), null);
		assert.equal(stable.getAppUrlFallback('not a url'), null);
	});

	test('the runtime override still wins over a stored origin', () => {
		const {desktopConfig} = loadDesktop({settings: {app_origin: migratedFor('stable')}});
		desktopConfig.setRuntimeAppUrlOverride('http://localhost:8088/');

		assert.equal(desktopConfig.getAppUrl(), 'http://localhost:8088/');
	});
});

describe('DomainMigration set app origin IPC', () => {
	test('persists an allowlisted origin from an official top-level frame', () => {
		const {desktopConfig, readSettings, setAppOrigin} = loadDesktop();

		setAppOrigin(topLevelFrame(`${migratedFor('stable')}/migrate/complete`), migratedFor('stable'));

		assert.equal(readSettings().app_origin, migratedFor('stable'));
		assert.equal(desktopConfig.getAppUrl(), migratedUrlFor('stable'));
	});

	test('accepts the legacy frame of the running channel', () => {
		const {readSettings, setAppOrigin} = loadDesktop({channel: 'canary'});

		setAppOrigin(topLevelFrame(`${legacyFor('canary')}/channels/@me`), migratedFor('canary'));

		assert.equal(readSettings().app_origin, migratedFor('canary'));
	});

	test('rejects senders that are not official top-level frames', () => {
		// Upstream also rejects the other channel's origin here. On this fork both
		// channels resolve to the same origin, so that case cannot be expressed.
		const {setAppOrigin, settingsPath} = loadDesktop();
		const officialUrl = `${migratedFor('stable')}/app`;
		const rejectedFrames = [
			null,
			topLevelFrame('https://evil.example/'),
			{url: officialUrl, detached: true, parent: null},
			{url: officialUrl, detached: false, parent: topLevelFrame(officialUrl)},
			topLevelFrame('not a url'),
		];
		for (const frame of rejectedFrames) {
			assert.throws(() => setAppOrigin(frame, migratedFor('stable')), /official app document/);
		}
		assert.equal(fs.existsSync(settingsPath), false);
	});

	test('rejects origins outside the allowlist', () => {
		const {setAppOrigin, settingsPath} = loadDesktop();
		const officialUrl = `${migratedFor('stable')}/app`;
		for (const origin of ['https://evil.example', officialUrl, null]) {
			assert.throws(() => setAppOrigin(topLevelFrame(officialUrl), origin), /outside the allowlist/);
		}
		assert.equal(fs.existsSync(settingsPath), false);
	});
});
