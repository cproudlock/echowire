// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: starter message previews for forum posts and threads. The server includes
// `starter_message_preview` on thread list responses; the Channel model does not carry it, so the
// previews are kept here by thread id.

import {action, makeObservable, observable} from 'mobx';

export interface StarterMessagePreview {
	messageId: string;
	author: {id: string; username: string; globalName: string | null; avatar: string | null} | null;
	content: string;
	firstAttachment: {
		id: string;
		filename: string;
		url: string;
		proxyUrl: string | null;
		contentType: string | null;
		width: number | null;
		height: number | null;
	} | null;
}

export interface WireStarterMessagePreview {
	message_id: string;
	author: {id: string; username: string; global_name: string | null; avatar: string | null} | null;
	content: string;
	first_attachment: {
		id: string;
		filename: string;
		url: string;
		proxy_url: string | null;
		content_type: string | null;
		width: number | null;
		height: number | null;
	} | null;
}

export function fromWireStarterMessagePreview(wire: WireStarterMessagePreview): StarterMessagePreview {
	return {
		messageId: wire.message_id,
		author: wire.author
			? {
					id: wire.author.id,
					username: wire.author.username,
					globalName: wire.author.global_name,
					avatar: wire.author.avatar,
				}
			: null,
		content: wire.content,
		firstAttachment: wire.first_attachment
			? {
					id: wire.first_attachment.id,
					filename: wire.first_attachment.filename,
					url: wire.first_attachment.url,
					proxyUrl: wire.first_attachment.proxy_url,
					contentType: wire.first_attachment.content_type,
					width: wire.first_attachment.width,
					height: wire.first_attachment.height,
				}
			: null,
	};
}

export function isImageAttachment(attachment: StarterMessagePreview['firstAttachment']): boolean {
	if (!attachment) return false;
	if (attachment.contentType) return attachment.contentType.startsWith('image/');
	return /\.(png|jpe?g|gif|webp|avif)$/i.test(attachment.filename);
}

class ForumPostPreviews {
	private readonly byThread = observable.map<string, StarterMessagePreview | null>();

	constructor() {
		makeObservable(this);
	}

	// Undefined means the server has not sent a preview for this thread (older server or an event
	// payload); null means the starter message is gone.
	get(threadId: string): StarterMessagePreview | null | undefined {
		return this.byThread.get(threadId);
	}

	@action
	ingest(threads: ReadonlyArray<{id: string; starter_message_preview?: WireStarterMessagePreview | null}>): void {
		for (const thread of threads) {
			if (thread.starter_message_preview === undefined) continue;
			this.byThread.set(
				thread.id,
				thread.starter_message_preview ? fromWireStarterMessagePreview(thread.starter_message_preview) : null,
			);
		}
	}
}

export default new ForumPostPreviews();
