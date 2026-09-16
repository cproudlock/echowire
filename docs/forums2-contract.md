# Forums phase 2: server contract

Status: authoritative for branch `feat/forums2-server`. Written before implementation so the web
and mobile clients can code against it. Any change made while implementing is noted in the
Changes section at the end.

Everything here is additive. No existing field, route or event changes shape, and no existing
permission behaviour changes.

## 1. Moderated tags

A forum tag gains a `moderated` flag. Only a member with MANAGE_THREADS (or MANAGE_CHANNELS, which
is accepted everywhere MANAGE_THREADS is) on the forum may apply or remove such a tag.

`ForumTagResponse` gains:

| Field | Type | Notes |
| --- | --- | --- |
| `moderated` | boolean | Defaults to false. Tags stored before this change read as false. |

`ForumTagInput` (forum create and channel edit, `available_tags`) accepts the same optional field.
Setting it needs MANAGE_CHANNELS, which editing a forum already requires.

Enforcement:

- Creating a post with a moderated tag in `applied_tags`: requires MANAGE_THREADS, else 403.
- Editing `applied_tags` on a post: the caller may only add or remove a moderated tag with
  MANAGE_THREADS.
- A post owner without MANAGE_THREADS editing tags keeps the moderated tags already applied.
  They are not silently dropped, and the owner does not need to resend them: the server preserves
  the moderated tags currently on the post and applies the caller's set for the rest. Sending a
  set that omits a moderated tag is therefore not a removal for such a caller.
- Removing a moderated tag as a non-moderator is impossible by design. A moderator removes it by
  sending a set without it.
- Deleting a moderated tag from the forum's `available_tags` still removes it from posts, as
  before, because tag validity is resolved against the forum.

## 2. Add to post

Appends an attachment that already exists on a message inside a forum post to that post's starter
message, where it becomes the post thumbnail.

    POST /channels/{channel_id}/starter-message/attachments
    {"message_id": "...", "attachment_id": "..."}

- `channel_id` is the forum post (a thread whose parent is a forum).
- `message_id` is a message in that post carrying `attachment_id`.
- Returns the updated starter message as `MessageResponse`.

Rules:

- The caller must be the post owner, or hold MANAGE_THREADS on the parent forum.
- The source message must be in this post, and must carry that attachment, else 404.
- The starter message must not already carry the attachment, else 400.
- The starter message's attachment count must stay within `max_attachments_per_message`, else 400.
- Nothing is uploaded: the attachment is already stored, and its CDN key is derived from the
  channel and the attachment id, so the same blob serves both messages.
- The attachment's decay record, when attachment decay is enabled on the instance, is re-pointed
  at the starter message so its lifetime follows the post rather than the reply.

Events:

- `MESSAGE_UPDATE` for the starter message, always.
- `THREAD_UPDATE` for the post only when the card thumbnail changes, which is when the starter had
  no attachment before. Appending a second attachment changes no card.

## 3. Recent participants

Thread list payloads gain the recent distinct message authors, so a card can render a participant
avatar row without a lookup per post.

`ChannelResponse` gains:

| Field | Type | Notes |
| --- | --- | --- |
| `recent_participant_ids` | array of snowflake strings, or null | Up to 5, most recent author first. Null or absent on non-threads. |

It is maintained on the channel row and written in the same patch that already advances
`last_message_id` and the message count, so reading it costs nothing per card. It is not a
membership list and not a complete author list: it is a rolling window of the last few distinct
authors, and a post with no replies yet carries just its starter author.

Clients resolve those ids through their own user cache. The server returns ids only, because
resolving up to five users per card would undo the point of the field.

## 4. Forum examples

Client-side copy, no server field. Discord's "See Examples" on an empty forum shows suggested post
ideas with no per-server configuration, and nothing about them needs to be stored or authorised.
Clients own the strings and their translations. The server adds nothing for this item.

## 5. Audit leftovers

### Thread member limit

`max_thread_members` joins the limit set, default 1000, matching Discord's cap. Adding a member
beyond it fails with a dedicated error. It applies to joins, to adds by another member, to the
mention auto-add in public threads (which skips silently rather than failing the message) and not
to the creator, who is added as part of creating the thread.

### Per-post slowmode

`default_thread_rate_limit_per_user` on a forum is already applied to new posts. What was missing
is editing a post's own slowmode, so `ThreadUpdateRequest` gains:

| Field | Type | Notes |
| --- | --- | --- |
| `rate_limit_per_user` | integer 0 to 21600, optional | Slowmode in seconds for this post. |

The post owner may set it on their own unlocked post, and MANAGE_THREADS may set it on any post,
which matches how the other thread fields already behave.

## Changes made while implementing

- **Add to post returns the post, not the message.** The route returns `ChannelResponse` for the
  forum post, with `starter_message_preview` already reflecting the new thumbnail, so a client
  updates the card from the response it already understands. The starter message itself still
  arrives as a `MESSAGE_UPDATE` event, which is what a client renders in the open post.
- **Error codes.** Three validation codes were added rather than reusing a generic one:
  `STARTER_ATTACHMENT_SOURCE_INVALID` (the source message is the starter itself),
  `STARTER_ATTACHMENT_ALREADY_PRESENT` and `STARTER_ATTACHMENT_LIMIT_REACHED`. A missing
  attachment reuses the existing `ATTACHMENT_ID_NOT_FOUND_IN_MESSAGE`. All are 400 except the
  permission failures, which are 403, and an unknown post or source message, which is 404.
- **Recent participants are capped by a constant**, `MAX_RECENT_THREAD_PARTICIPANTS`, currently 5.
  The field is omitted rather than sent empty when a thread has no authors yet.
- **Forum examples confirmed client-side.** No server field was added, as anticipated.
