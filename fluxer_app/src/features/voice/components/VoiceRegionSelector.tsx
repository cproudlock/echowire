// SPDX-License-Identifier: AGPL-3.0-or-later

import * as EmojiUtils from '@app/features/expressions/utils/EmojiUtils';
import {Logger} from '@app/features/platform/utils/AppLogger';
import type {ComboboxOption} from '@app/features/ui/components/form/FormCombobox';
import {Combobox as FormCombobox} from '@app/features/ui/components/form/FormCombobox';
import * as CallCommands from '@app/features/voice/commands/CallCommands';
import styles from '@app/features/voice/components/VoiceRegionSelector.module.css';
import {AUTOMATIC_VOICE_REGION_ID} from '@fluxer/constants/src/ChannelConstants';
import type {RtcRegionResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {useCallback, useEffect, useMemo, useState} from 'react';

const AUTOMATIC_DESCRIPTOR = msg({
	message: 'Automatic',
	comment: "Voice region picker option label meaning 'let Fluxer pick the best region automatically'.",
});
const logger = new Logger('VoiceRegionSelector');

const LATENCY_PING_TIMEOUT_MS = 4000;

/**
 * Measures round-trip latency to each region's `ping_endpoint` (a CORS-enabled `/ping` on the voice
 * host). Times a single `fetch` with `performance.now()`, all regions in parallel, with a timeout so
 * an unreachable host yields `null` instead of hanging. Re-runs only when the region list changes.
 */
function useRegionLatencies(regions: Array<RtcRegionResponse>): Map<string, number | null> {
	const [latencies, setLatencies] = useState<Map<string, number | null>>(new Map());
	useEffect(() => {
		if (regions.length === 0) {
			setLatencies(new Map());
			return undefined;
		}
		let cancelled = false;
		const controllers: Array<AbortController> = [];
		const measure = async (region: RtcRegionResponse): Promise<[string, number | null]> => {
			if (!region.ping_endpoint) {
				return [region.id, null];
			}
			const controller = new AbortController();
			controllers.push(controller);
			const timeout = setTimeout(() => controller.abort(), LATENCY_PING_TIMEOUT_MS);
			try {
				const start = performance.now();
				await fetch(region.ping_endpoint, {cache: 'no-store', signal: controller.signal});
				return [region.id, Math.round(performance.now() - start)];
			} catch {
				return [region.id, null];
			} finally {
				clearTimeout(timeout);
			}
		};
		Promise.all(regions.map(measure)).then((results) => {
			if (!cancelled) setLatencies(new Map(results));
		});
		return () => {
			cancelled = true;
			for (const controller of controllers) {
				controller.abort();
			}
		};
	}, [regions]);
	return latencies;
}

function LatencyBadge({latency}: {latency: number | null | undefined}) {
	if (latency == null) {
		return null;
	}
	const color = latency < 80 ? 'var(--status-online)' : latency < 150 ? 'var(--status-idle)' : 'var(--status-dnd)';
	return (
		<span className={styles.latencyBadge} style={{color}} data-flx="voice.voice-region-selector.latency-badge">
			{latency}ms
		</span>
	);
}

interface VoiceRegionSelectorProps {
	channelId?: string | null;
	currentRegion?: string | null;
	compact?: boolean;
}

interface RtcRegionOption extends ComboboxOption<string> {
	region: RtcRegionResponse;
}

export function VoiceRegionSelector({channelId, currentRegion, compact = false}: VoiceRegionSelectorProps) {
	const {i18n} = useLingui();
	const [regions, setRegions] = useState<Array<RtcRegionResponse>>([]);
	const [isChangingRegion, setIsChangingRegion] = useState(false);
	const latencies = useRegionLatencies(regions);
	useEffect(() => {
		if (!channelId) {
			setRegions([]);
			return undefined;
		}
		let cancelled = false;
		CallCommands.fetchCallRegions(channelId)
			.then((fetchedRegions) => {
				if (!cancelled) setRegions(fetchedRegions);
			})
			.catch(() => {
				if (!cancelled) setRegions([]);
			});
		return () => {
			cancelled = true;
		};
	}, [channelId]);
	const getRegionDisplayName = useCallback(
		(regionId: string, regionName: string): string => {
			if (regionId === AUTOMATIC_VOICE_REGION_ID) {
				return i18n._(AUTOMATIC_DESCRIPTOR);
			}
			if (regionName && regionName !== regionId) {
				return regionName;
			}
			return regionId
				.split('-')
				.map((part) => {
					const lower = part.toLowerCase();
					if (lower === 'us') return 'US';
					if (lower === 'eu') return 'EU';
					return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
				})
				.join(' ');
		},
		[i18n],
	);
	const options = useMemo<Array<RtcRegionOption>>(() => {
		const automaticRegion = regions.find((r) => r.id === AUTOMATIC_VOICE_REGION_ID);
		const otherRegions = regions.filter((r) => r.id !== AUTOMATIC_VOICE_REGION_ID);
		const automatic: RtcRegionOption = {
			value: AUTOMATIC_VOICE_REGION_ID,
			label: i18n._(AUTOMATIC_DESCRIPTOR),
			region: automaticRegion ?? {id: AUTOMATIC_VOICE_REGION_ID, name: 'Automatic', emoji: '🌐', ping_endpoint: null},
		};
		const regionOptions = otherRegions
			.map((region) => ({
				value: region.id,
				label: getRegionDisplayName(region.id, region.name),
				region,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
		return [automatic, ...regionOptions];
	}, [getRegionDisplayName, regions, i18n.locale]);
	const displayName = useMemo(() => {
		const effectiveRegion = currentRegion ?? AUTOMATIC_VOICE_REGION_ID;
		if (effectiveRegion === AUTOMATIC_VOICE_REGION_ID) return i18n._(AUTOMATIC_DESCRIPTOR);
		const regionData = regions.find((region) => region.id === effectiveRegion);
		if (regionData) return getRegionDisplayName(regionData.id, regionData.name);
		return effectiveRegion;
	}, [currentRegion, getRegionDisplayName, regions, i18n.locale]);
	const selectDensity = compact ? 'compactOverlay' : 'default';
	const handleRegionSelect = useCallback(
		async (regionId: string) => {
			if (!channelId || isChangingRegion) return;
			setIsChangingRegion(true);
			try {
				await CallCommands.updateCallRegion(channelId, regionId);
			} catch (error) {
				logger.error('Failed to update region:', error);
			} finally {
				setIsChangingRegion(false);
			}
		},
		[channelId, isChangingRegion],
	);
	const selectedValue = useMemo(() => {
		const effectiveRegion = currentRegion ?? AUTOMATIC_VOICE_REGION_ID;
		return options.some((option) => option.value === effectiveRegion) ? effectiveRegion : AUTOMATIC_VOICE_REGION_ID;
	}, [currentRegion, options]);
	const renderRegionOption = useCallback(
		(option: RtcRegionOption) => {
			const latency = latencies.get(option.region.id);
			if (compact) {
				return (
					<>
						<span
							className={clsx(styles.regionName, styles.regionNameCompact)}
							data-flx="voice.voice-region-selector.render-region-option.region-name"
						>
							{option.label}
						</span>
						<LatencyBadge latency={latency} />
					</>
				);
			}
			const emojiUrl = EmojiUtils.getEmojiURL(option.region.emoji);
			return (
				<div className={styles.regionOption} data-flx="voice.voice-region-selector.render-region-option.region-option">
					{emojiUrl ? (
						<img
							src={emojiUrl}
							alt={option.label}
							aria-hidden={true}
							className={styles.regionEmoji}
							data-flx="voice.voice-region-selector.render-region-option.region-emoji"
						/>
					) : (
						<span
							className={styles.regionEmojiText}
							data-flx="voice.voice-region-selector.render-region-option.region-emoji-text"
						>
							{option.region.emoji}
						</span>
					)}
					<span
						className={clsx(styles.regionName, compact && styles.regionNameCompact)}
						data-flx="voice.voice-region-selector.render-region-option.region-name--2"
					>
						{option.label}
					</span>
					<LatencyBadge latency={latency} />
				</div>
			);
		},
		[compact, latencies],
	);
	return (
		<div
			className={clsx(styles.regionSelectorContainer, compact && styles.regionSelectorContainerCompact)}
			data-flx="voice.voice-region-selector.region-selector-container"
		>
			<FormCombobox<string, false, RtcRegionOption>
				value={selectedValue}
				options={options}
				onChange={handleRegionSelect}
				disabled={regions.length === 0 || isChangingRegion}
				isSearchable={false}
				closeMenuOnSelect={true}
				menuPlacement="bottom"
				maxMenuHeight={compact ? 140 : 220}
				placeholder={displayName}
				density={selectDensity}
				className={compact ? styles.selectCompact : styles.select}
				renderOption={(option) => renderRegionOption(option)}
				renderValue={(option) => (option ? renderRegionOption(option as RtcRegionOption) : null)}
				data-flx="voice.voice-region-selector.select-compact.region-select"
			/>
		</div>
	);
}
