// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import type {VoiceEngineV2VideoCodec} from '@fluxer/voice_engine_v2';

/**
 * FORK DEVIATION - works around a codec-stickiness defect in the native publish path.
 *
 * The LiveKit Rust SDK restricts a video transceiver to a single codec: `create_sender` builds
 * `matched` / `partial_matched` / `unmatched` from the sender capabilities and then calls
 * `set_codec_preferences(matched)` without ever appending `unmatched` (the JS SDK does append it).
 * The first video m-line we offer therefore advertises exactly one codec, the SFU negotiates its
 * media engine against that single codec, and every later publish on the same connection is
 * answered with the FIRST codec no matter what the new m-line offered.
 *
 * The result is a track that is declared as one codec and sent as another. LiveKit logs
 * `could not find codec for webrtc receiver`, wires no receiver, forwards nothing, and reports no
 * error to anyone: viewers subscribe successfully and stare at a black tile forever. Observed live
 * on 2026-08-22, where a share negotiated h264, restarted as vp8 three times, and was invisible
 * every time.
 *
 * Until the crate is patched, the last mile enforces the SFU's actual rule: the first video codec
 * used on a connection is the codec for the life of that connection.
 */

export const NATIVE_CONNECTION_DEFAULT_VIDEO_CODEC: VoiceEngineV2VideoCodec = 'vp8';

export interface NativeConnectionVideoCodecDecision {
	/** The codec to publish with. Identical to the request unless the lock overrode it. */
	codec: VoiceEngineV2VideoCodec | undefined;
	/** True when the request was overridden because the connection had already negotiated video. */
	overridden: boolean;
	/** The codec this connection is locked to, once anything has been published. */
	locked: VoiceEngineV2VideoCodec;
}

/**
 * An unset codec means "let the SDK pick its default", which is vp8, and the native side treats an
 * empty codec string and vp8 identically (neither enables the zero-copy texture path). Normalising
 * them to the same value keeps an unset request from being reported as a codec change.
 */
function normalizeVideoCodec(codec: VoiceEngineV2VideoCodec | undefined): VoiceEngineV2VideoCodec {
	if (codec == null || codec === '') return NATIVE_CONNECTION_DEFAULT_VIDEO_CODEC;
	return codec;
}

export class NativeConnectionVideoCodecLock {
	private lockedCodec: VoiceEngineV2VideoCodec | null = null;

	/** Called when the connection goes away, since the next one negotiates from scratch. */
	reset(): void {
		this.lockedCodec = null;
	}

	isLocked(): boolean {
		return this.lockedCodec !== null;
	}

	getLockedCodec(): VoiceEngineV2VideoCodec | null {
		return this.lockedCodec;
	}

	/**
	 * Locks the connection to `requested` on the first video publish, and afterwards returns the
	 * locked codec. The request is passed through verbatim when it agrees with the lock, so an
	 * unset codec stays unset rather than becoming an explicit vp8.
	 */
	resolve(requested: VoiceEngineV2VideoCodec | undefined): NativeConnectionVideoCodecDecision {
		const normalized = normalizeVideoCodec(requested);
		assert.ok(normalized.length > 0, 'normalized native video codec must be non-empty');
		if (this.lockedCodec === null) {
			this.lockedCodec = normalized;
			return {codec: requested, overridden: false, locked: normalized};
		}
		if (this.lockedCodec === normalized) {
			return {codec: requested, overridden: false, locked: this.lockedCodec};
		}
		return {codec: this.lockedCodec, overridden: true, locked: this.lockedCodec};
	}
}
