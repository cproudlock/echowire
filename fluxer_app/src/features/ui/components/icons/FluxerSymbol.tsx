// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {getDataFlx, getImageSizingProps} from './BrandImageUtils';

const APPLICATION_SYMBOL_DESCRIPTOR = msg({
	message: '{productName} application symbol',
	comment: 'Accessible label for the application symbol logo.',
});
export const FluxerSymbol = observer((props: React.SVGProps<SVGSVGElement>) => {
	const {i18n} = useLingui();
	const ariaLabel = i18n._(APPLICATION_SYMBOL_DESCRIPTOR, {productName: RuntimeConfig.productName});
	if (RuntimeConfig.symbolUrl) {
		return (
			<img
				{...getImageSizingProps(props)}
				src={RuntimeConfig.symbolUrl}
				alt={ariaLabel}
				data-flx={getDataFlx(props, 'ui.icons.fluxer-symbol.img')}
			/>
		);
	}
	// Echowire brand symbol (equalizer mark), monochrome via currentColor so it adapts to the theme.
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 200 200"
			role="img"
			aria-label={ariaLabel}
			data-flx="ui.icons.fluxer-symbol.img"
			{...props}
		>
			<g transform="translate(100,100)" fill="currentColor">
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
});
