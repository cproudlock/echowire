// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineConfig} from 'vitest/config';

export default defineConfig({
	resolve: {tsconfigPaths: true},
	oxc: {
		jsx: {runtime: 'automatic', importSource: 'react'},
	},
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 30_000,
		hookTimeout: 30_000,
		setupFiles: ['./vitest.setup.ts'],
		// Echowire: upstream dropped this runner with its app tests. The fork keeps it for its own tests,
		// and Config.ts reads these two build values from import.meta.env, which rspack injects in a build.
		env: {
			BUILD_VERSION: process.env.BUILD_VERSION ?? 'dev',
			BUILD_CHANNEL: process.env.BUILD_CHANNEL ?? 'development',
		},
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
		exclude: ['node_modules', 'dist'],
		server: {
			deps: {
				inline: [/livekit-client/, /@livekit\//],
			},
		},
	},
});
