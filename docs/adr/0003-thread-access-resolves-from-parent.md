# 0003. Resolve thread access from the parent channel and private-thread membership

## Status

Accepted

Date: 2026-09-13

## Context

Threads and forum channels are fork features re-ported onto upstream's
architecture. A code audit on 2026-09-13 found a live access leak in prod:

- Thread rows carry `permission_overwrites: null` and were never checked against
  their parent channel, and the gateway treated an unknown channel as base
  permissions.
- `PRIVATE_THREAD` was not gated: joining checked only VIEW_CHANNEL, and the
  active and archived thread lists returned private threads to everyone.
- THREAD_* events went to every session in the guild.

The web client did inherit parent overwrites, so the UI hid what the server
still allowed. Api test coverage for thread endpoints was zero, which is how it
shipped. A follow-up security review found the gateway also leaked private
threads through visibility cached by role set, and an orphaned-thread leak.

The fixes shipped in tag `2026-09-13b` (`fix/thread-access-control`) and tag
`2026-09-14` (`fix/thread-access-review`).

## Decision

- A thread or forum post stores no overwrites. Every permission on it resolves
  against its parent channel (`ThreadAccess.ts`, `permissionChannelId`).
- A thread whose parent is missing or soft-deleted is inaccessible to everyone,
  and a worker task purges it.
- A private thread is visible only to its members and to members with
  MANAGE_CHANNELS on the parent; seeing any thread first requires VIEW_CHANNEL
  on the parent (`canViewThread`, `canAccessPrivateThread`). The api
  sends member ids to the gateway on private-thread payloads so it can apply this.
- The gateway resolves thread visibility live per user and event. It never
  caches, memoises or shares thread visibility keyed by role set, and drops
  thread ids from any cached viewable-channel list.
- Every change to a thread permission path lands with api integration tests.

## Consequences

- The api and gateway implement the same rules in two languages and must be
  changed together; comments in each point at the other.
- The gateway does more work per thread event, since nothing is memoised.
- Discord-style thread permission bits (MANAGE_THREADS, CREATE_*_THREADS) do not
  exist yet; MANAGE_CHANNELS on the parent stands in for them.
- Upstream merges touching channel permissions or gateway visibility caches need
  a careful review against `guild_sessions.erl` and the thread access tests.

## Alternatives considered

- Give threads their own copied overwrites: they drift from the parent and
  miss member-specific exceptions.
- Cache thread visibility by role set like other channels: a role-set key cannot
  capture per-user private-thread membership, which is the leak that was fixed.
