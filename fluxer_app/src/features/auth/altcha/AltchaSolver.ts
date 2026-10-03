// SPDX-License-Identifier: AGPL-3.0-or-later

import {solveChallengeWorkers} from 'altcha-lib';
import type {Challenge} from 'altcha-lib/types';

export type AltchaChallenge = Challenge;

const MAX_SOLVER_WORKERS = 8;
const SOLVE_TIMEOUT_MS = 60_000;

function createSolverWorker(): Worker {
	return new Worker(
		new URL(/* webpackChunkName: "altcha-solver.worker" */ './AltchaSolverWorker.ts', import.meta.url),
		{
			type: 'module',
		},
	);
}

export function readAltchaChallenge(body: unknown): AltchaChallenge | null {
	if (typeof body !== 'object' || body === null) return null;
	// Echowire: upstream also required captcha_provider to read altcha here. This
	// fork serves hCaptcha or Turnstile to the mobile clients already on the stores,
	// which cannot solve ALTCHA, so captcha_provider names the provider offered to
	// them while every challenge still carries an ALTCHA challenge for this app. The
	// presence of a well-formed challenge is what makes it solvable, not the name the
	// instance reports to other clients. See docs/adr/0008.
	const {altcha_challenge: challenge} = body as Record<string, unknown>;
	if (typeof challenge !== 'object' || challenge === null) return null;
	const {parameters, signature} = challenge as Record<string, unknown>;
	if (typeof parameters !== 'object' || parameters === null || typeof signature !== 'string') return null;
	return challenge as AltchaChallenge;
}

export async function solveAltchaChallenge(challenge: AltchaChallenge): Promise<string | null> {
	const solution = await solveChallengeWorkers({
		challenge,
		concurrency: Math.min(MAX_SOLVER_WORKERS, navigator.hardwareConcurrency || 2),
		createWorker: createSolverWorker,
		timeout: SOLVE_TIMEOUT_MS,
	});
	if (!solution) return null;
	return btoa(
		JSON.stringify({challenge: {parameters: challenge.parameters, signature: challenge.signature}, solution}),
	);
}
