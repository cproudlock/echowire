// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: the plutonium page art, from the files bundled in this app. Upstream's
// PlutoniumPageMedia.ts hotlinks the screenshots from fluxer.app (hostedImageUrl, #3173), which this
// fork rejects, so this module exports the same names backed by local files. Keep it fork-owned.

import avatarLsf from '@app/media/images/plutonium/avatar-lsf.webp';
import bannerLsf from '@app/media/images/plutonium/banner-lsf.webp';
import emojiCatvibe from '@app/media/images/plutonium/emoji-catvibe.webp';
import emojiCatwave from '@app/media/images/plutonium/emoji-catwave.webp';
import expressions640Avif from '@app/media/images/plutonium/feature-perk-expressions-640w.avif';
import expressions640Webp from '@app/media/images/plutonium/feature-perk-expressions-640w.webp';
import expressions1120Avif from '@app/media/images/plutonium/feature-perk-expressions-1120w.avif';
import expressions1120Webp from '@app/media/images/plutonium/feature-perk-expressions-1120w.webp';
import expressions1600Avif from '@app/media/images/plutonium/feature-perk-expressions-1600w.avif';
import expressions1600Webp from '@app/media/images/plutonium/feature-perk-expressions-1600w.webp';
import profile640Avif from '@app/media/images/plutonium/feature-perk-profile-640w.avif';
import profile640Webp from '@app/media/images/plutonium/feature-perk-profile-640w.webp';
import profile1120Avif from '@app/media/images/plutonium/feature-perk-profile-1120w.avif';
import profile1120Webp from '@app/media/images/plutonium/feature-perk-profile-1120w.webp';
import profile1600Avif from '@app/media/images/plutonium/feature-perk-profile-1600w.avif';
import profile1600Webp from '@app/media/images/plutonium/feature-perk-profile-1600w.webp';
import stream640Avif from '@app/media/images/plutonium/feature-perk-stream-640w.avif';
import stream640Webp from '@app/media/images/plutonium/feature-perk-stream-640w.webp';
import stream1120Avif from '@app/media/images/plutonium/feature-perk-stream-1120w.avif';
import stream1120Webp from '@app/media/images/plutonium/feature-perk-stream-1120w.webp';
import stream1600Avif from '@app/media/images/plutonium/feature-perk-stream-1600w.avif';
import stream1600Webp from '@app/media/images/plutonium/feature-perk-stream-1600w.webp';
import upload640Avif from '@app/media/images/plutonium/feature-perk-upload-640w.avif';
import upload640Webp from '@app/media/images/plutonium/feature-perk-upload-640w.webp';
import upload1120Avif from '@app/media/images/plutonium/feature-perk-upload-1120w.avif';
import upload1120Webp from '@app/media/images/plutonium/feature-perk-upload-1120w.webp';
import upload1600Avif from '@app/media/images/plutonium/feature-perk-upload-1600w.avif';
import upload1600Webp from '@app/media/images/plutonium/feature-perk-upload-1600w.webp';
import crownAvif from '@app/media/images/plutonium/plutonium-crown.avif';
import crownWebp from '@app/media/images/plutonium/plutonium-crown.webp';
import stickerFeelThat from '@app/media/images/plutonium/sticker-feel-that.webp';
import plutoniumAtomAvif from '@app/media/images/premium/plutonium-atom.avif';
import plutoniumAtomWebp from '@app/media/images/premium/plutonium-atom.webp';
import plutoniumAtomAvif2x from '@app/media/images/premium/plutonium-atom-960w.avif';
import plutoniumAtomWebp2x from '@app/media/images/premium/plutonium-atom-960w.webp';

export interface HeroArt {
	avifSrcSet: string;
	webpSrcSet: string;
	src: string;
	width: number;
	height: number;
}

function densitySrcSet(oneX: string, twoX: string): string {
	return `${oneX} 1x, ${twoX} 2x`;
}

const PLUTONIUM_ATOM_ART: HeroArt = {
	avifSrcSet: densitySrcSet(plutoniumAtomAvif, plutoniumAtomAvif2x),
	webpSrcSet: densitySrcSet(plutoniumAtomWebp, plutoniumAtomWebp2x),
	src: plutoniumAtomWebp,
	width: 480,
	height: 524,
};

const PREMIUM_CROWN_ART: HeroArt = {
	avifSrcSet: `${crownAvif} 1x`,
	webpSrcSet: `${crownWebp} 1x`,
	src: crownWebp,
	width: 480,
	height: 395,
};

export function heroArtFor(selfHosted: boolean): HeroArt {
	return selfHosted ? PREMIUM_CROWN_ART : PLUTONIUM_ATOM_ART;
}

export const AVATAR_LSF = avatarLsf;
export const BANNER_LSF = bannerLsf;
export const EMOJI_CATVIBE = emojiCatvibe;
export const EMOJI_CATWAVE = emojiCatwave;
export const STICKER_FEEL_THAT = stickerFeelThat;

export interface ShotFamily {
	avif: [string, string, string];
	webp: [string, string, string];
}

export const EXPRESSIONS_SHOTS: ShotFamily = {
	avif: [expressions640Avif, expressions1120Avif, expressions1600Avif],
	webp: [expressions640Webp, expressions1120Webp, expressions1600Webp],
};

export const PROFILE_SHOTS: ShotFamily = {
	avif: [profile640Avif, profile1120Avif, profile1600Avif],
	webp: [profile640Webp, profile1120Webp, profile1600Webp],
};

export const STREAM_SHOTS: ShotFamily = {
	avif: [stream640Avif, stream1120Avif, stream1600Avif],
	webp: [stream640Webp, stream1120Webp, stream1600Webp],
};

export const UPLOAD_SHOTS: ShotFamily = {
	avif: [upload640Avif, upload1120Avif, upload1600Avif],
	webp: [upload640Webp, upload1120Webp, upload1600Webp],
};
