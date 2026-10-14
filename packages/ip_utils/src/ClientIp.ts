// SPDX-License-Identifier: AGPL-3.0-or-later

import {canonicalizeIpAddress} from '@fluxer/ip_utils/src/IpAddress';

interface ClientIpExtractionOptions {
	trustClientIpHeader?: boolean;
	clientIpHeaderName?: string;
	peerAddress?: string | null;
}

export class MissingClientIpError extends Error {
	readonly code = 'FORBIDDEN';
	readonly status = 403;

	constructor() {
		super('Client IP is required');
		this.name = 'MissingClientIpError';
	}
}

const DEFAULT_CLIENT_IP_HEADER_NAME = 'x-forwarded-for';

function normalizeHeaderName(headerName: string): string {
	return headerName.trim().toLowerCase();
}

export function resolveClientIpHeaderName(clientIpHeaderName?: string): string {
	return normalizeHeaderName(clientIpHeaderName ?? DEFAULT_CLIENT_IP_HEADER_NAME);
}

export function extractClientIp(req: Request, options?: ClientIpExtractionOptions): string | null {
	if (!options?.trustClientIpHeader) {
		return options?.peerAddress ? canonicalizeIpAddress(options.peerAddress) : null;
	}
	const headerName = resolveClientIpHeaderName(options.clientIpHeaderName);
	let headerValue = req.headers.get(headerName);
	// Echowire: fall back to x-forwarded-for when the primary header is absent.
	// Our ingress is Cloudflare -> NetBird frontend -> Caddy, so external requests
	// carry the real client in cf-connecting-ip, but internal service-to-service
	// calls (app-proxy discovery, admin -> api, etc.) only carry x-forwarded-for.
	// Without this fallback, requireClientIp throws (500) on every internal call.
	// The fallback covers an ABSENT configured header only. A header that is present
	// but malformed is a misconfigured or hostile edge, so it keeps upstream's
	// rejection rather than quietly trusting x-forwarded-for instead.
	const fallbackHeaderName = 'x-forwarded-for';
	if (headerValue === null && headerName !== fallbackHeaderName) {
		headerValue = req.headers.get(fallbackHeaderName);
	}
	return headerValue === null ? null : canonicalizeIpAddress(headerValue.split(',', 1)[0]);
}

export function requireClientIp(req: Request, options?: ClientIpExtractionOptions): string {
	const ip = extractClientIp(req, options);
	if (!ip) {
		throw new MissingClientIpError();
	}
	return ip;
}
