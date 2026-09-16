// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';

// Echowire: threads and forum posts are channel rows, so they carry their own ceiling. Only
// active (non-archived) threads count, so archiving frees room again.
export class MaxActiveThreadsError extends BadRequestError {
	constructor(maxThreads: number) {
		super({
			code: APIErrorCodes.MAX_ACTIVE_THREADS,
			messageVariables: {count: maxThreads},
		});
	}
}
