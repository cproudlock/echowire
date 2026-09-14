%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_state_channels).
-typing([eqwalizer]).

-export([
    handle_channel_create/2,
    handle_channel_update/2,
    handle_channel_update_bulk/2,
    handle_channel_delete/2,
    handle_message_create/2,
    handle_thread_members_update/2,
    thread_membership_user_ids/2,
    handle_channel_pins_update/2,
    handle_emojis_update/2,
    handle_stickers_update/2,
    handle_guild_update/2,
    extract_channel_ids_from_channel_update/1,
    extract_channel_ids_from_channel_update_bulk/1
]).

-type guild_data() :: map().
-type event_data() :: map().

-export_type([guild_data/0, event_data/0]).

-spec handle_guild_update(event_data(), guild_data()) -> guild_data().
handle_guild_update(EventData, Data) ->
    Guild = maps:get(<<"guild">>, Data),
    UpdatedGuild = maps:merge(Guild, EventData),
    Data#{<<"guild">> => UpdatedGuild}.

-spec handle_channel_create(event_data(), guild_data()) -> guild_data().
handle_channel_create(EventData, Data) ->
    Channels = guild_data_index:channel_list(Data),
    guild_data_index:put_channels([EventData | Channels], Data).

-spec handle_channel_update(event_data(), guild_data()) -> guild_data().
handle_channel_update(EventData, Data) ->
    Channels = guild_data_index:channel_list(Data),
    ChannelId = maps:get(<<"id">>, EventData),
    UpdatedChannels = guild_state_utils:replace_item_by_id(Channels, ChannelId, EventData),
    guild_data_index:put_channels(UpdatedChannels, Data).

-spec handle_channel_update_bulk(event_data(), guild_data()) -> guild_data().
handle_channel_update_bulk(EventData, Data) ->
    Channels = guild_data_index:channel_list(Data),
    BulkChannels = maps:get(<<"channels">>, EventData, []),
    UpdatedChannels = guild_state_utils:bulk_update_items(Channels, BulkChannels),
    guild_data_index:put_channels(UpdatedChannels, Data).

-spec handle_channel_delete(event_data(), guild_data()) -> guild_data().
handle_channel_delete(EventData, Data) ->
    Channels = guild_data_index:channel_list(Data),
    ChannelId = maps:get(<<"id">>, EventData),
    FilteredChannels = guild_state_utils:remove_item_by_id(Channels, ChannelId),
    guild_data_index:put_channels(FilteredChannels, Data).

-spec handle_message_create(event_data(), guild_data()) -> guild_data().
handle_message_create(EventData, Data) ->
    ChannelId = snowflake_id:parse_optional(
        maps:get(<<"channel_id">>, EventData, undefined)
    ),
    MessageId = snowflake_id:parse_optional(maps:get(<<"id">>, EventData, undefined)),
    update_channel_field_fast(Data, ChannelId, <<"last_message_id">>, MessageId).

%% Echowire: keep a private thread's member ids in step with joins and leaves, so permission
%% resolution admits its members (see guild_permissions_overwrites). Public threads do not need
%% the list, so it is not maintained for them.
-spec handle_thread_members_update(event_data(), guild_data()) -> guild_data().
handle_thread_members_update(EventData, Data) ->
    ThreadId = snowflake_id:parse_optional(maps:get(<<"id">>, EventData, undefined)),
    case ThreadId of
        undefined ->
            Data;
        _ ->
            case maps:find(ThreadId, guild_data_index:channel_index(Data)) of
                {ok, Channel} when is_map(Channel) ->
                    maybe_update_private_members(Data, ThreadId, Channel, EventData);
                _ ->
                    Data
            end
    end.

-spec maybe_update_private_members(guild_data(), integer(), map(), event_data()) -> guild_data().
maybe_update_private_members(Data, ThreadId, Channel, EventData) ->
    case is_private_thread(Channel) of
        false ->
            Data;
        true ->
            Current = normalize_member_ids(maps:get(<<"thread_member_ids">>, Channel, [])),
            AddedMembers = list_or_empty(maps:get(<<"added_members">>, EventData, [])),
            Added = normalize_member_ids(
                [maps:get(<<"user_id">>, M, undefined) || M <- AddedMembers, is_map(M)]
            ),
            Removed = normalize_member_ids(maps:get(<<"removed_member_ids">>, EventData, [])),
            Next = lists:usort(Current ++ Added) -- Removed,
            update_channel_field_fast(
                Data, ThreadId, <<"thread_member_ids">>, [integer_to_binary(Id) || Id <- Next]
            )
    end.

%% Echowire: users whose private-thread access may have changed with this event: everyone added
%% or removed by THREAD_MEMBERS_UPDATE, and the old and new members of a private THREAD_UPDATE.
-spec thread_membership_user_ids(event_data(), guild_data()) -> [integer()].
thread_membership_user_ids(EventData, Data) ->
    AddedMembers = list_or_empty(maps:get(<<"added_members">>, EventData, [])),
    Added = normalize_member_ids(
        [maps:get(<<"user_id">>, M, undefined) || M <- AddedMembers, is_map(M)]
    ),
    Removed = normalize_member_ids(maps:get(<<"removed_member_ids">>, EventData, [])),
    Payload = normalize_member_ids(maps:get(<<"thread_member_ids">>, EventData, [])),
    Previous =
        case snowflake_id:parse_optional(maps:get(<<"id">>, EventData, undefined)) of
            undefined ->
                [];
            ThreadId ->
                case maps:find(ThreadId, guild_data_index:channel_index(Data)) of
                    {ok, Channel} when is_map(Channel) ->
                        normalize_member_ids(maps:get(<<"thread_member_ids">>, Channel, []));
                    _ ->
                        []
                end
        end,
    lists:usort(Added ++ Removed ++ Payload ++ Previous).

-spec is_private_thread(map()) -> boolean().
is_private_thread(Channel) ->
    case maps:get(<<"type">>, Channel, undefined) of
        12 -> true;
        <<"12">> -> true;
        _ -> false
    end.

-spec normalize_member_ids(term()) -> [integer()].
normalize_member_ids(Ids) when is_list(Ids) ->
    [Id || Raw <- Ids, Id <- [snowflake_id:parse_optional(Raw)], is_integer(Id)];
normalize_member_ids(_) ->
    [].

-spec list_or_empty(term()) -> list().
list_or_empty(L) when is_list(L) -> L;
list_or_empty(_) -> [].

-spec handle_channel_pins_update(event_data(), guild_data()) -> guild_data().
handle_channel_pins_update(EventData, Data) ->
    ChannelId = snowflake_id:parse_optional(
        maps:get(<<"channel_id">>, EventData, undefined)
    ),
    LastPin = maps:get(<<"last_pin_timestamp">>, EventData),
    update_channel_field_fast(Data, ChannelId, <<"last_pin_timestamp">>, LastPin).

-spec update_channel_field_fast(guild_data(), integer() | undefined, binary(), term()) ->
    guild_data().
update_channel_field_fast(Data, undefined, _, _) ->
    Data;
update_channel_field_fast(Data, ChannelId, Field, Value) ->
    Index = guild_data_index:channel_index(Data),
    case maps:find(ChannelId, Index) of
        {ok, Channel} ->
            Updated = Channel#{Field => Value},
            Data#{
                <<"channel_index">> => Index#{ChannelId => Updated},
                channels_stale => true
            };
        error ->
            Data
    end.

-spec handle_emojis_update(event_data(), guild_data()) -> guild_data().
handle_emojis_update(EventData, Data) ->
    Data#{<<"emojis">> => maps:get(<<"emojis">>, EventData, [])}.

-spec handle_stickers_update(event_data(), guild_data()) -> guild_data().
handle_stickers_update(EventData, Data) ->
    Data#{<<"stickers">> => maps:get(<<"stickers">>, EventData, [])}.

-spec extract_channel_ids_from_channel_update(event_data()) -> [integer()].
extract_channel_ids_from_channel_update(EventData) ->
    case snowflake_id:parse_optional(maps:get(<<"id">>, EventData, undefined)) of
        undefined -> [];
        ChannelId -> [ChannelId]
    end.

-spec extract_channel_ids_from_channel_update_bulk(event_data()) -> [integer()].
extract_channel_ids_from_channel_update_bulk(EventData) ->
    Channels = maps:get(<<"channels">>, EventData, []),
    lists:filtermap(fun extract_channel_id/1, Channels).

-spec extract_channel_id(map()) -> false | {true, integer()}.
extract_channel_id(ChannelData) ->
    case snowflake_id:parse_optional(maps:get(<<"id">>, ChannelData, undefined)) of
        undefined -> false;
        ChannelId -> {true, ChannelId}
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

handle_channel_create_test() ->
    Data = #{<<"channels">> => []},
    EventData = #{<<"id">> => <<"100">>, <<"name">> => <<"general">>},
    Result = handle_channel_create(EventData, Data),
    Channels = maps:get(<<"channels">>, Result),
    ?assertEqual(1, length(Channels)).

handle_channel_update_test() ->
    Data = #{
        <<"channels">> => [
            #{<<"id">> => <<"100">>, <<"name">> => <<"old">>},
            #{<<"id">> => <<"101">>, <<"name">> => <<"keep">>}
        ]
    },
    EventData = #{<<"id">> => <<"100">>, <<"name">> => <<"updated">>},
    Result = handle_channel_update(EventData, Data),
    Channels = guild_data_index:channel_list(Result),
    [C1, C2] = Channels,
    ?assertEqual(<<"updated">>, maps:get(<<"name">>, C1)),
    ?assertEqual(<<"keep">>, maps:get(<<"name">>, C2)).

handle_channel_update_bulk_test() ->
    Data = #{
        <<"channels">> => [
            #{<<"id">> => <<"1">>, <<"name">> => <<"A">>},
            #{<<"id">> => <<"2">>, <<"name">> => <<"B">>}
        ]
    },
    EventData = #{
        <<"channels">> => [
            #{<<"id">> => <<"2">>, <<"name">> => <<"B2">>}
        ]
    },
    Result = handle_channel_update_bulk(EventData, Data),
    Channels = guild_data_index:channel_list(Result),
    [C1, C2] = Channels,
    ?assertEqual(<<"A">>, maps:get(<<"name">>, C1)),
    ?assertEqual(<<"B2">>, maps:get(<<"name">>, C2)).

handle_channel_delete_test() ->
    Data = #{
        <<"channels">> => [
            #{<<"id">> => <<"100">>, <<"name">> => <<"general">>},
            #{<<"id">> => <<"101">>, <<"name">> => <<"random">>}
        ]
    },
    EventData = #{<<"id">> => <<"100">>},
    Result = handle_channel_delete(EventData, Data),
    Channels = guild_data_index:channel_list(Result),
    ?assertEqual(1, length(Channels)),
    ?assertEqual(<<"random">>, maps:get(<<"name">>, hd(Channels))).

handle_message_create_updates_last_message_id_test() ->
    Data = #{
        <<"channels">> => [
            #{<<"id">> => <<"100">>, <<"last_message_id">> => <<"500">>},
            #{<<"id">> => <<"101">>, <<"last_message_id">> => <<"600">>}
        ]
    },
    EventData = #{<<"channel_id">> => <<"100">>, <<"id">> => <<"700">>},
    Result = handle_message_create(EventData, Data),
    Channels = guild_data_index:channel_list(Result),
    [C1, C2] = Channels,
    ?assertEqual(700, maps:get(<<"last_message_id">>, C1)),
    ?assertEqual(600, maps:get(<<"last_message_id">>, C2)).

handle_channel_pins_update_test() ->
    Data = #{
        <<"channels">> => [
            #{<<"id">> => <<"100">>}
        ]
    },
    Ts = <<"2024-01-01T00:00:00Z">>,
    EventData = #{<<"channel_id">> => <<"100">>, <<"last_pin_timestamp">> => Ts},
    Result = handle_channel_pins_update(EventData, Data),
    [Ch] = guild_data_index:channel_list(Result),
    ?assertEqual(<<"2024-01-01T00:00:00Z">>, maps:get(<<"last_pin_timestamp">>, Ch)).

handle_emojis_update_test() ->
    Data = #{<<"emojis">> => []},
    EventData = #{<<"emojis">> => [#{<<"id">> => <<"1">>}]},
    Result = handle_emojis_update(EventData, Data),
    ?assertEqual([#{<<"id">> => <<"1">>}], maps:get(<<"emojis">>, Result)).

handle_stickers_update_test() ->
    Data = #{<<"stickers">> => []},
    EventData = #{<<"stickers">> => [#{<<"id">> => <<"1">>}]},
    Result = handle_stickers_update(EventData, Data),
    ?assertEqual([#{<<"id">> => <<"1">>}], maps:get(<<"stickers">>, Result)).

handle_guild_update_merges_fields_test() ->
    Data = #{
        <<"guild">> => #{<<"name">> => <<"Old">>, <<"icon">> => <<"abc">>},
        <<"roles">> => [],
        <<"members">> => [],
        <<"channels">> => []
    },
    EventData = #{<<"name">> => <<"New">>, <<"description">> => <<"desc">>},
    Result = handle_guild_update(EventData, Data),
    Guild = maps:get(<<"guild">>, Result),
    ?assertEqual(<<"New">>, maps:get(<<"name">>, Guild)),
    ?assertEqual(<<"abc">>, maps:get(<<"icon">>, Guild)),
    ?assertEqual(<<"desc">>, maps:get(<<"description">>, Guild)).

extract_channel_ids_from_channel_update_test() ->
    ?assertEqual([42], extract_channel_ids_from_channel_update(#{<<"id">> => <<"42">>})),
    ?assertEqual([], extract_channel_ids_from_channel_update(#{})).

extract_channel_ids_from_channel_update_bulk_test() ->
    EventData = #{
        <<"channels">> => [
            #{<<"id">> => <<"10">>},
            #{<<"id">> => <<"11">>},
            #{<<"name">> => <<"missing_id">>}
        ]
    },
    ?assertEqual([10, 11], extract_channel_ids_from_channel_update_bulk(EventData)).

thread_members_update_tracks_private_thread_members_test() ->
    Private = #{
        <<"id">> => <<"21">>,
        <<"type">> => 12,
        <<"parent_id">> => <<"10">>,
        <<"thread_member_ids">> => [<<"5">>]
    },
    Public = #{<<"id">> => <<"22">>, <<"type">> => 11, <<"parent_id">> => <<"10">>},
    Data0 = guild_data_index:put_channels([Private, Public], #{}),
    Data1 = handle_thread_members_update(
        #{<<"id">> => <<"21">>, <<"added_members">> => [#{<<"user_id">> => <<"7">>}]}, Data0
    ),
    ?assertEqual(
        [<<"5">>, <<"7">>],
        maps:get(<<"thread_member_ids">>, maps:get(21, guild_data_index:channel_index(Data1)))
    ),
    Data2 = handle_thread_members_update(
        #{<<"id">> => <<"21">>, <<"removed_member_ids">> => [<<"5">>]}, Data1
    ),
    ?assertEqual(
        [<<"7">>],
        maps:get(<<"thread_member_ids">>, maps:get(21, guild_data_index:channel_index(Data2)))
    ),
    Data3 = handle_thread_members_update(
        #{<<"id">> => <<"22">>, <<"added_members">> => [#{<<"user_id">> => <<"7">>}]}, Data0
    ),
    PublicAfter = maps:get(22, guild_data_index:channel_index(Data3)),
    ?assertEqual(false, maps:is_key(<<"thread_member_ids">>, PublicAfter)).

-endif.
