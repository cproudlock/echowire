# 0009. Cap unread push notifications per channel

## Status

Proposed

Date: 2026-10-06

## Context

A user on iOS received about 50 push notifications and believed the app stops
notifying after three notifications that were not interacted with. No such
behavior exists in the gateway, the API or the mobile app. The belief most likely
comes from Discord, which notifies for the first three new messages in a channel
or DM and then stays quiet until the user catches up.

Today every message that passes eligibility (mutes, notification level,
mentions, thread membership, blocks) produces one push per registered device.
The APNs `apns-collapse-id` is the message id, so it only collapses retries of
one message. A busy channel, or a phone that was offline for a while and then
reconnects, produces one notification per message.

Facts that shaped the design:

- Push work is routed to an owner node per user by the cluster router
  (`router.owner(PushKey(user), Push)`). The push caches keep their per-user
  state in node-local ETS. Production runs one gateway today, and more may come.
- A read reaches the gateway as `push.clear_channel_notifications` (API to
  gateway RPC), which `server.clear_channel_notifications` already uses to
  truncate queued pushes and to send clear pushes.
- Message creates are batched per guild dispatch and routed by the FIRST user id
  of the batch, so a batch can contain users owned by another node.

The module and function names here are those of the Gleam gateway under
`fluxer_gateway/src/fluxer_gateway/push/`. The first version of this decision
was written against the Erlang gateway (`push_unread_cap.erl`), which upstream
replaced in #4254. The behavior is unchanged, the implementation section below
describes the Gleam port.

## Decision

We will cap pushes per user per channel at 3 since the channel was last read,
implemented in a fork-owned module `push/unread_cap.gleam` in the gateway.

- The counter is a node-local ETS table (`push_unread_cap`) keyed by user and
  channel, holding a count, an expiry and the topology version the row was
  written in. It is incremented for each user who would otherwise be notified,
  as the last step of `recipients.eligible`, after the blocked-user and age
  filters. At or below the cap the user is notified; above it the push is not
  sent. The message itself is unaffected, only the notification is dropped.
- Direct messages and direct @mentions always notify and do not use up the cap.
  Role, @everyone and @here mentions count like ordinary messages. Priority is
  decided from the message itself (`guild == 0`, or the user is in the message's
  direct mentions), not from the `rule.Class` of the recipient: the `Direct`
  class also holds role mentions, and prefiltered creates carry a class but no
  reason.
- A read resets the counter. `server.clear_channel_notifications` calls
  `unread_cap.reset_routed`, independent of the clear-notifications switch. It
  drops the row on the node that got the RPC and, when the user's push owner is
  another node, on that node as well.
- Rows expire after 24 hours, matching the APNs expiration, and the table is
  trimmed to 500000 entries. Both run on the push cache eviction tick, next to
  `settings_cache.evict`. The table is created with the push caches and is owned
  by the same keeper process.
- The cap is `FLUXER_GATEWAY_PUSH_UNREAD_CAP` (default 3, 0 disables) and the
  expiry is `FLUXER_GATEWAY_PUSH_UNREAD_CAP_TTL_SECONDS`. Both are fields of the
  gateway `Settings` record. A negative cap or a non-positive expiry falls back
  to the default.
- Multiple gateways: the module only counts for users this node owns. For any
  other user, or when the owner is unknown, it lets the push through and bumps
  a `not_owner` counter. It never suppresses on a guess, so a routing mismatch
  costs extra pushes and never loses one. A count is only trusted within the
  topology version it was written in: after any topology change the row starts
  over, and the eviction tick drops rows from other versions. This replaces the
  old `rebalance`.
- Rows are not part of the push handoff. A rolling restart or a bucket move
  loses them, which only resets counts.
- A missing table sends. Gleam has no exception handling, so each table call
  checks that the table exists first instead of catching an error.
- Metrics: counters `fluxer_gateway_push_unread_cap_suppressed` and
  `fluxer_gateway_push_unread_cap_not_owner`, and the gauge
  `fluxer_gateway_push_unread_cap_rows`, set on each eviction tick.

## Consequences

Easy: a flood in one channel stops after three notifications, with no client
change and no mobile release. It behaves the same for APNs, FCM and web push
because it sits before the outbox.

Hard or unhappy:

- Counters live in memory, so a gateway restart or deploy resets them and users can
  get up to three pushes per active channel again. Accepted, because the failure
  mode is a few extra notifications.
- A read resets the counter even if newer unread messages exist, because the
  reset does not compare message ids. This can allow a few extra pushes, never
  fewer.
- Because message creates are routed by the first user of a batch, on more than
  one gateway a recipient owned by another node is let through uncapped. The fix
  is to split the recipients by owner node in `server.handle_message_create`
  before casting. It is deliberately not part of this change because it alters
  routing for every push cache, and it is only needed when a second gateway
  exists. Until then the `not_owner` counter shows how much leaks.
- A push job that is handed to another node, or requeued, after eligibility ran
  is evaluated again, so one message can use up two counts for a user. This can
  only make the cap bite one message early, during a handoff.
- The iOS icon badge count travels inside each push. A suppressed message sends no
  push, so the badge can lag behind the real unread count until the next push or
  until the app is opened. We accept this for now. A silent badge-only update for
  suppressed messages is the follow-up if it proves confusing.
- A user who ignores a channel for a day gets three notifications from it, not
  one. This matches Discord.
- The cap is global, not per user setting.

## Alternatives considered

- A per-device counter of pushes since the app was last opened: needs the app to
  report opening and a mobile release, and does not match Discord.
- Collapsing by channel through `apns-collapse-id` and `thread-id`: the user still
  gets a buzz per message, and Android and web would need separate handling.
- Persisting the counter in Postgres or Valkey: survives restarts and works across
  nodes, but adds a round trip to every push for a limit whose failure mode is
  harmless.
- A digest notification ("N new messages"): better for users, more to build, and
  can follow this change.
