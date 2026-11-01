// SPDX-License-Identifier: AGPL-3.0-or-later

export const name = 'planted failure (the gate must report this as FAIL)';

export function run() {
	throw new Error('planted failure');
}
