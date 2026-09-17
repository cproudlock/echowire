# 0007. Walk guilds to find every thread, on either backend

## Status

Accepted

Date: 2026-09-17

## Context

Three background sweeps need to visit every thread on the instance: the auto-archive job, the
orphaned-thread sweep, and the membership index backfill. All three were written against Postgres,
paging the generic key-value table with raw SQL that filtered `row_data->>'type'` and ordered by
`row_key`.

That only works on one backend. Cassandra has no `WHERE` on a non-key column and no offset paging,
so each sweep opened with `if (Config.database.backend !== 'postgres') return;`. On a Cassandra
deployment threads therefore never auto-archived at all, orphans were never collected, and the
membership index was never backfilled. Upstream supports both backends, so a feature that silently
does nothing on one of them is half-built.

The existing precedent for a portable index is `thread_members_by_user`: a second table maintained
on write so a reader can answer a question with a single-partition query. Following it suggested a
bucketed `threads_by_bucket` index, keyed by a bucket derived from the thread id, written on
create, on archive state change, and on delete, with the sweeps walking a fixed set of partitions.
That was built first and then discarded, because a portable enumeration already existed:
`GuildRepository.listAllGuildsPaginated`, which `RefreshSearchIndex` and `SearchWarmup` already use
to walk the whole instance on either backend. A guild's channel list is a single-partition read and
it already contains that guild's threads, so nothing new has to be stored to find them.

## Decision

We will enumerate threads by walking guilds, not by maintaining a thread index.
`channel/services/ThreadSweepScan.ts` pages guilds with `listAllGuildsPaginated`, reads each
guild's channels with `listGuildChannels`, and yields the thread-typed ones along with the guild's
full channel set. The three sweeps consume that generator and no longer reference the Postgres
client, raw SQL, or `Config.database.backend`.

Each page carries the whole channel set so a caller can resolve a thread's parent from memory;
`isOrphanedThread` is therefore a synchronous predicate taking a lookup function rather than an
async repository call.

## Consequences

All three sweeps now run on both backends, and the archive job decides inactivity from the loaded
thread row, so it needs no second read per candidate. No new table exists, so there is nothing to
keep in step on the write path, no bootstrap backfill, and no index that can silently drift from
the channels it describes. Removing the raw SQL also removes the only worker code that knew about
the key-value table's physical shape.

The cost profile changes rather than strictly improving. The old scan was one indexed range scan
per page over every channel row on the instance, including text channels and DMs, repeated every
five minutes. The new walk is one guild-list read plus one channel-list read per guild, so it scales
with the number of guilds and their channel counts instead of with the size of the key-value table.
For an instance with a few guilds that is less work; for one with very many small guilds it is more
round trips, which is the same trade `RefreshSearchIndex` already makes.

Two things we are not happy about. A thread missing from `channels_by_guild` would now be invisible
to the sweeps, where the old SQL read the channels table directly and would have found it; that
index is written on every channel upsert, so the window is a partial write, but it is a real
narrowing. And the sweeps are still untested end to end against a live Cassandra cluster: the
handlers are covered with fake repositories, and the two repository methods they now rely on are
already used in production on both backends, which is argument rather than proof.

## Alternatives considered

- **A bucketed `threads_by_bucket` index maintained on write.** Built, then discarded: it needed
  write-path coupling in three places, a bootstrap backfill that Cassandra could not perform, and a
  flag kept in step with every archive, to answer a question the guild walk already answers.
- **Keep the Postgres SQL and add a separate Cassandra path.** Two implementations of one
  behaviour, and the Cassandra half would only ever be exercised where nobody was looking.
- **A Cassandra secondary index or materialised view on channel type.** High-cardinality secondary
  indexes are the documented wrong tool, and it would have been a schema change the key-value
  Postgres backend has no equivalent for.
- **Leave it Postgres-only and document the gap.** What the code already did; it leaves upstream's
  other supported backend with a feature that quietly does nothing.
