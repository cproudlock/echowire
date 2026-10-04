// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

// Echowire: upstream #3103 retired DeepFilter as its default and shipped a migration
// that clears a stored 'deep_filter' preference, so those users land on its new
// RNNoise default. This fork keeps 'standard' as the default and never shipped
// DeepFilter to everyone (#3029), so a stored 'deep_filter' here is a deliberate user
// choice rather than an inherited default, and clearing it would move that user to
// somewhere they never picked.
//
// So upstream's migration is kept for its flag and stripped of its destructive line,
// and this file is the assertion that the stripping is still in place.
// VoiceProcessingDefaults covers the default; nothing there would notice a migration
// quietly deleting saved preferences, because a cleared preference falls back to the
// default and the default is correct either way. That is the gap this closes.
//
// If this fails after a merge, upstream's body has come back. Re-strip the clearing
// line rather than updating the expectation.
//
// Only VoiceSettings' direct imports are mocked, not the module under test. Importing
// it for real otherwise pulls a transitive @lingui/core/macro chain that wants
// babel-plugin-macros, which this repo does not declare: a pre-existing gap, not one
// this test introduces, and the reason no other test imports this module for real.
// The migration is a pure function over a plain object, so stubbing its siblings costs
// the assertion nothing.
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {getItem: () => null, setItem: () => undefined, removeItem: () => undefined},
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
		info() {}
		error() {}
		debug() {}
	},
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: () => undefined}));
vi.mock('@app/features/voice/utils/VideoQualityEntitlement', () => ({hasHigherVideoQuality: () => false}));
vi.mock('@app/features/voice/utils/VoiceBackgroundAvailability', () => ({
	areVoiceBackgroundsAvailable: () => false,
}));

const {applyDeepFilterDefaultRetiredMigrationV1} = await import('@app/features/voice/state/VoiceSettings');

describe('the echowire deep_filter preference migration', () => {
	it('leaves a stored deep_filter preference alone', () => {
		const parsed: Record<string, unknown> = {noiseSuppressionBackendPrefV1: 'deep_filter'};
		applyDeepFilterDefaultRetiredMigrationV1(parsed);
		expect(parsed.noiseSuppressionBackendPrefV1).toBe('deep_filter');
	});

	it('still records itself as applied, so upstream’s body cannot run later', () => {
		const parsed: Record<string, unknown> = {noiseSuppressionBackendPrefV1: 'deep_filter'};
		expect(applyDeepFilterDefaultRetiredMigrationV1(parsed)).toBe(true);
		expect(parsed.deepFilterDefaultRetiredMigratedV1).toBe(true);
	});

	it('is a no-op once it has been applied', () => {
		const parsed: Record<string, unknown> = {
			noiseSuppressionBackendPrefV1: 'deep_filter',
			deepFilterDefaultRetiredMigratedV1: true,
		};
		expect(applyDeepFilterDefaultRetiredMigrationV1(parsed)).toBe(false);
		expect(parsed.noiseSuppressionBackendPrefV1).toBe('deep_filter');
	});

	it('leaves every other stored backend choice alone too', () => {
		// Not only deep_filter: the objection is to the migration touching a saved
		// choice at all, so assert each one a user can actually be holding.
		for (const stored of ['standard', 'rnnoise', 'deep_filter', 'none']) {
			const parsed: Record<string, unknown> = {noiseSuppressionBackendPrefV1: stored};
			applyDeepFilterDefaultRetiredMigrationV1(parsed);
			expect(parsed.noiseSuppressionBackendPrefV1).toBe(stored);
		}
	});
});
