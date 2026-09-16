# 4. Threads get their own permission bits, with a legacy fallback

Date: 2026-09-16

## Status

Accepted

## Context

Threads and forum posts shipped reusing the permissions of their parent channel: creating one
needed VIEW_CHANNEL and SEND_MESSAGES on the parent, and every moderator action needed
MANAGE_CHANNELS. ADR 0003 recorded that as a deliberate simplification.

It costs us three things. A member cannot be allowed to talk in threads but not in the parent
channel, or the other way round, which is the usual reason a community turns threads on. Thread
moderation cannot be delegated without handing over control of the channel itself. And the api
diverges from the Discord permission model it otherwise mirrors, so a permission integer means
something different here, which blocks upstreaming the feature.

The instance is live, so the roles and channel overwrites already stored carry none of the new
bits. Switching the checks over without care would stop every existing member from creating a
thread or replying in one.

## Decision

Add the four permissions Discord defines, at Discord's own bit positions, so an integer means the
same thing on both platforms:

- MANAGE_THREADS, 1 bsl 34
- CREATE_PUBLIC_THREADS, 1 bsl 35
- CREATE_PRIVATE_THREADS, 1 bsl 36
- SEND_MESSAGES_IN_THREADS, 1 bsl 38

Enforcement, all resolved against the parent channel:

- a public thread or forum post needs CREATE_PUBLIC_THREADS
- a private thread needs CREATE_PRIVATE_THREADS
- posting inside a thread needs SEND_MESSAGES_IN_THREADS, not the parent's SEND_MESSAGES
- moderating someone else's thread needs MANAGE_THREADS, and MANAGE_CHANNELS is accepted as well,
  permanently, because it already implies control of the parent channel
- the owner's own rights over their unlocked thread are unchanged

Existing installations are handled by a legacy fallback rather than a migration. A resolved
permission mask carrying none of the four bits belongs to a role set written before they existed,
and keeps the old behaviour: SEND_MESSAGES on the parent stands in for CREATE_PUBLIC_THREADS and
SEND_MESSAGES_IN_THREADS, and MANAGE_CHANNELS for MANAGE_THREADS. As soon as any thread bit appears
anywhere in the resolution chain, the bits are authoritative and an explicit deny is honoured.

New guilds are never in legacy mode: DEFAULT_PERMISSIONS grants CREATE_PUBLIC_THREADS and
SEND_MESSAGES_IN_THREADS to @everyone, as Discord does. An older guild leaves legacy mode the
moment an admin touches any thread permission on any role or overwrite.

Private threads are also made usable: PUT, DELETE and GET on
/channels/{channel_id}/thread-members/{user_id}. The thread owner and thread moderators may add or
remove anyone; a member may add others only when the thread is invitable; removing yourself is
leaving. A target must be able to see the parent channel, so a private thread cannot be used to
pull someone into a channel they cannot read. `invitable` now defaults to false on create and is
honoured, where before it was stored as true for every private thread and never read.

Mentioning a member in a public thread adds them to it, as on Discord, capped per message. A
private thread never auto-adds, because membership there is the access control.

## Consequences

- The permission editors gain a "Threads and posts" section on both roles and channel overwrites.
- Creating a private thread is now a distinct permission, which no role holds by default. Before
  this change any member with SEND_MESSAGES could create one through the api, so this is a
  deliberate tightening of a feature no client offered.
- The legacy fallback has one gap: in a guild still in legacy mode, denying only
  SEND_MESSAGES_IN_THREADS has no effect, because the mask then contains no thread bit at all and
  the old rule applies. Granting any thread bit anywhere in that guild resolves it. The alternative
  was a data migration over every stored role and overwrite, which is riskier on a live instance
  and cannot be undone.
- The gateway carries the same rules, so MANAGE_THREADS alone opens a private thread's events.
- Nothing about who can already see a thread changed, so the shared visibility contract in
  contracts/thread_visibility_cases.json stays true. It gains coverage for the new moderator bit
  when that file and this change are on the same branch.
