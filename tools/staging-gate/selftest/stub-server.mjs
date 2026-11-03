// SPDX-License-Identifier: AGPL-3.0-or-later

// A tiny HTTP server for the gate self-test: answers like a healthy instance and prints its port.
//   stub-server.mjs [--wrong-api-public] [--help-500]
// --wrong-api-public  serves a discovery document whose api_public points somewhere else
// --help-500          answers /help with a 500 (a marketing container that is up but broken)
import http from 'node:http';

const wrongApiPublic = process.argv.includes('--wrong-api-public');
const help500 = process.argv.includes('--help-500');
const PAGES = new Set(['/help', '/download', '/press', '/reverb', '/docs/']);

const server = http.createServer((req, res) => {
	if (req.url === '/.well-known/fluxer') {
		const own = `http://${req.headers.host}/api`;
		res.setHeader('content-type', 'application/json');
		res.end(
			JSON.stringify({
				endpoints: {
					api: own,
					api_client: own,
					api_public: wrongApiPublic ? 'https://wrong.example/api' : own,
					gateway: 'y',
				},
				age_policy: {geos: []},
				voice_origins: [],
				captcha: {provider: 'none'},
			}),
		);
		return;
	}
	if (req.url === '/docs') {
		res.statusCode = 301;
		res.setHeader('location', '/docs/');
		res.end();
		return;
	}
	if (help500 && req.url === '/help') {
		// an error page that still has a <title>, so only the status check can catch it
		res.statusCode = 500;
		res.setHeader('content-type', 'text/html');
		res.end('<html><head><title>stub page</title></head><body>Internal Server Error</body></html>');
		return;
	}
	if (PAGES.has(req.url)) {
		res.setHeader('content-type', 'text/html');
		res.end('<html><head><title>stub page</title></head><body>ok</body></html>');
		return;
	}
	res.statusCode = req.url === '/_health' || req.url === '/api/v1/_health' ? 200 : 404;
	res.end('OK');
});
server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port);
});
