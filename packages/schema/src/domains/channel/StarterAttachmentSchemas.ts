// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: "add to post". Not in upstream. See docs/upstream-divergence.md.

import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {withSchemaMetadata} from '@fluxer/schema/src/SchemaMetadata';
import {z} from 'zod';

export const StarterAttachmentRequest = withSchemaMetadata(
	z.object({
		message_id: SnowflakeType.describe('A message in this post that carries the attachment'),
		attachment_id: SnowflakeType.describe('The attachment to append to the first message of the post'),
	}),
	{experiment: 'channel_threads'},
);

export type StarterAttachmentRequest = z.infer<typeof StarterAttachmentRequest>;
