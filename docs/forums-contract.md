# Forums and threads: server contract for clients

Branch: `feat/forums-server`. Everything below is implemented and covered by `fluxer_api/src/api/channel/tests/ForumsServerParity.test.ts` unless marked otherwise.

Thread channel = type 11 (PUBLIC_THREAD) or 12 (PRIVATE_THREAD). A forum post is a thread whose parent is a type 15 (GUILD_FORUM) channel.

## 1. Thread object (ChannelResponse, type 11/12)

| Field | Meaning |
|---|---|
| `message_count` | Number of messages in the thread. For a forum post, the first message (the starter, i.e. the post body) is not counted. Incremented on every later message and decremented on single and bulk deletes. The server sends no `THREAD_UPDATE` per message, so clients bump it locally on `MESSAGE_CREATE`/`MESSAGE_DELETE` for that `channel_id`; the server value is authoritative on the next fetch. |
| `member_count` | Unchanged. |
| `last_message_id` | Snowflake of the newest message in the thread, or null. Activity key for "recent activity" sorting: `max(thread.id, last_message_id)`. |
| `thread_metadata.archived` / `locked` | Unchanged shape. See section 4 for server-side behaviour. |
| `pinned` | Forum posts: at most one pinned post per forum (see section 4). |
| `applied_tags` | Unchanged. |
| `thread_member_ids` | PRIVATE threads only, and only on gateway payloads (`THREAD_CREATE`, `THREAD_UPDATE`, the guild channel list the gateway loads, and so READY). IDs of the thread's members. Never present on HTTP responses. Clients may ignore it. |

New field, on LIST responses only:
- `GET /channels/:id/threads` (active)
- `GET /channels/:id/threads/archived`
- `GET /guilds/:id/threads/active`

```
starter_message_preview?: {
  message_id: string,
  author: { id: string, username: string, global_name: string | null, avatar: string | null } | null,
  content: string,            // first 200 characters, markdown untouched
  first_attachment: {
    id: string, filename: string, url: string, proxy_url: string | null,
    content_type: string | null, width: number | null, height: number | null
  } | null
} | null
```

- **Forum post:** the starter is the post's first message, which is the body sent right after `POST /channels/:forum/threads`.
- **Thread created from a message:** the starter is that message in the parent.
- **Null:** when there is no starter message, for example it was deleted or never sent.

Resolve nickname and role colour for `author.id` from guild members, as for any message. `first_attachment.url` is the plain CDN URL, and `proxy_url` is always null for now. This replaces the per-card message fetch.

## 2. Forum channel object (ChannelResponse, type 15)

Existing: `available_tags`, `default_reaction_emoji`, `default_sort_order` (0 = latest activity, 1 = creation date), `default_auto_archive_duration`, `require_tag`, `topic` (use as post guidelines), `rate_limit_per_user`.

New:

| Field | Meaning |
|---|---|
| `default_forum_layout` | 0 not set, 1 list, 2 gallery. Treat 0 as list. |
| `default_thread_rate_limit_per_user` | Slowmode (seconds) copied onto each new post at creation. 0 or absent means none. |

**Writing these fields:** everything above can be set on create (`POST /guilds/:id/channels` with `type: 15`) and through `PATCH /channels/:forum_id` with `type: 15` plus any subset of:
- `name`, `topic`, `rate_limit_per_user`
- `available_tags` (full replacement; include `id` to keep an existing tag, omit it for a new tag; at most 20)
- `default_reaction_emoji`, `default_sort_order`, `default_forum_layout`
- `default_auto_archive_duration`, `default_thread_rate_limit_per_user`
- `require_tag`

This is the route the mobile tag editor uses.

**Per-user override:** "Sort & View" is client-side only. "Reset to default" returns to `default_sort_order` / `default_forum_layout`.

## 3. New endpoint: guild-wide active threads

`GET /guilds/:guild_id/threads/active`

```
{ threads: ChannelResponse[], members: ThreadMemberSelfResponse[] }
ThreadMemberSelfResponse = { id: string /* thread id */, user_id: string, join_timestamp: string, flags: number }
```

- **Which threads:** every non-archived thread or forum post the caller can view. Parent channel overwrites apply, and private threads appear only for their members or callers with MANAGE_CHANNELS on the parent.
- **`members`:** only the caller's own memberships among the returned threads. Use it for "joined" and sidebar nesting.
- **Errors:** returns `UNKNOWN_GUILD` if the caller is not in the guild.

## 4. Server behaviour changes clients must expect

| Situation | Behaviour |
|---|---|
| Message into an archived, unlocked thread | The server reopens it (`archived: false`) and dispatches `THREAD_UPDATE`. Remove any client PATCH of `archived:false` before sending; it returned 403 for members anyway. |
| Message into a locked thread | Rejected (403) unless the sender has MANAGE_CHANNELS. A moderator's message into a locked archived thread reopens it but it stays locked. |
| Auto-archive | Dispatches `THREAD_UPDATE` per archived thread. Postgres deployments only. |
| Creator auto-join on create; author auto-join on first message; `PUT .../thread-members/@me` | `THREAD_MEMBERS_UPDATE` `{id, guild_id, member_count, added_members: [{id, user_id, join_timestamp, flags}]}`. Leaves send `removed_member_ids: [user_id]`. |
| `PATCH /channels/:thread/thread` as the thread owner without MANAGE_CHANNELS | Allowed: `name`, `applied_tags`, `auto_archive_duration`, and `archived` on an UNLOCKED thread. 403 on `locked`, `pinned`, `invitable`, or any `archived` change while the thread is locked. |
| Same PATCH with MANAGE_CHANNELS on the parent | Everything allowed. |
| Pinning a forum post (`pinned: true`) | Every other pinned post in that forum is unpinned. `THREAD_UPDATE` for the pinned post and each unpinned one. |
| `DELETE /channels/:thread/thread` | Owner or MANAGE_CHANNELS. Membership rows are removed; `THREAD_DELETE {id, guild_id, parent_id, type}`. |
| New post in a forum with `rate_limit_per_user` > 0 | One new post per member per window. A too-soon post gets HTTP 400 with code `SLOWMODE_RATE_LIMITED`, `retry_after` in the body and a `Retry-After` header, the same shape as message slowmode. BYPASS_SLOWMODE is exempt. |
| New post in a forum with `default_thread_rate_limit_per_user` | The post's own `rate_limit_per_user` is set to that value. Threads in text channels still copy the parent's slowmode. |

### THREAD_CREATED system message (unchanged)

The message goes in the parent channel, and its content is the thread channel id. Resolve the name from the thread. If the thread no longer exists, render something like "a thread that was deleted", never the raw id.

## 5. Forum "N New" count (read state)

No new server state is needed; this is a client recipe:

1. When the user views a forum, ack the forum channel with the newest activity id among its posts:
   - Route: `POST /channels/:forum_id/messages/:id/ack` with `{}`, or `/read-states/ack`.
   - `:id` is the maximum over posts of `max(post.id, post.last_message_id)`.
   - The ack route accepts any snowflake for a forum channel.
2. The forum's read state `last_message_id` (from READY `read_states` and `MESSAGE_ACK`) is the "last visit" marker.
3. "N New" is the number of non-archived posts in that forum whose `max(post.id, post.last_message_id)` is greater than that marker. Load the posts from `GET /guilds/:id/threads/active` and keep them current with `THREAD_CREATE`, `THREAD_UPDATE` and `MESSAGE_CREATE` (the last one bumps the post's `last_message_id`).
4. Per-post unread uses each post's own read state, the same as any text channel.
5. "Mark As Read" on a forum means acking the forum (step 1), then bulk-acking each unread post with `/read-states/ack-bulk`.

## 6. Mute and notification settings

- **Overrides for forum, thread and post ids:** `PATCH /users/@me/guilds/:guild_id/settings` accepts them in `channel_overrides` (`muted`, `mute_config`, `message_notifications`). This was already true.
- **Push, thread's own override:** a thread's own override wins.
- **Push, inherited mute:** when a thread or post has no `muted` setting of its own, it inherits `muted` from its parent channel's override. So muting a forum mutes its posts, and a post override of `muted: false` un-mutes that post.
- **Notification level:** `message_notifications` is not inherited from the parent. Thread members get all messages, others mentions only, unless the thread has its own level.
- **Payload field:** thread messages now carry `thread_parent_id` in `MESSAGE_CREATE` for the gateway. Clients may ignore it.

## 7. Private thread members (gateway)

Members of a private thread who lack MANAGE_CHANNELS now receive that thread's `MESSAGE_*`, `THREAD_*` events and pushes.
- **How:** the gateway admits users listed in the thread's `thread_member_ids` and keeps the list current from `THREAD_MEMBERS_UPDATE`.
- **Parent access still applies:** members still need VIEW_CHANNEL on the parent.
- **Leaving:** a member who leaves stops receiving events after the leave is processed.
