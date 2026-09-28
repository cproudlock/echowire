// SPDX-License-Identifier: AGPL-3.0-or-later

import {msg} from '@lingui/core/macro';
import type React from 'react';

export const APPLICATION_ICON_DESCRIPTOR = msg({
	message: '{productName} application icon',
	comment: 'Accessible label for the Echowire application icon.',
});

export const FluxerIconMark = (props: React.SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 512 512"
		role="img"
		data-flx="ui.icons.fluxer-icon.img"
		{...props}
	>
		<rect fill="var(--brand-primary)" height={512} rx={256} width={512} data-flx="ui.icons.fluxer-icon.rect" />
		{/* Echowire: our own waveform mark, not upstream's logo. */}
		<g transform="translate(256,256) scale(1.6)" fill="var(--brand-primary-fill)" data-flx="ui.icons.fluxer-icon.mark">
			<rect x="-24" y="-16" width="10" height="32" rx="5" opacity="0.2" />
			<rect x="-8" y="-36" width="10" height="72" rx="5" opacity="0.2" />
			<rect x="8" y="-50" width="10" height="100" rx="5" opacity="0.2" />
			<rect x="24" y="-36" width="10" height="72" rx="5" opacity="0.2" />
			<rect x="40" y="-16" width="10" height="32" rx="5" opacity="0.2" />
			<rect x="-76" y="-3" width="152" height="6" rx="3" />
			<circle cx="-78" cy="0" r="8" />
			<circle cx="78" cy="0" r="8" />
			<rect x="-34" y="-16" width="11" height="32" rx="5.5" />
			<rect x="-17" y="-36" width="11" height="72" rx="5.5" />
			<rect x="0" y="-50" width="11" height="100" rx="5.5" />
			<rect x="17" y="-36" width="11" height="72" rx="5.5" />
			<rect x="34" y="-16" width="11" height="32" rx="5.5" />
		</g>
	</svg>
);
