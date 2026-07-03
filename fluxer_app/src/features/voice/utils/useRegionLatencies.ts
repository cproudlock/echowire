// SPDX-License-Identifier: AGPL-3.0-or-later

import {useEffect, useState} from 'react';

export const LATENCY_PING_TIMEOUT_MS = 4000;

interface RegionWithPingEndpoint {
	id: string;
	ping_endpoint: string | null;
}

/**
 * Echowire: measures round-trip latency to each region's `ping_endpoint` (a CORS-enabled `/ping` on
 * the voice host). Times a single `fetch` with `performance.now()`, all regions in parallel, with a
 * timeout so an unreachable host yields `null` instead of hanging. Re-runs only when the region list
 * changes. Shared by the in-call VoiceRegionSelector and the channel-settings RtcRegionSelect.
 */
export function useRegionLatencies(regions: Array<RegionWithPingEndpoint>): Map<string, number | null> {
	const [latencies, setLatencies] = useState<Map<string, number | null>>(new Map());
	useEffect(() => {
		if (regions.length === 0) {
			setLatencies(new Map());
			return undefined;
		}
		let cancelled = false;
		const controllers: Array<AbortController> = [];
		const measure = async (region: RegionWithPingEndpoint): Promise<[string, number | null]> => {
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
			if (!cancelled) {
				setLatencies(new Map(results));
			}
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

/** Echowire: color thresholds shared by latency badges (green < 80ms, yellow < 150ms, red otherwise). */
export function latencyColor(latency: number): string {
	return latency < 80 ? 'var(--status-online)' : latency < 150 ? 'var(--status-idle)' : 'var(--status-dnd)';
}
