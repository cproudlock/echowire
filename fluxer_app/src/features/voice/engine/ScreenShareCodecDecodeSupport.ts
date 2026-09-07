// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VideoCodec} from 'livekit-client';

/**
 * Codec name mapping and capability-set maths for screen share negotiation.
 *
 * This lives apart from ScreenShareCodecNegotiation deliberately: that module reaches VoiceSettings
 * and therefore RuntimeConfig, which throws without a served bootstrap, so nothing in it can be unit
 * tested. Everything here is pure.
 */

export const ALL_VIDEO_CODECS: ReadonlyArray<VideoCodec> = ['av1', 'h265', 'h264', 'vp9', 'vp8'];

export type FluxerVideoCodecName = 'AV1' | 'H265' | 'H264' | 'VP9' | 'VP8';

export const VIDEO_CODEC_NAMES: Record<VideoCodec, FluxerVideoCodecName> = {
	av1: 'AV1',
	h265: 'H265',
	h264: 'H264',
	vp9: 'VP9',
	vp8: 'VP8',
};

export const NAME_TO_VIDEO_CODEC: Record<FluxerVideoCodecName, VideoCodec> = {
	AV1: 'av1',
	H265: 'h265',
	H264: 'h264',
	VP9: 'vp9',
	VP8: 'vp8',
};

/** Structural view of a codec advertisement, so this module never imports the negotiation module. */
export interface CodecCapabilityAdvertisement {
	name: string;
	type: string;
	encode?: boolean;
	decode?: boolean;
}

function toVideoCodec(name: string): VideoCodec | undefined {
	return NAME_TO_VIDEO_CODEC[name as FluxerVideoCodecName];
}

export function getDecodeSet(codecs: ReadonlyArray<CodecCapabilityAdvertisement>): Set<VideoCodec> {
	const result = new Set<VideoCodec>();
	for (const codec of codecs) {
		if (codec.type !== 'video' || codec.decode !== true) continue;
		const mapped = toVideoCodec(codec.name);
		if (mapped) result.add(mapped);
	}
	return result;
}

export function getEncodeSet(codecs: ReadonlyArray<CodecCapabilityAdvertisement>): Set<VideoCodec> {
	const result = new Set<VideoCodec>();
	for (const codec of codecs) {
		if (codec.type !== 'video' || codec.encode !== true) continue;
		const mapped = toVideoCodec(codec.name);
		if (mapped) result.add(mapped);
	}
	return result;
}

/**
 * Codecs that every remote who told us their capabilities can decode. A remote whose decode set is
 * empty has told us nothing usable, so it is skipped instead of vetoing every codec: this list is
 * about what is provably watchable, never about what is merely uncertain. A codec missing from it
 * while it is being published means someone is definitely seeing nothing, which is the only case
 * that justifies interrupting a live share to switch codec.
 */
export function computeDecodableByKnownParticipants(
	remoteCodecs: ReadonlyArray<ReadonlyArray<CodecCapabilityAdvertisement>>,
): Array<VideoCodec> {
	const decodeSets = remoteCodecs.map(getDecodeSet).filter((decodeSet) => decodeSet.size > 0);
	return ALL_VIDEO_CODECS.filter((codec) => decodeSets.every((decodeSet) => decodeSet.has(codec)));
}
