// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';

// Echowire: a thread or forum post holds a bounded member list, because every member of a private
// thread is carried to the gateway so it can scope that thread's events.
export class MaxThreadMembersError extends BadRequestError {
	constructor(maxMembers: number) {
		super({
			code: APIErrorCodes.MAX_THREAD_MEMBERS,
			messageVariables: {count: maxMembers},
		});
	}
}
