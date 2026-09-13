// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ILogger} from '@app/api/ILogger';
import {ClientErrorAbuseSignalMiddleware} from '@app/api/middleware/AbusiveIpAutoBanner';
import {AuditLogMiddleware} from '@app/api/middleware/AuditLogMiddleware';
import {ConcurrencyLimitMiddleware} from '@app/api/middleware/ConcurrencyLimitMiddleware';
import ContentFilterMiddleware from '@app/api/middleware/ContentFilterMiddleware';
import {GuildAvailabilityMiddleware} from '@app/api/middleware/GuildAvailabilityMiddleware';
import {IpBanMiddleware} from '@app/api/middleware/IpBanMiddleware';
import {LocaleMiddleware} from '@app/api/middleware/LocaleMiddleware';
import {RequestCacheMiddleware} from '@app/api/middleware/RequestCacheMiddleware';
import {RequireClientIpMiddleware} from '@app/api/middleware/RequireClientIpMiddleware';
import {ServiceMiddleware} from '@app/api/middleware/ServiceMiddleware';
import {TorExitMiddleware} from '@app/api/middleware/TorExitMiddleware';
import {TrustedClientIpHeaderMiddleware} from '@app/api/middleware/TrustedClientIpHeaderMiddleware';
import {UserMiddleware} from '@app/api/middleware/UserMiddleware';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Headers as HttpHeaders} from '@fluxer/constants/src/Headers';
import {InvalidApiOriginError} from '@fluxer/errors/src/domains/core/InvalidApiOriginError';
import {cors} from '@fluxer/hono/src/middleware/Cors';
import {applyMiddlewareStack} from '@fluxer/hono/src/middleware/MiddlewareStack';
import {createInfoRequestLogger, requestLogger} from '@fluxer/hono/src/middleware/RequestLogger';
import {resolveClientIpHeaderName} from '@fluxer/ip_utils/src/ClientIp';

interface MiddlewarePipelineOptions {
	logger: ILogger;
	nodeEnv: string;
	corsOrigins: Array<string>;
	trustClientIpHeader: boolean;
	clientIpHeaderName?: string;
	maxInflightRequests: number;
}

export function configureMiddleware(routes: HonoApp, options: MiddlewarePipelineOptions): void {
	const {logger, nodeEnv, corsOrigins, trustClientIpHeader, clientIpHeaderName, maxInflightRequests} = options;
	const resolvedHeader = resolveClientIpHeaderName(clientIpHeaderName);
	routes.use('/webhooks/:webhook_id/:token', cors({origins: '*'}));
	routes.use('/webhooks/:webhook_id/:token/messages/:message_id', cors({origins: '*'}));
	applyMiddlewareStack(routes, {
		requestId: {},
		cors: {
			origins: corsOrigins,
			allowedHeaders: [
				HttpHeaders.CONTENT_TYPE,
				HttpHeaders.AUTHORIZATION,
				'X-Requested-With',
				'Accept-Language',
				HttpHeaders.X_REQUEST_ID,
				HttpHeaders.IF_NONE_MATCH,
			],
			exposedHeaders: [HttpHeaders.X_FLUXER_VERSION, HttpHeaders.ETAG],
		},
		skipLogger: true,
		skipErrorHandler: true,
	});
	routes.use(ConcurrencyLimitMiddleware({maxInflightRequests}));
	routes.get('/_health', async (ctx) => ctx.text('OK'));
	routes.use(IpBanMiddleware);
	routes.use(
		requestLogger({
			log: createInfoRequestLogger(logger),
			skip: ['/_health'],
		}),
	);
	routes.use(ClientErrorAbuseSignalMiddleware);
	routes.use(RequestCacheMiddleware);
	if (nodeEnv === 'production') {
		routes.use('*', async (ctx, next) => {
			const host = ctx.req.header('host');
			if (ctx.req.method !== 'GET' && (host === 'web.fluxer.app' || host === 'web.canary.fluxer.app')) {
				const origin = ctx.req.header('origin');
				if (!origin || origin !== `https://${host}`) {
					throw new InvalidApiOriginError();
				}
			}
			await next();
		});
	}
	if (trustClientIpHeader) {
		routes.use(
			TrustedClientIpHeaderMiddleware({
				enabled: true,
				logger,
				trustClientIpHeader,
				clientIpHeaderName: resolvedHeader,
			}),
		);
	}
	routes.use(TorExitMiddleware);
	routes.use(AuditLogMiddleware);
	// Echowire: upstream reworked RequireClientIpMiddleware to take {exemptPaths}
	// and resolve the client IP from Config.proxy.client_ip_header (single header)
	// instead of the old requiredHeaders list. Our ingress is
	// Cloudflare -> NetBird -> Caddy (client IP = cf-connecting-ip), but internal
	// service calls (app-proxy discovery via caddy:8088) carry only x-forwarded-for.
	// TODO(echowire): verify those internal calls are not 403d; if they are, add
	// their paths to exemptPaths rather than reinstating a broad header fallback.
	routes.use(RequireClientIpMiddleware());
	routes.use(ServiceMiddleware);
	routes.use(UserMiddleware);
	routes.use(ContentFilterMiddleware);
	routes.use(GuildAvailabilityMiddleware);
	routes.use(LocaleMiddleware);
}
