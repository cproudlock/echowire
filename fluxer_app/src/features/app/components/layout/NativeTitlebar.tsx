// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/app/components/layout/NativeTitlebar.module.css';
import {FluxerSymbol} from '@app/features/ui/components/icons/FluxerSymbol';
import {FluxerWordmark} from '@app/features/ui/components/icons/FluxerWordmark';
import {getElectronAPI, type NativePlatform} from '@app/features/ui/utils/NativeUtils';
import type React from 'react';
import {NativeWindowControls} from './NativeWindowControls';

interface NativeTitlebarProps {
	platform: NativePlatform;
}

export const NativeTitlebar: React.FC<NativeTitlebarProps> = ({platform}) => {
	const handleDoubleClick = () => {
		const electronApi = getElectronAPI();
		if (!electronApi?.windowMaximize) return;
		electronApi.windowMaximize();
	};
	return (
		<div
			role="group"
			className={styles.titlebar}
			onDoubleClick={handleDoubleClick}
			data-platform={platform}
			data-native-titlebar=""
			data-flx="app.native-titlebar.titlebar"
		>
			<div className={styles.left} data-flx="app.native-titlebar.left">
				<FluxerSymbol
					style={{width: '1rem', height: '1rem', flexShrink: 0}}
					data-flx="app.native-titlebar.symbol"
				/>
				<FluxerWordmark className={styles.wordmark} data-flx="app.native-titlebar.wordmark" />
			</div>
			<div className={styles.spacer} data-flx="app.native-titlebar.spacer" />
			<NativeWindowControls data-flx="app.native-titlebar.controls" />
		</div>
	);
};
