// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: tests for the unread push cap, see push/unread_cap.gleam.

import fluxer_gateway/cluster/router
import fluxer_gateway/config/env
import fluxer_gateway/config/settings.{Settings}
import fluxer_gateway/core/clock
import fluxer_gateway/core/id
import fluxer_gateway/core/node
import fluxer_gateway/push/format
import fluxer_gateway/push/message.{type MessageCreate}
import fluxer_gateway/push/recipients.{Recipient}
import fluxer_gateway/push/rule
import fluxer_gateway/push/server
import fluxer_gateway/push/throttle
import fluxer_gateway/push/unread_cap
import fluxer_gateway/telemetry/metrics
import gleam/dict
import gleam/erlang/atom.{type Atom}
import gleam/erlang/process
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/set
import support/push_api_stub as stub
import support/push_throttle

const guild = 9_400_000

const suppressed = "fluxer_gateway_push_unread_cap_suppressed"

const not_owner = "fluxer_gateway_push_unread_cap_not_owner"

@external(erlang, "erlang", "function_exported")
fn function_exported(module: Atom, function: Atom, arity: Int) -> Bool

@external(erlang, "code", "ensure_loaded")
fn ensure_loaded(module: Atom) -> #(Atom, Atom)

fn with_cap(cap: Int) -> Nil {
  settings.store(Settings(..settings.get(), push_unread_cap: cap))
  Nil
}

fn with_ttl(seconds: Int) -> Nil {
  settings.store(
    Settings(..settings.get(), push_unread_cap_ttl_seconds: seconds),
  )
  Nil
}

fn counted(name: String) -> Int {
  metrics.value(metrics.read_all(), name, [])
}

fn create_in(guild: Int, users: List(Int), channel: Int) -> MessageCreate {
  let data =
    message.MessageData(
      ..message.empty_data(),
      id: Some(9_400_900),
      channel_id: Some(channel),
      content: "hello",
    )
  message.MessageCreate(
    data:,
    recipients: users,
    guild:,
    author: 9_400_001,
    channel:,
    message: 9_400_900,
    guild_default_level: 0,
    guild_name: None,
    channel_name: None,
    user_roles: dict.new(),
    connected: set.new(),
    markdown: format.private_markdown_context(data),
    large: None,
    prefilter: message.NotFiltered,
  )
}

fn guild_message(users: List(Int), channel: Int) -> MessageCreate {
  create_in(guild, users, channel)
}

fn mentioning(create: MessageCreate, user: Int) -> MessageCreate {
  message.MessageCreate(
    ..create,
    data: message.MessageData(..create.data, mentions: [
      message.Mention(id: Some(user), username: None, global_name: None),
    ]),
  )
}

fn notified(create: MessageCreate) -> List(Int) {
  unread_cap.filter(create.recipients, create, fn(user) { user })
}

fn repeat(times: Int, run: fn() -> a) -> List(a) {
  list.repeat(Nil, times) |> list.map(fn(_) { run() })
}

pub fn admits_up_to_the_cap_then_suppresses_test() {
  with_cap(3)
  let before = counted(suppressed)
  let results = repeat(5, fn() { notified(guild_message([9_401_010], 100)) })
  assert results == [[9_401_010], [9_401_010], [9_401_010], [], []]
  assert counted(suppressed) == before + 2
  assert unread_cap.stored(9_401_010, 100) == Some(4)
}

pub fn counts_per_user_and_per_channel_test() {
  with_cap(1)
  let both = [9_402_010, 9_402_011]
  assert notified(guild_message(both, 100)) == both
  assert notified(guild_message(both, 100)) == []
  assert notified(guild_message([9_402_010], 200)) == [9_402_010]
}

pub fn reset_reopens_the_channel_test() {
  with_cap(1)
  let create = guild_message([9_403_010], 100)
  assert notified(create) == [9_403_010]
  assert notified(create) == []
  unread_cap.reset(9_403_010, 100)
  assert notified(create) == [9_403_010]
}

pub fn dms_bypass_and_do_not_count_test() {
  with_cap(1)
  let dm = create_in(0, [9_404_010], 100)
  assert unread_cap.is_priority(dm, 9_404_010)
  assert repeat(4, fn() { notified(dm) }) == list.repeat([9_404_010], 4)
  assert unread_cap.stored(9_404_010, 100) == None
  assert notified(guild_message([9_404_010], 100)) == [9_404_010]
}

pub fn direct_mentions_bypass_and_do_not_count_test() {
  with_cap(1)
  let plain = guild_message([9_405_010], 100)
  let mentioned = mentioning(plain, 9_405_010)
  assert notified(plain) == [9_405_010]
  assert repeat(3, fn() { notified(mentioned) }) == list.repeat([9_405_010], 3)
  assert unread_cap.stored(9_405_010, 100) == Some(1)
  assert notified(plain) == []
}

pub fn a_mention_of_someone_else_does_not_bypass_test() {
  with_cap(1)
  let create = mentioning(guild_message([9_406_010, 9_406_011], 100), 9_406_011)
  assert !unread_cap.is_priority(create, 9_406_010)
  assert unread_cap.is_priority(create, 9_406_011)
  assert notified(create) == [9_406_010, 9_406_011]
  assert notified(create) == [9_406_011]
}

pub fn role_and_everyone_mentions_count_like_any_message_test() {
  with_cap(1)
  let plain = guild_message([9_407_010], 100)
  let loud =
    message.MessageCreate(
      ..plain,
      data: message.MessageData(
        ..plain.data,
        mention_roles: [55],
        mention_everyone: True,
        mention_here: True,
      ),
      user_roles: dict.from_list([#(9_407_010, [55])]),
    )
  assert !unread_cap.is_priority(loud, 9_407_010)
  assert notified(loud) == [9_407_010]
  assert notified(loud) == []
}

pub fn zero_disables_the_cap_test() {
  with_cap(0)
  let create = guild_message([9_408_010], 100)
  assert repeat(10, fn() { notified(create) }) == list.repeat([9_408_010], 10)
  assert unread_cap.stored(9_408_010, 100) == None
  assert unread_cap.admit(9_408_010, 100, False)
  assert unread_cap.stored(9_408_010, 100) == None
}

pub fn a_negative_cap_or_ttl_falls_back_to_the_default_test() {
  with_cap(-1)
  with_ttl(0)
  assert unread_cap.cap() == 3
  let create = guild_message([9_409_010], 100)
  assert repeat(4, fn() { notified(create) })
    == [[9_409_010], [9_409_010], [9_409_010], []]
}

pub fn expired_rows_start_over_test() {
  with_cap(1)
  with_ttl(1)
  let create = guild_message([9_410_010], 100)
  assert notified(create) == [9_410_010]
  assert notified(create) == []
  process.sleep(2100)
  assert notified(create) == [9_410_010]
  assert unread_cap.stored(9_410_010, 100) == Some(1)
}

pub fn evict_removes_only_expired_rows_test() {
  with_cap(1)
  with_ttl(1)
  assert notified(guild_message([9_411_010], 100)) == [9_411_010]
  with_ttl(1000)
  assert notified(guild_message([9_411_011], 100)) == [9_411_011]
  process.sleep(2100)
  unread_cap.evict()
  assert unread_cap.stored(9_411_010, 100) == None
  assert unread_cap.stored(9_411_011, 100) == Some(1)
}

pub fn fails_open_for_users_this_node_does_not_own_test() {
  with_cap(1)
  let before = counted(not_owner)
  let admitted =
    repeat(4, fn() {
      unread_cap.admit_at(9_412_010, 100, owned: False, epoch: 0)
    })
  assert admitted == [True, True, True, True]
  assert unread_cap.stored(9_412_010, 100) == None
  assert counted(not_owner) == before + 4
}

pub fn fails_open_when_routing_is_unavailable_test() {
  with_cap(1)
  settings.store(Settings(..settings.get(), role: node.Websocket))
  let assert router.OwnerUnavailable(_) =
    router.owner(router.PushKey(9_413_010), node.Push)
  let create = guild_message([9_413_010], 100)
  assert repeat(3, fn() { notified(create) }) == list.repeat([9_413_010], 3)
  assert unread_cap.stored(9_413_010, 100) == None
}

pub fn a_count_from_another_topology_version_starts_over_test() {
  with_cap(1)
  let current = router.version()
  assert unread_cap.admit_at(9_414_010, 100, owned: True, epoch: current + 1)
  assert unread_cap.admit_at(9_414_010, 100, owned: True, epoch: current)
  assert !unread_cap.admit_at(9_414_010, 100, owned: True, epoch: current)
}

pub fn evict_drops_only_rows_from_other_topology_versions_test() {
  with_cap(3)
  let current = router.version()
  assert unread_cap.admit_at(9_415_010, 100, owned: True, epoch: current)
  assert unread_cap.admit_at(9_415_011, 100, owned: True, epoch: current + 1)
  unread_cap.evict()
  assert unread_cap.stored(9_415_010, 100) == Some(1)
  assert unread_cap.stored(9_415_011, 100) == None
}

pub fn trim_cuts_the_table_down_to_the_maximum_test() {
  with_cap(3)
  int.range(0, 10, Nil, fn(_, offset) {
    assert unread_cap.admit(9_416_010 + offset, 100, False)
  })
  unread_cap.evict()
  let size = unread_cap.size()
  assert size >= 10
  unread_cap.trim(size)
  assert unread_cap.size() == size
  unread_cap.trim(size - 4)
  assert unread_cap.size() == size - 4
}

fn snowflakes(values: List(Int)) -> json.Json {
  json.array(values, fn(value) { json.string(int.to_string(value)) })
}

fn api(author: Int, blocker: Int, minor: Int) -> fn(stub.Call) -> stub.Reply {
  fn(call: stub.Call) {
    case call.kind {
      "get_user_blocked_ids" ->
        stub.data(
          json.object(
            list.map(stub.user_ids(call), fn(user) {
              #(
                int.to_string(user),
                snowflakes(case user == blocker {
                  True -> [author]
                  False -> []
                }),
              )
            }),
          ),
        )
      "get_users_adult_content_allowed" ->
        stub.data(
          json.object([
            #(
              "user_ids",
              snowflakes(
                list.filter(stub.user_ids(call), fn(user) { user != minor }),
              ),
            ),
          ]),
        )
      _ -> stub.data(json.object([]))
    }
  }
}

pub fn the_cap_runs_after_the_blocked_and_age_filters_test() {
  push_throttle.calm(throttle.BlockedIds)
  push_throttle.calm(throttle.AdultContent)
  with_cap(1)
  let blocker = 9_417_010
  let minor = 9_417_011
  let reader = 9_417_012
  let base = guild_message([blocker, minor, reader], 100)
  let create =
    message.MessageCreate(
      ..base,
      data: message.mark_age_restricted(base.data),
      prefilter: message.FilteredBulk,
    )
  let stubbed = stub.start(api(create.author, blocker, minor))
  let before = counted(suppressed)
  let first = recipients.eligible(create, clock.deadline_in(3000))
  assert first == [Recipient(reader, rule.Bulk)]
  assert unread_cap.stored(blocker, 100) == None
  assert unread_cap.stored(minor, 100) == None
  assert unread_cap.stored(reader, 100) == Some(1)
  let second = recipients.eligible(create, clock.deadline_in(3000))
  assert second == []
  assert unread_cap.stored(blocker, 100) == None
  assert unread_cap.stored(minor, 100) == None
  assert counted(suppressed) == before + 1
  stub.stop(stubbed)
}

pub fn a_prefiltered_direct_class_is_capped_unless_the_user_is_mentioned_test() {
  push_throttle.calm(throttle.BlockedIds)
  let quiet = 9_418_010
  let named = 9_418_011
  let base = mentioning(guild_message([quiet, named], 100), named)
  let create = message.MessageCreate(..base, prefilter: message.FilteredDirect)
  let stubbed = stub.start(api(create.author, 0, 0))
  with_cap(1)
  let both = [Recipient(quiet, rule.Direct), Recipient(named, rule.Direct)]
  assert recipients.eligible(create, clock.deadline_in(3000)) == both
  assert recipients.eligible(create, clock.deadline_in(3000))
    == [Recipient(named, rule.Direct)]
  assert unread_cap.stored(named, 100) == None
  stub.stop(stubbed)
}

pub fn reading_the_channel_resets_the_count_test() {
  with_cap(1)
  let create = guild_message([9_419_010], 9_419_100)
  assert notified(create) == [9_419_010]
  assert notified(create) == []
  let assert Ok(user) = id.user_id(9_419_010)
  let assert Ok(channel) = id.channel_id(9_419_100)
  let assert Ok(read) = id.message_id(9_400_900)
  server.clear_channel_notifications(user, channel, read)
  assert unread_cap.stored(9_419_010, 9_419_100) == None
  assert notified(create) == [9_419_010]
}

pub fn a_read_resets_even_with_clear_notifications_switched_off_test() {
  with_cap(1)
  settings.store(
    Settings(..settings.get(), push_enrolled_clear_notifications_enabled: False),
  )
  let create = guild_message([9_420_010], 9_420_100)
  assert notified(create) == [9_420_010]
  let assert Ok(user) = id.user_id(9_420_010)
  let assert Ok(channel) = id.channel_id(9_420_100)
  let assert Ok(read) = id.message_id(9_400_900)
  server.clear_channel_notifications(user, channel, read)
  assert unread_cap.stored(9_420_010, 9_420_100) == None
}

pub fn the_remote_reset_names_a_real_function_test() {
  let module = atom.create("fluxer_gateway@push@unread_cap")
  let _ = ensure_loaded(module)
  assert function_exported(module, atom.create("reset"), 2)
}

fn read(vars: List(#(String, String))) -> settings.Settings {
  let vars = dict.from_list(vars)
  let assert Ok(loaded) =
    settings.read(
      env.Source(getenv: fn(name) { dict.get(vars, name) }, read_file: fn(_) {
        Error("enoent")
      }),
    )
  loaded
}

pub fn the_cap_and_its_ttl_are_read_from_the_environment_test() {
  assert read([]).push_unread_cap == 3
  assert read([]).push_unread_cap_ttl_seconds == 86_400
  let loaded =
    read([
      #("FLUXER_GATEWAY_PUSH_UNREAD_CAP", "0"),
      #("FLUXER_GATEWAY_PUSH_UNREAD_CAP_TTL_SECONDS", "600"),
    ])
  assert loaded.push_unread_cap == 0
  assert loaded.push_unread_cap_ttl_seconds == 600
}
