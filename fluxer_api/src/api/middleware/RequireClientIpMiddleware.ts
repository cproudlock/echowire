// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {Logger} from '@app/api/Logger';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {getRequestClientIp} from '@app/api/utils/RequestClientIp';
import {stripApiPrefix} from '@app/api/utils/RequestPathUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ForbiddenError} from '@fluxer/errors/src/domains/core/ForbiddenError';
import {createMiddleware} from 'hono/factory';

interface RequireClientIpOptions {
	exemptPaths?: Array<string>;
}

const defaultExemptPaths: Array<string> = [
	'/_health',
	'/internal',
	'/webhooks/livekit',
	'/test',
	'/connections/bluesky/client-metadata.json',
	'/connections/bluesky/jwks.json',
	// Echowire: the app-proxy discovery cache fetches /.well-known/fluxer internally (via
	// caddy:8088) carrying only x-forwarded-for, not the configured client-IP
	// header, so it would 403. Discovery is a public instance-info document, safe
	// to exempt. (Replaces the fork's old requiredHeaders x-forwarded-for fallback.)
	'/.well-known/fluxer',
];

export function RequireClientIpMiddleware({exemptPaths = defaultExemptPaths}: RequireClientIpOptions = {}) {
	return createMiddleware<HonoEnv>(async (ctx, next) => {
		if (Config.dev.testModeEnabled) {
			await next();
			return;
		}
		const path = stripApiPrefix(ctx.req.path);
		if (exemptPaths.some((prefix) => path === prefix || path.startsWith(prefix))) {
			await next();
			return;
		}
		if (getRequestClientIp(ctx) === null) {
			Logger.warn({path}, 'Rejected request without a resolvable client IP');
			throw new ForbiddenError({code: APIErrorCodes.FORBIDDEN});
		}
		await next();
	});
}
