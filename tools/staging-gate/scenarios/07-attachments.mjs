// SPDX-License-Identifier: AGPL-3.0-or-later

import {check, checkStatus} from '../lib/ctx.mjs';

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

export const name = 'attachment upload, download and range through the media proxy';

export async function run(ctx) {
	const user = ctx.state.userA;
	check(ctx.state.textChannelId, 'no text channel from scenario 05');
	const form = new FormData();
	form.append('payload_json', JSON.stringify({content: 'with file', attachments: [{id: 0, filename: 'gate.png'}]}));
	form.append('files[0]', new Blob([PNG], {type: 'image/png'}), 'gate.png');
	const up = await ctx.http('POST', `/api/v1/channels/${ctx.state.textChannelId}/messages`, {
		headers: {authorization: user.token},
		body: form,
	});
	checkStatus(up, 200, 'upload attachment');
	const url = up.json?.attachments?.[0]?.url;
	check(url, 'upload returned no attachment url');

	const down = await ctx.http('GET', url);
	checkStatus(down, 200, 'download attachment');
	check(down.buffer.equals(PNG), `downloaded bytes differ from the upload (${down.buffer.length} vs ${PNG.length})`);
	check(/image\/png/.test(down.headers.get('content-type') ?? ''), 'download is not served as image/png');

	const range = await ctx.http('GET', url, {headers: {range: 'bytes=0-9'}});
	checkStatus(range, 206, 'range request');
	check(range.buffer.length === 10, `range returned ${range.buffer.length} bytes, wanted 10`);
	check(/^bytes 0-9\//.test(range.headers.get('content-range') ?? ''), 'range response has no content-range');
	return `${PNG.length} bytes up, same bytes down, 206 for bytes=0-9`;
}
