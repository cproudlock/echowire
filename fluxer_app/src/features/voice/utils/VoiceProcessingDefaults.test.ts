// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {DEFAULT_VOICE_PROCESSING_MODE, resolveVoiceProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
import {describe, expect, it} from 'vitest';

// Echowire: these four values are the fork's voice divergence, kept because enhanced
// noise suppression over-processes voice and degrades it over a session, and because
// upstream's 'speech' content hint forces Opus into narrowband (upstream
// fluxerapp/fluxer#878). Upstream shipped its own noise-suppression treatment to
// everyone in #3029 and defaults the other way on every one of them, so without these
// assertions a future upstream merge reverts the divergence silently: nothing else in
// the suite reads them. If one of these fails after a merge, that is the signal to
// re-apply the divergence, not to update the expectation.
describe('the echowire voice processing defaults', () => {
	it('defaults to the custom profile rather than upstream voice', () => {
		expect(DEFAULT_VOICE_PROCESSING_MODE).toBe('custom');
	});

	it('leaves the voice profile content hint empty so Opus stays full-band', () => {
		const resolved = resolveVoiceProcessing(
			{voiceProcessingMode: 'voice', echoCancellation: true, autoGainControl: false},
			'standard',
			false,
		);
		expect(resolved.contentHint).toBe('');
	});

	it('does not force a content hint on the custom profile either', () => {
		const resolved = resolveVoiceProcessing(
			{voiceProcessingMode: 'custom', echoCancellation: true, autoGainControl: false},
			'standard',
			false,
		);
		expect(resolved.contentHint).toBe('');
	});

	it('keeps the studio profile unprocessed', () => {
		const resolved = resolveVoiceProcessing(
			{voiceProcessingMode: 'studio', echoCancellation: true, autoGainControl: true},
			'deep_filter',
			false,
		);
		expect(resolved.echoCancellation).toBe(false);
		expect(resolved.autoGainControl).toBe(false);
		expect(resolved.deepFilter).toBe(false);
		expect(resolved.noiseSuppressionBackend).toBe('none');
	});
});
