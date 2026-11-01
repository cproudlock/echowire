// SPDX-License-Identifier: AGPL-3.0-or-later

// A tiny HTTP server for the gate self-test: answers like a healthy instance and prints its port.
import http from 'node:http';

const server = http.createServer((req, res) => {
	if (req.url === '/.well-known/fluxer') {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({endpoints: {api: 'x', gateway: 'y'}}));
		return;
	}
	res.statusCode = req.url === '/_health' || req.url === '/api/v1/_health' ? 200 : 404;
	res.end('OK');
});
server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port);
});
