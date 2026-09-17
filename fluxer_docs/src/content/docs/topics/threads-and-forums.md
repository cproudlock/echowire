---
# SPDX-License-Identifier: AGPL-3.0-or-later
title: Threads and forums
description: Thread channels, forum channels, their lifecycle, and how access is resolved.
---

A thread is a channel that hangs under a text or forum channel and holds a side conversation. A
forum channel holds nothing but threads: every post in a forum is a thread whose parent is the
forum. Both are ordinary channels elsewhere in the api, addressed by their own channel ID, so the
[Channels resource](/http-api/channels/) defines every per-thread operation.

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
or hold [MANAGE_THREADS](/http-api/permissions/) or `MANAGE_CHANNELS` on the parent. The same rule
governs the gateway, so a session that cannot view a private thread receives no events for it.

## Permissions

Four permissions govern threads, at the same bit positions Discord uses, so a permission integer
means the same thing on both platforms. Each is resolved against the thread's **parent** channel,
honouring that channel's overwrites.

| Action | Permission |
| --- | --- |
| Create a public thread, or a forum post | `CREATE_PUBLIC_THREADS` |
| Create a private thread | `CREATE_PRIVATE_THREADS` |
| Send a message inside a thread or post | `SEND_MESSAGES_IN_THREADS` |
| Lock, unlock, pin, unpin, or set invitable | `MANAGE_THREADS` |
| Archive, rename, retag, or delete another member's thread | `MANAGE_THREADS` |
| Edit a locked thread | `MANAGE_THREADS` |
| Apply or remove a moderated forum tag | `MANAGE_THREADS` |

Every action also needs `VIEW_CHANNEL` on the parent channel. `MANAGE_CHANNELS` is accepted
everywhere `MANAGE_THREADS` is, permanently rather than as a fallback, because it already implies
control of the parent channel. A member who can moderate threads may also create a private thread
without holding `CREATE_PRIVATE_THREADS`. A moderated tag is one a forum marks with `moderated` on
its [forum tag object](/http-api/channels/#forum-tag-object).

Posting inside a thread checks `SEND_MESSAGES_IN_THREADS`, not the parent's `SEND_MESSAGES`, so a
member can be allowed to talk in threads without talking in the channel, or the other way round.
Every other permission inside a thread resolves against the parent unchanged, so `ATTACH_FILES` or
`EMBED_LINKS` denied on the parent is denied in its threads.

`MANAGE_THREADS` is an [elevated permission](/http-api/permissions/#elevated-permissions), so a
guild with an elevated MFA level requires an enrolled authenticator to use it.

The owner of a thread may rename it, retag it, change its auto-archive duration, and close or reopen
it, while it is unlocked and without holding any of the four. Locking, pinning, changing invitable,
and any edit at all to a locked thread are for moderators.

### Guilds created before these bits existed

A resolved permission mask carrying none of the four thread bits belongs to a role set written
before they existed, and keeps the older behaviour: `SEND_MESSAGES` on the parent stands in for
`CREATE_PUBLIC_THREADS` and `SEND_MESSAGES_IN_THREADS`, and `MANAGE_CHANNELS` for `MANAGE_THREADS`.
Creating a private thread has no such fallback, because no client offered one before the bits
existed.

As soon as any thread bit appears anywhere in the resolution chain, the bits are authoritative and
an explicit deny is honoured. A guild created after they shipped is never in this state, because the
default `@everyone` permissions grant `CREATE_PUBLIC_THREADS` and `SEND_MESSAGES_IN_THREADS`; an
older guild leaves it the moment an administrator sets any thread permission on any role or
overwrite.

One consequence is worth knowing: while a guild is still in that older state, denying only
`SEND_MESSAGES_IN_THREADS` has no effect, because the mask then carries no thread bit at all and the
older rule applies. Granting any thread bit anywhere in the guild resolves it.


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
- **Lock.** A locked thread rejects messages from anyone who cannot moderate threads on the parent,
  and stays archived until a moderator reopens it.
- **Delete.** Deleting a thread deletes its messages, attachments, search documents, and membership
  rows. Deleting a text or forum channel deletes the threads under it the same way.

## Membership

Membership decides who is notified and, for a private thread, who has access at all. The creator of
a thread joins it, and so does anyone who sends a message in it. Mentioning a member in a public
thread adds them to it, capped per message; a private thread never adds anyone by mention, because
membership there is the access control. A member receives a notification for every message in the
thread; a non-member is notified only when mentioned.

Members can be listed, and the caller can join or leave, through the
[thread member routes](/http-api/channels/#list-thread-members).
[Add a thread member](/http-api/channels/#add-a-thread-member) and
[Remove a thread member](/http-api/channels/#remove-a-thread-member) manage anyone else: the thread
owner and a member who can moderate threads may add or remove, and a member of a private thread may
add others when the thread is `invitable`. A target who cannot view the parent channel is never
added, so a private thread cannot pull someone into a channel they cannot read.

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
