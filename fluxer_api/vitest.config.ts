// SPDX-License-Identifier: AGPL-3.0-or-later

import {availableParallelism} from 'node:os';
import {configDefaults, defineConfig} from 'vitest/config';

function parseParallelInteger(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		return fallback;
	}
	return parsed;
}

function resolveDefaultParallelWorkers(): number {
	return Math.max(2, availableParallelism() - 1);
}

const DEFAULT_PARALLEL_WORKERS = resolveDefaultParallelWorkers();
const configuredMaxWorkers = parseParallelInteger(process.env.API_TEST_MAX_WORKERS, DEFAULT_PARALLEL_WORKERS);
const configuredMaxConcurrency = parseParallelInteger(process.env.API_TEST_MAX_CONCURRENCY, configuredMaxWorkers);

const MODULE_REGISTRY_TEST_FILES = [
	'src/api/channel/tests/MessageCrosspostFanout.test.ts',
	// Echowire: found by VitestIsolationCoverage.test.ts. This replaces
	// @app/api/Logger, which 225 api source files import, with a Proxy that throws on
	// any property access. In the shared pool that leaks into unrelated files as
	// "Logger has not been initialized". Unlisted since it arrived in upstream #2118.
	'src/api/database/PostgresKvLoggerSafety.test.ts',
	// Echowire: this fork test replaces the ThreadMemberRepository module, so it needs
	// its own registry for the same reason #3091 isolated the two crosspost files.
	'src/api/channel/tests/ThreadSweepScan.test.ts',
	'src/api/gif/GifRequestCountry.test.ts',
	'src/api/stripe/tests/StripeCheckoutCountryEnforcement.test.ts',
	'src/api/stripe/tests/StripeNordicCurrencies.test.ts',
	'src/api/worker/tests/CrosspostTasks.test.ts',
];

const INSTANCE_POLICY_TEST_FILES = [
	'src/api/admin/tests/InstanceConfigPendingRegistrationApproval.test.ts',
	'src/api/instance/tests/SingleCommunityService.test.ts',
];

const sharedExclude = [
	...configDefaults.exclude,
	'pkgs/**',
	'../fluxer_desktop/**',
	'**/target/**',
	'**/*Integration.test.ts',
	'**/*ExttestIntegration.test.ts',
];

const sharedTestConfig = {
	globals: true,
	environment: 'node' as const,
	setupFiles: ['./src/api/test/Setup.ts'],
	pool: 'threads' as const,
	testTimeout: 40000,
	hookTimeout: 20000,
	maxConcurrency: configuredMaxConcurrency,
};

export default defineConfig({
	root: process.cwd(),
	cacheDir: './node_modules/.vitest',
	test: {
		maxWorkers: configuredMaxWorkers,
		maxConcurrency: configuredMaxConcurrency,
		fileParallelism: true,
		reporters: ['default', 'json'],
		outputFile: './test-results.json',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'text-summary', 'json', 'html'],
			reportsDirectory: './coverage',
			exclude: [
				'**/node_modules/tests/test*.test.tsx',
				'**/*.test.ts',
				'**/Setup.tsx',
				'**/TestConstants.tsx',
				'**/TestRequestBuilder.tsx',
				'**/TestHelpers.tsx',
			],
		},
		projects: [
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api',
					include: ['src/**/*.{test,spec}.{ts,tsx}'],
					exclude: [...sharedExclude, ...MODULE_REGISTRY_TEST_FILES, ...INSTANCE_POLICY_TEST_FILES],
					isolate: false,
				},
			},
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api-module-registry',
					include: MODULE_REGISTRY_TEST_FILES,
					exclude: sharedExclude,
					isolate: true,
				},
			},
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api-instance-policy',
					include: INSTANCE_POLICY_TEST_FILES,
					exclude: sharedExclude,
					isolate: true,
				},
			},
		],
	},
});
