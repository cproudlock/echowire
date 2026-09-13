# Forums and threads: server contract for clients

Branch: `feat/forums-server`. This is what the web (`fluxer_app`) and mobile clients can rely on.
If an item is marked PLANNED, check the final commit message on this branch to confirm it landed.

Thread channel = type 11 (PUBLIC_THREAD) or 12 (PRIVATE_THREAD). A forum post is a thread whose parent is a type 15 (GUILD_FORUM) channel.

## 1. Thread object (ChannelResponse, type 11/12)

Existing fields, now accurate:

| Field | Meaning |
|---|---|
| `message_count` | Number of messages in the thread, excluding the starter message. Incremented on every message create in the thread and decremented on delete. Clients may bump it locally on `MESSAGE_CREATE`/`MESSAGE_DELETE` for that `channel_id`. The server does NOT send `THREAD_UPDATE` per message. |
| `member_count` | Unchanged. |
| `last_message_id` | Snowflake of the newest message in the thread, or null. Use this for "recent activity": the activity key is `max(thread.id, last_message_id)`. |
| `thread_metadata.archived` / `locked` | Unchanged shape. See section 4 for the new server-side behaviour. |
| `pinned` | Forum posts only. At most ONE post per forum is pinned (see section 4). |
| `applied_tags` | Unchanged. |

New field, only in LIST responses (`GET /channels/:id/threads/active`, `GET /channels/:id/threads/archived`, `GET /guilds/:id/threads/active`):

```
starter_message_preview?: {
  message_id: string,
  author: { id: string, username: string, global_name: string | null, avatar: string | null } | null,
  content: string,            // truncated to 200 characters, markdown left as-is
  first_attachment: {
    id: string, filename: string, url: string, proxy_url: string | null,
    content_type: string | null, width: number | null, height: number | null
  } | null
} | null
```

For a forum post, the starter message is the first message in the thread. For a thread created from a message, it is that parent message. The field is null when the starter message was deleted or never sent. Resolve role colour and nickname for `author.id` from guild members, as for any message. This replaces the web client's per-card message fetch.

## 2. Forum channel object (ChannelResponse, type 15)

Existing fields: `available_tags`, `default_reaction_emoji`, `default_sort_order` (0 = latest activity, 1 = creation date), `default_auto_archive_duration`, `require_tag`.

New fields:

| Field | Meaning |
|---|---|
| `default_forum_layout` | 0 = not set, 1 = list, 2 = gallery. Clients treat 0 as list. |
| `default_thread_rate_limit_per_user` | Slowmode in seconds applied to NEW posts at creation. 0 or absent means none. |

All of the above are settable via `PATCH /channels/:forum_id` with `type: 15` and any subset of `available_tags`, `default_reaction_emoji`, `default_sort_order`, `default_forum_layout`, `default_auto_archive_duration`, `default_thread_rate_limit_per_user`, `require_tag`, plus the usual `name`, `topic` (topic is the post guidelines) and `rate_limit_per_user`. Tag save from mobile uses exactly this route.

A per-user "Sort & View" override is client-side only (local storage or client prefs). "Reset to default" returns to `default_sort_order` / `default_forum_layout`.

## 3. New endpoint: guild-wide active threads

`GET /guilds/:guild_id/threads/active`

```
{ threads: ChannelResponse[], members: ThreadMemberSelfResponse[] }
ThreadMemberSelfResponse = { id: string /* thread id */, user_id: string, join_timestamp: string, flags: number }
```

- Returns all non-archived threads the caller can view, filtered by the same access rules as the hotfix (parent overwrites apply, private threads only for members or MANAGE_CHANNELS).
- `members` lists only the CALLER's memberships among the returned threads, so clients can tell which threads are joined.
- Use it for sidebar nesting: show joined threads and posts under their parent, plus active threads of text channels the way Discord does.
- Each thread includes `starter_message_preview`.

## 4. Server behaviour changes clients must expect

| Event or action | Behaviour |
|---|---|
| Message sent into an archived, NOT locked thread | The server unarchives it and dispatches `THREAD_UPDATE`. Clients must NOT PATCH `archived:false` before sending; remove that call. |
| Message sent into an archived, locked thread | Rejected unless the sender has MANAGE_CHANNELS. A MANAGE_CHANNELS send unarchives the thread but leaves it locked. |
| Auto-archive worker | Dispatches `THREAD_UPDATE` for each thread it archives. |
| Creator auto-joined on create, author auto-joined on first message | `THREAD_MEMBERS_UPDATE` with `added_members: [{user_id, join_timestamp, flags}]`, `member_count`, and `id` (the thread). |
| Lock / unlock | MANAGE_CHANNELS on the parent only. Owners get 403. |
| Pin / unpin a post | MANAGE_CHANNELS on the parent only. Pinning a post in a forum unpins any other pinned post in that forum, with a `THREAD_UPDATE` for each changed post. |
| Archive (close) / unarchive | Allowed for the owner (their own UNLOCKED thread) or MANAGE_CHANNELS. Unarchiving a LOCKED thread needs MANAGE_CHANNELS. |
| Rename, edit `applied_tags` | Allowed for the owner or MANAGE_CHANNELS. |
| Delete | MANAGE_CHANNELS, or the owner. `thread_members` rows are removed. |
| New post in a forum with `rate_limit_per_user` | Post creation is rate limited per user (429 with `retry_after`, the same shape as message slowmode). MANAGE_CHANNELS and MANAGE_MESSAGES bypass. |
| New post in a forum with `default_thread_rate_limit_per_user` | The post's own `rate_limit_per_user` is set to that value. |

### THREAD_CREATED system message

The content remains the thread channel id. Clients should resolve the name from the thread; if the thread no longer exists, render "a thread that was deleted" and never the raw id.

## 5. Forum "N New" count (read state)

No new server state is needed:

1. When the user views a forum, the client acks the forum channel with the newest activity id among its posts: `POST /channels/:forum_id/messages/:id/ack` with `{}` (or via `/read-states/ack`), where `id = max over posts of max(post.id, post.last_message_id)`. The ack route accepts any snowflake for a forum channel.
2. The forum's read state (`last_message_id`, from READY `read_states` and `MESSAGE_ACK`) is the "last visit" marker.
3. The "N New" value is the number of non-archived posts in that forum whose `max(post.id, post.last_message_id)` is greater than the forum's read state `last_message_id`. The data comes from `GET /guilds/:id/threads/active` at load, kept current by `THREAD_CREATE`/`THREAD_UPDATE`/`MESSAGE_CREATE`.
4. Per-post unread uses each post's own read state, the same as any text channel.

## 6. Mute and notification settings for forums, threads and posts

- `PATCH /users/@me/guilds/:guild_id/settings` `channel_overrides` accepts forum (15) and thread (11/12) channel ids, with `muted`, `mute_config`, `message_notifications`.
- Push eligibility:
  - Thread override: a muted thread gets no pushes. `message_notifications` on a thread overrides the default (thread members: all; others: mentions only).
  - Forum override: a muted forum mutes pushes for all its posts, unless a post has its own override.
- "Mark As Read" on a forum: the client acks the forum (section 5) and bulk-acks each unread post via `/read-states/ack-bulk`.

## 7. Private thread members (gateway)

Members of a private thread who lack MANAGE_CHANNELS now receive `MESSAGE_*` and `THREAD_*` events and pushes for that thread. PLANNED in this branch; see the final commit for confirmation.
