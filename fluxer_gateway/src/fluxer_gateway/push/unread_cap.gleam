// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: per user, per channel cap on push notifications sent since the
// channel was last read. Past the cap a message still arrives in the app, it
// just does not buzz the phone.
// See docs/adr/0009-cap-unread-push-notifications-per-channel.md.
//
// Rows live in a node-local ETS table keyed by user and channel. A node counts
// only for users whose push owner it is, and a count is only trusted within
// the topology version it was written in. In every other case the push is
// sent, so a routing mismatch costs extra pushes and never loses one.

import fluxer_gateway/cluster/router
import fluxer_gateway/config/settings
import fluxer_gateway/core/node
import fluxer_gateway/push/message.{type MessageCreate}
import fluxer_gateway/push/metrics
import gleam/dynamic.{type Dynamic}
import gleam/erlang/atom.{type Atom}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/set.{type Set}

const table = "push_unread_cap"

const max_rows = 500_000

const module_name = "fluxer_gateway@push@unread_cap"

type Row {
  Row(key: #(Int, Int), count: Int, expires_at_s: Int, epoch: Int)
}

const count_position = 3

type TableOption {
  NamedTable
  Public
  Set
  Keypos(Int)
  ReadConcurrency(Bool)
  WriteConcurrency(Bool)
}

type TimeUnit {
  Second
}

type InfoItem {
  Size
}

@external(erlang, "erlang", "binary_to_atom")
fn to_atom(name: String) -> Atom

@external(erlang, "ets", "new")
fn ets_new(name: Atom, options: List(TableOption)) -> Atom

@external(erlang, "ets", "lookup")
fn ets_lookup(table: Atom, key: #(Int, Int)) -> List(Row)

@external(erlang, "ets", "update_counter")
fn ets_update_counter(
  table: Atom,
  key: #(Int, Int),
  step: #(Int, Int, Int, Int),
  default: Row,
) -> Int

@external(erlang, "ets", "delete")
fn ets_delete(table: Atom, key: key) -> Bool

@external(erlang, "ets", "select_delete")
fn ets_select_delete(
  table: Atom,
  spec: List(#(head, List(guard), List(Bool))),
) -> Int

@external(erlang, "ets", "first")
fn ets_first(table: Atom) -> Dynamic

@external(erlang, "ets", "next")
fn ets_next(table: Atom, key: Dynamic) -> Dynamic

@external(erlang, "ets", "safe_fixtable")
fn ets_safe_fixtable(table: Atom, fix: Bool) -> Bool

@external(erlang, "ets", "info")
fn ets_info(table: Atom, item: InfoItem) -> Int

@external(erlang, "ets", "whereis")
fn ets_whereis(table: Atom) -> Dynamic

@external(erlang, "erlang", "system_time")
fn system_time(unit: TimeUnit) -> Int

@external(erlang, "erpc", "cast")
fn erpc_cast(on: Atom, module: Atom, function: Atom, args: List(Int)) -> Atom

fn name() -> Atom {
  to_atom(table)
}

fn exists() -> Bool {
  ets_whereis(name()) != atom.to_dynamic(atom.create("undefined"))
}

pub fn init() -> Nil {
  case exists() {
    True -> Nil
    False -> {
      let _ =
        ets_new(name(), [
          NamedTable,
          Public,
          Set,
          Keypos(2),
          ReadConcurrency(True),
          WriteConcurrency(True),
        ])
      Nil
    }
  }
}

pub fn cap() -> Int {
  let configured = settings.get().push_unread_cap
  case configured >= 0 {
    True -> configured
    False -> settings.defaults().push_unread_cap
  }
}

fn ttl_seconds() -> Int {
  let configured = settings.get().push_unread_cap_ttl_seconds
  case configured > 0 {
    True -> configured
    False -> settings.defaults().push_unread_cap_ttl_seconds
  }
}

// Keeps the items whose user may be notified for this message, counting each
// one admitted. It must run after every other eligibility filter.
pub fn filter(
  items: List(a),
  create: MessageCreate,
  user_of: fn(a) -> Int,
) -> List(a) {
  case cap() {
    0 -> items
    _ -> {
      let mentioned = message.direct_mention_ids(create.data)
      list.filter(items, fn(item) {
        let user = user_of(item)
        admit(user, create.channel, priority(create, mentioned, user))
      })
    }
  }
}

// Direct messages and direct mentions of the user always notify and do not
// use up the cap. Role, everyone and here mentions count like any message.
pub fn is_priority(create: MessageCreate, user: Int) -> Bool {
  priority(create, message.direct_mention_ids(create.data), user)
}

fn priority(create: MessageCreate, mentioned: Set(Int), user: Int) -> Bool {
  create.guild == 0 || set.contains(mentioned, user)
}

pub fn admit(user: Int, channel: Int, priority: Bool) -> Bool {
  case priority {
    True -> True
    False ->
      admit_at(user, channel, owned: owned_here(user), epoch: router.version())
  }
}

// The counting step, given what routing said about this user.
pub fn admit_at(
  user: Int,
  channel: Int,
  owned owned: Bool,
  epoch epoch: Int,
) -> Bool {
  let cap = cap()
  case cap, owned, exists() {
    0, _, _ -> True
    _, False, _ -> {
      metrics.count("push_unread_cap_not_owner", 1)
      True
    }
    _, True, False -> True
    _, True, True -> {
      let key = #(user, channel)
      let now = system_time(Second)
      drop_stale(key, now, epoch)
      let count =
        ets_update_counter(
          name(),
          key,
          #(count_position, 1, cap + 1, cap + 1),
          Row(key, 0, now + ttl_seconds(), epoch),
        )
      case count <= cap {
        True -> True
        False -> {
          metrics.count("push_unread_cap_suppressed", 1)
          False
        }
      }
    }
  }
}

fn drop_stale(key: #(Int, Int), now: Int, epoch: Int) -> Nil {
  case ets_lookup(name(), key) {
    [Row(expires_at_s:, epoch: written, ..)]
      if expires_at_s < now || written != epoch
    -> {
      let _ = ets_delete(name(), key)
      Nil
    }
    _ -> Nil
  }
}

fn owned_here(user: Int) -> Bool {
  router.owner(router.PushKey(user), node.Push) == router.Local
}

// Drops the local row. Losing a row only resets that count.
pub fn reset(user: Int, channel: Int) -> Nil {
  case exists() {
    False -> Nil
    True -> {
      let _ = ets_delete(name(), #(user, channel))
      Nil
    }
  }
}

// A read reopens the channel: drop the row here and on the user's push owner.
pub fn reset_routed(user: Int, channel: Int) -> Nil {
  reset(user, channel)
  case router.owner(router.PushKey(user), node.Push) {
    router.Remote(target) -> {
      let _ =
        erpc_cast(node.to_atom(target), to_atom(module_name), to_atom("reset"), [
          user,
          channel,
        ])
      Nil
    }
    router.Local | router.OwnerUnavailable(_) -> Nil
  }
}

// The stored count, expired or not.
pub fn stored(user: Int, channel: Int) -> Option(Int) {
  case exists() {
    False -> None
    True ->
      case ets_lookup(name(), #(user, channel)) {
        [Row(count:, ..)] -> Some(count)
        _ -> None
      }
  }
}

pub fn size() -> Int {
  case exists() {
    True -> ets_info(name(), Size)
    False -> 0
  }
}

pub fn evict() -> Nil {
  case exists() {
    False -> Nil
    True -> {
      let row = atom.create("row")
      let any = atom.create("_")
      let var = atom.create("$1")
      let _ =
        ets_select_delete(name(), [
          #(
            #(row, any, any, var, any),
            [#(atom.create("<"), var, system_time(Second))],
            [True],
          ),
        ])
      let _ =
        ets_select_delete(name(), [
          #(
            #(row, any, any, any, var),
            [#(atom.create("=/="), var, router.version())],
            [True],
          ),
        ])
      trim(max_rows)
      metrics.gauge("push_unread_cap_rows", [], size())
    }
  }
}

pub fn trim(max: Int) -> Nil {
  let size = size()
  case size > max {
    True -> {
      let _ = ets_safe_fixtable(name(), True)
      trim_keys(ets_first(name()), size - max)
      let _ = ets_safe_fixtable(name(), False)
      Nil
    }
    False -> Nil
  }
}

fn trim_keys(key: Dynamic, remaining: Int) -> Nil {
  case remaining <= 0 || key == atom.to_dynamic(atom.create("$end_of_table")) {
    True -> Nil
    False -> {
      let next = ets_next(name(), key)
      let _ = ets_delete(name(), key)
      trim_keys(next, remaining - 1)
    }
  }
}
