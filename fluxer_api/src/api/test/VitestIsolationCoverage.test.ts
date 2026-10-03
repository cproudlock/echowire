// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the api vitest project runs with `isolate: false`, so every file in it
// shares one module registry. A test that replaces a module with a `vi.mock` factory
// therefore leaks that replacement into other files in the same pool, and the
// failure lands somewhere the author never touched, intermittently, depending on the
// order files happen to run in. A single green run looks like proof.
//
// vitest.config.ts handles this with MODULE_REGISTRY_TEST_FILES, a hand-written list
// of files that get their own isolated project. A hand-written list silently stops
// covering whatever is added later, which is exactly what had happened: of 588 api
// test files only seven use a mock factory, six were listed, and the seventh,
// PostgresKvLoggerSafety.test.ts, replaced @app/api/Logger (imported by 225 source
// files) with a Proxy that throws on any property access, while running in the shared
// pool.
//
// So the list is derived here instead of trusted. Adding a module-mocking test now
// fails this check by name, deterministically and locally, rather than producing a
// random failure in someone else's file later.

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {describe, expect, it} from 'vitest';

const API_ROOT = join(import.meta.dirname, '../../..');
const SRC_ROOT = join(API_ROOT, 'src');

// `vi.mock('module', factory)`: a second argument means the module is replaced
// wholesale. `vi.mock('module')` on its own is automocked and does not carry a
// closure, so it is not the shape that leaks state.
const MOCK_FACTORY = /vi\.mock\(\s*['"][^'"]+['"]\s*,/;

function testFiles(dir: string): Array<string> {
	const found: Array<string> = [];
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...testFiles(full));
		} else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
			found.push(full);
		}
	}
	return found;
}

function isolatedFiles(): Set<string> {
	const config = readFileSync(join(API_ROOT, 'vitest.config.ts'), 'utf8');
	const listed = new Set<string>();
	for (const match of config.matchAll(/'(src\/[^']*\.test\.tsx?)'/g)) {
		listed.add(match[1]);
	}
	return listed;
}

describe('vitest module isolation covers every module-mocking test', () => {
	it('lists every test that replaces a module with a factory', () => {
		const isolated = isolatedFiles();
		expect(isolated.size).toBeGreaterThan(0);

		const unisolated = testFiles(SRC_ROOT)
			// This file documents the pattern it searches for, so it matches its own
			// detector. It holds no real mock.
			.filter((file) => !file.endsWith('VitestIsolationCoverage.test.ts'))
			.filter((file) => MOCK_FACTORY.test(readFileSync(file, 'utf8')))
			.map((file) => relative(API_ROOT, file).split('\\').join('/'))
			.filter((file) => !isolated.has(file))
			.sort();

		expect(unisolated).toEqual([]);
	});
});
