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

- Push work is routed to an owner node per user by
  `gateway_node_router:owner_node_result(UserId, push)`. `push_ets_cache` keeps
  its per-user state in node-local ETS and has a `rebalance` that drops rows the
  node no longer owns. Production runs one gateway today, and more may come.
- A read reaches the gateway as `push.clear_channel_notifications` (API to
  gateway RPC), which `push:clear_channel_notifications/3` already uses to
  truncate queued pushes and to send clear pushes.
- Message creates are batched per guild dispatch and routed by the FIRST user id
  of the batch, so a batch can contain users owned by another node.

## Decision

We will cap pushes per user per channel at 3 since the channel was last read,
implemented in a new module `push_unread_cap` in the gateway.

- The counter is a node-local ETS table keyed `{UserId, ChannelId}` holding a
  count and an expiry. It is incremented for each user who would otherwise be
  notified, as the last step of `filter_eligible_users`. At or below the cap the
  user is notified; above it the push is not sent. The message itself is
  unaffected, only the notification is dropped.
- Direct messages and direct @mentions always notify and do not use up the cap.
  Role and @everyone mentions count like ordinary messages.
- A read resets the counter. `push:clear_channel_notifications/3` casts a reset to
  the user's owner node, independent of the clear-notifications switch.
- Rows expire after 24 hours, matching the APNs expiration, and the table is
  trimmed to 500000 entries. Both run on the existing eviction tick.
- The cap is `FLUXER_GATEWAY_PUSH_UNREAD_CAP` (default 3, 0 disables) and the
  expiry is `FLUXER_GATEWAY_PUSH_UNREAD_CAP_TTL_SECONDS`.
- Multiple gateways: the module only counts for users this node owns. For any
  other user it lets the push through and bumps a `not_owner` counter. It never
  suppresses on a guess, so a routing mismatch costs extra pushes and never loses
  one. `push_ets_cache:rebalance/0` also calls `push_unread_cap:rebalance/0` to
  drop rows the node stopped owning.
- Counters are exposed in the push cache stats: `unread_cap`, `unread_cap_size`,
  `unread_cap_suppressed` and `unread_cap_not_owner`.

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
  is to split `user_ids` by owner node in `push:handle_message_create/1` before
  casting. It is deliberately not part of this change because it alters routing
  for every push cache, and it is only needed when a second gateway exists. Until
  then `unread_cap_not_owner` shows how much leaks.
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
