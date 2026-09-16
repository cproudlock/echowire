# 0005. Keep thread state on the channel row, with defaults filled at the write boundary

## Status

Accepted

Date: 2026-09-16

## Context

Threads and forum posts are channels (types 11, 12 and 15), and their state lives on the
channel row as 17 nullable columns: `thread_archived`, `thread_locked`,
`thread_message_count`, `available_tags`, `applied_tags`, `default_forum_layout` and the
rest. Only threads, forum posts and forums ever set them.

The columns were declared non-optional on `ChannelRow`, so every channel row literal had to
mention all 17. A `NULL_THREAD_FIELDS` constant was spread at 12 sites to satisfy that,
including DM snapshots, the personal-notes repair path, guild channel creation and the test
harness. An upstreamability review called this out: a spread that every future row literal
has to remember is a footgun, because forgetting it is a compile error at best and, for the
full-row writers, a runtime throw from the DSL at worst. It asked whether thread state
should move to a sub-table or a JSON column instead.

Three facts decided it.

`paramsFromRow` in the table DSL throws only when a column is `undefined` on a full-row
write, and `upsertAll` already falls back to a dynamic upsert for partial rows. So the hard
requirement was never the storage layer: it was the TypeScript type.

Postgres, the backend this instance runs, already stores each row as a single JSONB
`row_data` document. There is no physical column sprawl to relieve, and the upsert merges
with `kv.row_data || EXCLUDED.row_data`, which is a shallow merge. Nesting thread state
under one key would make a patch of one field replace the whole nested object, wiping
sibling fields written concurrently. That is precisely the race the thread counter lock was
added to prevent, reappearing one layer lower where a lock cannot reach it.

Threads are read on the hottest paths in the system: every message send resolves the thread
row to advance `last_message_id` and its message count, and every gateway event resolves
thread visibility. A sub-table would add a read to each of those, and Cassandra has no
joins, so every reader would issue the second query itself.

## Decision

We will keep thread and forum state as flat columns on the channel row.

We will declare those columns optional on `ChannelRow`, so a row literal that is not a
thread neither mentions thread state nor can forget it, while TypeScript still requires
every other channel column.

We will normalise the absent columns to null at a single write boundary: the `Channels`
table wraps `insert`, `insertIfNotExists` and `upsertAll` with `withChannelThreadDefaults`,
so what reaches the store is identical to spelling all 17 out at the call site.

Partial writes stay as they are. `patchByPk`, `patchThreadFields` and the counter updates
keep addressing single columns, and keep the serialisation that makes concurrent sends
count correctly.

## Consequences

`NULL_THREAD_FIELDS` is gone and 12 call sites no longer spread anything. A new channel
write site cannot get thread state wrong: it either sets the fields deliberately or the
boundary fills them.

Nothing changes physically. The stored rows, the wire format of every API response and
every gateway payload, and the Cassandra column list are all untouched, so there is no
migration and no compatibility window.

The read shape of `ChannelRow` is now `T | null | undefined` for thread fields where it was
`T | null`. Every reader already used `?? default`, so this cost nothing, but a future
reader that tests `=== null` would be subtly wrong. There were none when this landed.

The columns remain on the channel row, so a reader who wants to know what a channel row is
still reads 17 fields that are meaningless for most channels. That is the price of not
paying a second read on the send and visibility paths.

`Channels` is now an object that spreads the table and overrides three methods, rather than
the table itself. It still satisfies `Table<ChannelRow, ...>`, which `executeVersionedUpdate`
relies on, but a future DSL method must be added to the wrapper if it also needs the
defaults.

## Alternatives considered

A `thread_metadata` sub-table keyed by channel id: rejected because it adds a read to every
message send and every gateway visibility resolution, Cassandra cannot join it away, and
thread create and delete stop being single-row writes.

One JSON column holding the thread state: rejected because the Postgres KV backend already
stores the row as one JSON document, so it buys nothing physically, and the shallow
`||` merge would turn per-field patches into whole-object writes, reintroducing the counter
race at a layer where the existing lock does not apply.

A discriminated `ChannelRow` union on channel type: rejected because `ChannelRow` is read
in hundreds of places that do not narrow by type first, so the change would be enormous and
would make ordinary channel reads harder to write, in exchange for the same guarantee the
write boundary gives.
