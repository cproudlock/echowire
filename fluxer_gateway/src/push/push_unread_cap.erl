%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(push_unread_cap).
-typing([eqwalizer]).

%% Echowire: per user, per channel cap on push notifications sent since the channel was last
%% read. Past the cap a message still arrives in the app, it just does not buzz the phone.
%% See docs/adr/0009-cap-unread-push-notifications-per-channel.md.
%%
%% State is a node-local ETS table keyed {UserId, ChannelId}. It follows the same ownership
%% rule as push_ets_cache: the row for a user lives on the node gateway_node_router names as
%% that user's push owner. A node never counts for a user it does not own, it fails open
%% (sends) instead, so a routing mismatch costs extra pushes and never loses one.

-export([init/0, filter/4, admit/3, reset/2, evict/0, rebalance/0, stats/0]).
-export([cap/0]).

-define(TABLE, push_unread_cap).
-define(STATS_TABLE, push_unread_cap_stats).
-define(DEFAULT_CAP, 3).
-define(DEFAULT_TTL_SECONDS, 86400).
-define(MAX_ENTRIES, 500000).
-define(EVICT_BATCH, 4096).

-define(ETS_OPTS, [
    named_table, public, set, {read_concurrency, true}, {write_concurrency, true}
]).

-spec init() -> ok.
init() ->
    ensure_table(?TABLE),
    ensure_table(?STATS_TABLE),
    ok.

%% Keep the users that may be notified for this message, counting each one admitted.
-spec filter([integer()], integer(), integer(), map()) -> [integer()].
filter(UserIds, GuildId, ChannelId, MessageData) ->
    case cap() of
        0 ->
            UserIds;
        _ ->
            lists:filter(
                fun(UserId) ->
                    admit(UserId, ChannelId, is_priority(UserId, GuildId, MessageData))
                end,
                UserIds
            )
    end.

%% Priority messages (DMs, direct @mentions) always notify and do not use up the cap.
-spec admit(integer(), integer(), boolean()) -> boolean().
admit(_UserId, _ChannelId, true) ->
    true;
admit(UserId, ChannelId, false) ->
    case cap() of
        0 -> true;
        Cap -> admit_owned(owned_here(UserId), UserId, ChannelId, Cap)
    end.

-spec reset(integer(), integer()) -> ok.
reset(UserId, ChannelId) ->
    try ets:delete(?TABLE, {UserId, ChannelId}) of
        _ -> ok
    catch
        error:badarg -> ok
    end.

-spec evict() -> ok.
evict() ->
    Now = erlang:system_time(second),
    _ = safe_select_delete([{{'_', '_', '$1'}, [{'<', '$1', Now}], [true]}]),
    trim_to_max(table_size()),
    ok.

%% Drop rows this node no longer owns, after the node set changes. Same job as
%% push_ets_cache:rebalance/0. Losing a row only resets that user's count.
-spec rebalance() -> non_neg_integer().
rebalance() ->
    init(),
    Remote =
        try
            ets:foldl(
                fun({{UserId, _ChannelId} = Key, _Count, _ExpiresAt}, Acc) ->
                    case owned_here(UserId) of
                        false -> [Key | Acc];
                        true -> Acc
                    end
                end,
                [],
                ?TABLE
            )
        catch
            error:badarg -> []
        end,
    lists:foreach(fun(Key) -> ets:delete(?TABLE, Key) end, Remote),
    length(Remote).

-spec stats() -> map().
stats() ->
    #{
        unread_cap => cap(),
        unread_cap_size => table_size(),
        unread_cap_suppressed => stat(suppressed),
        unread_cap_not_owner => stat(not_owner)
    }.

-spec cap() -> non_neg_integer().
cap() ->
    case fluxer_gateway_env:get(push_unread_cap) of
        Value when is_integer(Value), Value >= 0 -> Value;
        _ -> ?DEFAULT_CAP
    end.

-spec admit_owned(boolean(), integer(), integer(), pos_integer()) -> boolean().
admit_owned(false, _UserId, _ChannelId, _Cap) ->
    bump(not_owner),
    true;
admit_owned(true, UserId, ChannelId, Cap) ->
    Key = {UserId, ChannelId},
    Now = erlang:system_time(second),
    try
        drop_if_expired(Key, Now),
        Count = ets:update_counter(
            ?TABLE, Key, {2, 1, Cap + 1, Cap + 1}, {Key, 0, Now + ttl_seconds()}
        ),
        admitted(Count =< Cap)
    catch
        error:badarg ->
            init(),
            true
    end.

-spec admitted(boolean()) -> boolean().
admitted(true) ->
    true;
admitted(false) ->
    bump(suppressed),
    false.

-spec drop_if_expired(term(), integer()) -> ok.
drop_if_expired(Key, Now) ->
    case ets:lookup(?TABLE, Key) of
        [{Key, _Count, ExpiresAt}] when ExpiresAt < Now ->
            ets:delete(?TABLE, Key),
            ok;
        _ ->
            ok
    end.

-spec is_priority(integer(), integer(), map()) -> boolean().
is_priority(_UserId, 0, _MessageData) ->
    true;
is_priority(UserId, _GuildId, MessageData) ->
    case maps:get(<<"mentions">>, MessageData, []) of
        Mentions when is_list(Mentions) ->
            push_eligibility_checks:is_user_in_mentions(UserId, Mentions);
        _ ->
            false
    end.

-spec owned_here(integer()) -> boolean().
owned_here(UserId) ->
    try gateway_node_router:owner_node_result(UserId, push) of
        {ok, OwnerNode} -> OwnerNode =:= node();
        {error, _Reason} -> false
    catch
        throw:_ -> false;
        error:_ -> false;
        exit:_ -> false
    end.

-spec ttl_seconds() -> pos_integer().
ttl_seconds() ->
    case fluxer_gateway_env:get(push_unread_cap_ttl_seconds) of
        Value when is_integer(Value), Value > 0 -> Value;
        _ -> ?DEFAULT_TTL_SECONDS
    end.

-spec trim_to_max(non_neg_integer()) -> ok.
trim_to_max(Size) when Size =< ?MAX_ENTRIES ->
    ok;
trim_to_max(_Size) ->
    trim_batch(first_key(), ?EVICT_BATCH).

-spec first_key() -> term().
first_key() ->
    try
        ets:first(?TABLE)
    catch
        error:badarg -> '$end_of_table'
    end.

-spec trim_batch(term(), non_neg_integer()) -> ok.
trim_batch('$end_of_table', _N) ->
    ok;
trim_batch(_Key, 0) ->
    ok;
trim_batch(Key, N) ->
    Next = ets:next(?TABLE, Key),
    ets:delete(?TABLE, Key),
    trim_batch(Next, N - 1).

-spec safe_select_delete(ets:match_spec()) -> non_neg_integer().
safe_select_delete(Spec) ->
    try
        ets:select_delete(?TABLE, Spec)
    catch
        error:badarg -> 0
    end.

-spec table_size() -> non_neg_integer().
table_size() ->
    case ets:info(?TABLE, size) of
        Size when is_integer(Size) -> Size;
        _ -> 0
    end.

-spec bump(atom()) -> ok.
bump(Name) ->
    try ets:update_counter(?STATS_TABLE, Name, 1, {Name, 0}) of
        _ -> ok
    catch
        error:badarg -> ok
    end.

-spec stat(atom()) -> non_neg_integer().
stat(Name) ->
    try ets:lookup(?STATS_TABLE, Name) of
        [{Name, Count}] -> Count;
        _ -> 0
    catch
        error:badarg -> 0
    end.

-spec ensure_table(atom()) -> ok.
ensure_table(Name) ->
    case ets:whereis(Name) of
        undefined ->
            try ets:new(Name, ?ETS_OPTS) of
                _ -> ok
            catch
                error:badarg -> ok
            end;
        _ ->
            ok
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

with_cap(Cap, Fun) ->
    init(),
    ets:delete_all_objects(?TABLE),
    ets:delete_all_objects(?STATS_TABLE),
    meck:new(fluxer_gateway_env, [passthrough, no_link]),
    meck:expect(fluxer_gateway_env, get, fun
        (push_unread_cap) -> Cap;
        (_) -> undefined
    end),
    meck:new(gateway_node_router, [passthrough, no_link]),
    meck:expect(gateway_node_router, owner_node_result, fun(_, _) -> {ok, node()} end),
    try
        Fun()
    after
        meck:unload(gateway_node_router),
        meck:unload(fluxer_gateway_env)
    end.

guild_message() -> #{<<"mentions">> => []}.

admits_up_to_the_cap_then_suppresses_test() ->
    with_cap(3, fun() ->
        Results = [filter([10], 1, 100, guild_message()) || _ <- lists:seq(1, 5)],
        ?assertEqual([[10], [10], [10], [], []], Results),
        ?assertEqual(2, maps:get(unread_cap_suppressed, stats()))
    end).

counts_per_user_and_per_channel_test() ->
    with_cap(1, fun() ->
        ?assertEqual([10, 11], filter([10, 11], 1, 100, guild_message())),
        ?assertEqual([], filter([10, 11], 1, 100, guild_message())),
        ?assertEqual([10], filter([10], 1, 200, guild_message()))
    end).

reset_reopens_the_channel_test() ->
    with_cap(1, fun() ->
        ?assertEqual([10], filter([10], 1, 100, guild_message())),
        ?assertEqual([], filter([10], 1, 100, guild_message())),
        ok = reset(10, 100),
        ?assertEqual([10], filter([10], 1, 100, guild_message()))
    end).

dms_bypass_and_do_not_count_test() ->
    with_cap(1, fun() ->
        [?assertEqual([10], filter([10], 0, 100, #{})) || _ <- lists:seq(1, 4)],
        ?assertEqual(0, maps:get(unread_cap_size, stats())),
        ?assertEqual([10], filter([10], 1, 100, guild_message()))
    end).

direct_mentions_bypass_and_do_not_count_test() ->
    with_cap(1, fun() ->
        Mentioned = #{<<"mentions">> => [#{<<"id">> => 10}]},
        ?assertEqual([10], filter([10], 1, 100, guild_message())),
        [?assertEqual([10], filter([10], 1, 100, Mentioned)) || _ <- lists:seq(1, 3)],
        ?assertEqual([], filter([10], 1, 100, guild_message()))
    end).

zero_disables_the_cap_test() ->
    with_cap(0, fun() ->
        [?assertEqual([10], filter([10], 1, 100, guild_message())) || _ <- lists:seq(1, 10)],
        ?assertEqual(0, maps:get(unread_cap_size, stats()))
    end).

expired_rows_start_over_test() ->
    with_cap(1, fun() ->
        ets:insert(?TABLE, {{10, 100}, 1, erlang:system_time(second) - 10}),
        ?assertEqual([10], filter([10], 1, 100, guild_message()))
    end).

evict_removes_only_expired_rows_test() ->
    with_cap(1, fun() ->
        Now = erlang:system_time(second),
        ets:insert(?TABLE, {{10, 100}, 1, Now - 10}),
        ets:insert(?TABLE, {{11, 100}, 1, Now + 1000}),
        ok = evict(),
        ?assertEqual([], ets:lookup(?TABLE, {10, 100})),
        ?assertMatch([_], ets:lookup(?TABLE, {11, 100}))
    end).

fails_open_for_users_this_node_does_not_own_test() ->
    with_cap(1, fun() ->
        meck:expect(gateway_node_router, owner_node_result, fun(_, _) ->
            {ok, 'other@host'}
        end),
        [?assertEqual([10], filter([10], 1, 100, guild_message())) || _ <- lists:seq(1, 4)],
        ?assertEqual(0, maps:get(unread_cap_size, stats())),
        ?assertEqual(4, maps:get(unread_cap_not_owner, stats()))
    end).

fails_open_when_routing_is_unavailable_test() ->
    with_cap(1, fun() ->
        meck:expect(gateway_node_router, owner_node_result, fun(_, _) -> {error, down} end),
        [?assertEqual([10], filter([10], 1, 100, guild_message())) || _ <- lists:seq(1, 3)]
    end).

rebalance_drops_only_rows_owned_elsewhere_test() ->
    with_cap(3, fun() ->
        meck:expect(gateway_node_router, owner_node_result, fun
            (10, _) -> {ok, node()};
            (_, _) -> {ok, 'other@host'}
        end),
        Exp = erlang:system_time(second) + 1000,
        ets:insert(?TABLE, [{{10, 100}, 1, Exp}, {{11, 100}, 1, Exp}]),
        ?assertEqual(1, rebalance()),
        ?assertMatch([_], ets:lookup(?TABLE, {10, 100})),
        ?assertEqual([], ets:lookup(?TABLE, {11, 100}))
    end).

-endif.
