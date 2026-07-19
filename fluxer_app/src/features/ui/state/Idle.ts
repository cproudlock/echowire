// SPDX-License-Identifier: AGPL-3.0-or-later

import {IS_DEV} from '@app/features/platform/types/Env';
import LocalPresence from '@app/features/presence/state/LocalPresence';
import {makeAutoObservable} from 'mobx';

const IDLE_DURATION_MS = 1000 * (IS_DEV ? 10 : 60 * 10);
const IDLE_CHECK_INTERVAL_MS = Math.min(Math.floor(IDLE_DURATION_MS * 0.25), 30_000);
const SYSTEM_IDLE_RETRY_DELAY_MS = 60_000;

interface DesktopIdleApi {
	getSystemIdleTimeMs?: () => Promise<number>;
}

function getDesktopIdleApi(): Required<DesktopIdleApi> | null {
	const electronApi = (
		window as {
			electron?: DesktopIdleApi | null;
		}
	).electron;
	return typeof electronApi?.getSystemIdleTimeMs === 'function'
		? {getSystemIdleTimeMs: electronApi.getSystemIdleTimeMs.bind(electronApi)}
		: null;
}

function normalizeIdleTimeMs(value: number): number | null {
	if (!Number.isFinite(value) || value < 0) return null;
	return Math.floor(value);
}

class Idle {
	idle = false;
	private lastActivityTime = Date.now();
	private checkInterval: NodeJS.Timeout | null = null;
	private systemIdleCheckInFlight = false;
	private lastSystemIdleFailureAt = 0;
	private activityVersion = 0;
	private peakSystemIdleMs = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		this.startIdleCheck();
	}

	private startIdleCheck(): void {
		if (typeof setInterval !== 'function') return;
		this.checkInterval = setInterval(() => {
			this.updateIdleState();
		}, IDLE_CHECK_INTERVAL_MS);
	}

	destroy(): void {
		if (this.checkInterval !== null) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
	}

	recordActivity(): void {
		this.lastActivityTime = Date.now();
		this.activityVersion++;
		if (this.idle) {
			this.applyIdleState(false);
		}
	}

	markBackground(): void {
		this.lastActivityTime = 0;
		this.activityVersion++;
		this.applyIdleState(true);
	}

	isIdle(): boolean {
		return this.idle;
	}

	getIdleSince(): number {
		return this.idle ? this.lastActivityTime : 0;
	}

	getInactiveDurationMs(now = Date.now()): number {
		return Math.max(0, now - this.lastActivityTime);
	}

	private updateIdleState(): void {
		const desktopIdleApi = getDesktopIdleApi();
		if (desktopIdleApi && Date.now() - this.lastSystemIdleFailureAt >= SYSTEM_IDLE_RETRY_DELAY_MS) {
			void this.updateIdleStateFromSystem(desktopIdleApi);
			return;
		}
		this.updateIdleStateFromLocalActivity();
	}

	private updateIdleStateFromLocalActivity(): void {
		const now = Date.now();
		this.applyIdleState(this.getInactiveDurationMs(now) >= IDLE_DURATION_MS);
	}

	private async updateIdleStateFromSystem(desktopIdleApi: Required<DesktopIdleApi>): Promise<void> {
		if (this.systemIdleCheckInFlight) return;
		this.systemIdleCheckInFlight = true;
		const activityVersion = this.activityVersion;
		const requestedAt = Date.now();
		try {
			const idleTimeMs = normalizeIdleTimeMs(await desktopIdleApi.getSystemIdleTimeMs());
			if (idleTimeMs === null) {
				this.lastSystemIdleFailureAt = Date.now();
				this.updateIdleStateFromLocalActivity();
				return;
			}
			if (activityVersion !== this.activityVersion && this.lastActivityTime >= requestedAt) {
				return;
			}
			const now = Date.now();
			this.peakSystemIdleMs = Math.max(this.peakSystemIdleMs, idleTimeMs);
			// Electron's powerMonitor.getSystemIdleTime() is unreliable on some Linux
			// desktops (e.g. X11/Cinnamon), where the OS idle D-Bus path is missing and
			// it reports 0 even while the machine is genuinely idle. A raw 0 is finite,
			// so it never hits the null failure path above; the old code then clobbered
			// lastActivityTime back to "now" every poll, pinning the user active forever
			// -> never away, never push-eligible. Detect a dead source: if the OS idle
			// clock has NEVER advanced near the threshold this whole session yet we have
			// gone a full idle window with no in-app activity, trust our own inactivity
			// instead. Clients where the OS idle clock works (it has reached the
			// threshold at least once) keep the exact original behavior.
			const localInactivityMs = this.getInactiveDurationMs(now);
			const systemIdleSourceIsBroken =
				this.peakSystemIdleMs < IDLE_DURATION_MS && localInactivityMs >= IDLE_DURATION_MS;
			if (systemIdleSourceIsBroken) {
				this.applyIdleState(true);
				return;
			}
			this.lastActivityTime = Math.max(0, now - idleTimeMs);
			this.applyIdleState(idleTimeMs >= IDLE_DURATION_MS);
		} catch {
			this.lastSystemIdleFailureAt = Date.now();
			this.updateIdleStateFromLocalActivity();
		} finally {
			this.systemIdleCheckInFlight = false;
		}
	}

	private applyIdleState(idle: boolean): void {
		if (idle !== this.idle) {
			this.idle = idle;
			LocalPresence.updatePresence();
		}
	}
}

export default new Idle();
