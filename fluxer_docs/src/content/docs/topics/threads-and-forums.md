---
# SPDX-License-Identifier: AGPL-3.0-or-later
title: Threads and forums
description: Thread channels, forum channels, their lifecycle, and how access is resolved.
---

A thread is a channel that hangs under a text or forum channel and holds a side conversation. A
forum channel holds nothing but threads: every post in a forum is a thread whose parent is the
forum. Both are ordinary channels elsewhere in the api, addressed by their own channel ID, so the
[Channels resource](/http-api/channels/) defines every per-thread operation.

## How a client learns about threads

One route answers the question of which threads a caller may see:
`GET /v1/guilds/{guild_id}/threads/active`. It returns the open threads and forum posts of a guild
that the caller may view, each with a starter message preview, together with the caller's own
memberships. It is the authoritative load, called when a guild is opened and again when access to
a channel arrives. Everything else either feeds that answer or narrows it.

Ready is the fast first paint. Its guild payload carries the guild's channels, open threads
included, and `thread_members` for the caller. It carries no starter previews, and no archived
threads: every archived thread a member could ever view would otherwise ride along and grow
without bound as a forum ages.

Live changes arrive as [Thread Create](/gateway/events/#thread-create),
[Thread Update](/gateway/events/#thread-update), [Thread Delete](/gateway/events/#thread-delete)
and [Thread Members Update](/gateway/events/#thread-members-update), one change each, once a client
has loaded.

Two routes narrow the picture. The archived threads of one parent, paged, come from
`GET /v1/channels/{channel_id}/threads/archived`, which is how history in a single channel is
browsed. A single channel comes from `GET /v1/channels/{channel_id}`, which is how a link that
points at a thread the session payload does not carry recovers, an archived one in practice.

There is no thread list event. When a role change or a channel overwrite makes a parent visible,
[Channel Create](/gateway/events/#channel-create) announces the parent and the client reloads the
route above, rather than a second mechanism reporting its own answer to the same question.

## Channel types

| Type | Name | What it is |
| --- | --- | --- |
| 11 | Public thread | A thread anyone who can view the parent channel can read and join |
| 12 | Private thread | A thread only its members and parent moderators can read |
| 15 | Forum | A channel whose children are posts, and which stores no messages of its own |

## Access

A thread stores no permission overwrites. Its permissions are always resolved from its parent
channel, so denying `VIEW_CHANNEL` on a text channel hides every thread beneath it. A thread whose
parent has been deleted resolves to no access at all and is never returned or dispatched.

A private thread adds a membership test on top of that: the caller must be a member of the thread,
or hold [MANAGE_CHANNELS](/http-api/permissions/) on the parent. The same rule governs the gateway,
so a session that cannot view a private thread receives no events for it.

Moderation of a thread, meaning lock, unlock, pin, and unarchiving a locked thread, requires
`MANAGE_CHANNELS` on the parent. The thread's owner may rename it, retag it, change its
auto-archive duration, and close or reopen it while it is unlocked. There are no thread-specific
permission bits; creating a thread takes `VIEW_CHANNEL` and `SEND_MESSAGES` on the parent.

## Lifecycle

- **Create.** [Create a thread](/http-api/channels/#create-a-thread) makes a thread under a text or
  forum channel. Started from a message, a public thread adopts that message's ID so the message can
  render an inline link to it; a private thread never adopts one.
- **Activity.** `message_count` counts the messages in the thread, excluding a forum post's opening
  message, and `last_message_id` is the newest message. Sort by the later of the thread ID and
  `last_message_id` for a recent-activity order.
- **Archive.** A thread archives after `thread_metadata.auto_archive_duration` minutes without a
  message, one of 60, 1440, 4320, or 10080. Sending a message into an archived thread reopens it,
  unless it is locked, in which case only a moderator's message reopens it. Every archive change
  emits [Thread Update](/gateway/events/#thread-update).
- **Lock.** A locked thread rejects messages from anyone without `MANAGE_CHANNELS` on the parent,
  and stays archived until a moderator reopens it.
- **Delete.** Deleting a thread deletes its messages, attachments, search documents, and membership
  rows. Deleting a text or forum channel deletes the threads under it the same way.

## Membership

Membership decides who is notified and, for a private thread, who has access at all. The creator of
a thread joins it, and so does anyone who sends a message in it. A member receives a notification
for every message in the thread; a non-member is notified only when mentioned. Members can be
listed, and the caller can join or leave, through the
[thread member routes](/http-api/channels/#list-thread-members). There is no route for adding
another user to a thread, so a private thread contains its creator and the moderators who can see
it.

## Forum channels

A forum channel carries the settings its posts inherit:

- `available_tags` is the set of tags a post may apply, at most 20, and `require_tag` decides
  whether a post must apply one.
- `default_reaction_emoji` is the reaction shown by default on posts.
- `default_sort_order` is the default post ordering, latest activity or creation, and
  `default_forum_layout` is the default layout, list or gallery. Both are defaults a client may
  override per viewer.
- `default_auto_archive_duration` and `default_thread_rate_limit_per_user` are the auto-archive
  duration and the slowmode a new post inherits.
- `rate_limit_per_user` on the forum itself limits how often a member may create a post.

One post per forum may be pinned. Pinning another moves the pin, so pinning is never additive.

Thread list responses carry a
[starter message preview](/http-api/channels/#starter-message-preview-object) for each post, which
is what a client renders as the post's excerpt and thumbnail.

## Gateway events

| Event | When |
| --- | --- |
| [THREAD_CREATE](/gateway/events/#thread-create) | A thread was created |
| [THREAD_UPDATE](/gateway/events/#thread-update) | A thread was renamed, archived, locked, pinned, retagged, or given a new auto-archive duration |
| [THREAD_DELETE](/gateway/events/#thread-delete) | A thread was deleted |
| [THREAD_MEMBERS_UPDATE](/gateway/events/#thread-members-update) | Someone joined or left a thread |

Every one of these is scoped to the sessions that can view the thread. There is no thread list sync
event: a client loads its threads with
[List active guild threads](/http-api/guild-channels/#list-active-guild-threads) on guild select,
and per channel with [List active threads](/http-api/channels/#list-active-threads).

## Limitations

- A webhook cannot post into a thread or a forum. Webhooks target text and voice channels only.
- There is no route for adding or removing another user's thread membership.
- A thread has no member limit, and a forum has no post limit beyond the guild's channel limit.
