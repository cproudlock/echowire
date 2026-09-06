// SPDX-License-Identifier: AGPL-3.0-or-later
import {findNativeCaptureSourceForDesktopSource} from '@app/features/voice/components/modals/screen_share_picker_modal/shared';
import {describe, expect, it} from 'vitest';

// Echowire regression: real values captured from Electron's desktopCapturer and the Linux X11
// capture addon on an X11/Cinnamon box with two identical 1080p monitors.
//
// Electron screen ids on X11 look like `screen:385:0`, where 385 is an opaque Chromium id, not a
// 0-based ordinal. parseScreenOrdinal used to accept it and, via `??`, suppress the name-derived
// ordinal that is the only thing able to resolve these. The dimension fallback cannot help either,
// because it demands a unique match and both monitors are 1920x1080. Result: no native source was
// ever selected, the share fell through to the portal path, and X11 users got
// "no live portal session".
const X11_DESKTOP_SOURCES = [
	{id: 'screen:385:0', name: 'Screen 1', display_id: '1263913556', nativeWidth: 1920, nativeHeight: 1080},
	{id: 'screen:384:0', name: 'Screen 2', display_id: '1263913555', nativeWidth: 1920, nativeHeight: 1080},
] as never[];

const X11_NATIVE_SOURCES = [
	{kind: 'screen', id: '84', name: 'DisplayPort-2', width: 1920, height: 1080},
	{kind: 'screen', id: '83', name: 'DisplayPort-1', width: 1920, height: 1080},
] as never[];

describe('findNativeCaptureSourceForDesktopSource', () => {
	it('resolves X11 screen cards whose id token is not an ordinal', () => {
		const matches = X11_DESKTOP_SOURCES.map(
			(source) => findNativeCaptureSourceForDesktopSource(source, X11_NATIVE_SOURCES) as {id: string} | undefined,
		);
		expect(matches.map((match) => match?.id)).toEqual(['84', '83']);
	});

	it('does not mistake a large id token for an index into the native source list', () => {
		const single = [X11_NATIVE_SOURCES[0]] as never[];
		const match = findNativeCaptureSourceForDesktopSource(X11_DESKTOP_SOURCES[0], single) as {id: string} | undefined;
		expect(match?.id).toBe('84');
	});
});
