// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {type CodecCapabilityAdvertisement, computeDecodableByKnownParticipants} from './ScreenShareCodecDecodeSupport';

function video(name: 'AV1' | 'H265' | 'H264' | 'VP9' | 'VP8', decode: boolean): CodecCapabilityAdvertisement {
	return {name, type: 'video', decode};
}

const AV1_CAPABLE = [video('AV1', true), video('H264', true), video('VP8', true)];
const NO_AV1 = [video('H264', true), video('VP8', true)];

describe('computeDecodableByKnownParticipants', () => {
	it('reports every codec when nobody else is in the room', () => {
		expect(computeDecodableByKnownParticipants([])).toEqual(['av1', 'h265', 'h264', 'vp9', 'vp8']);
	});

	it('intersects across participants, dropping what one of them cannot decode', () => {
		const decodable = computeDecodableByKnownParticipants([AV1_CAPABLE, NO_AV1]);
		expect(decodable).toContain('h264');
		expect(decodable).toContain('vp8');
		expect(decodable).not.toContain('av1');
	});

	it('keeps a codec that every known participant advertised', () => {
		expect(computeDecodableByKnownParticipants([AV1_CAPABLE, AV1_CAPABLE])).toContain('av1');
	});

	it('skips participants who advertised nothing rather than letting them veto every codec', () => {
		expect(computeDecodableByKnownParticipants([AV1_CAPABLE, []])).toContain('av1');
		expect(computeDecodableByKnownParticipants([AV1_CAPABLE, [video('H264', false)]])).toContain('av1');
	});

	it('ignores advertisements that are present but not decodable', () => {
		const decodable = computeDecodableByKnownParticipants([[video('AV1', false), video('H264', true)]]);
		expect(decodable).not.toContain('av1');
		expect(decodable).toContain('h264');
	});
});
