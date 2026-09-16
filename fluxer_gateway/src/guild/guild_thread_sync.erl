%% SPDX-License-Identifier: AGPL-3.0-or-later

%% Echowire: THREAD_LIST_SYNC. A session learns about threads twice: every thread it can see is in
%% the guild payload at READY, and its own memberships arrive with the session payload as
%% thread_members. Neither covers the case where access arrives later: a role change or a channel
%% overwrite makes a parent channel visible, CHANNEL_CREATE announces the parent, and the threads
%% under it were never mentioned, so a client had to refetch
%% GET /guilds/{id}/threads/active to find them.
%%
%% This module answers that case. When a parent channel becomes visible to a session, it sends the
%% unarchived threads under that parent which the session may view. The payload carries no members
%% array: a session already knows its own memberships from READY and keeps them current through
%% THREAD_MEMBERS_UPDATE, and telling one session about another user's membership is exactly what
%% the private thread rules forbid.
-module(guild_thread_sync).
-typing([eqwalizer]).

-export([dispatch_for_parents/4, candidate_threads_under/2]).

-export_type([guild_state/0, channel_id/0]).

-type guild_state() :: map().
-type channel_id() :: integer().

-define(CHANNEL_TYPE_PUBLIC_THREAD, 11).
-define(CHANNEL_TYPE_PRIVATE_THREAD, 12).

%% One event per parent that gained visibility, and nothing at all for a parent with no visible
%% threads, so a plain text channel costs no dispatch.
-spec dispatch_for_parents([channel_id()], pid(), guild_state(), integer()) -> ok.
dispatch_for_parents(ParentIds, SessionPid, State, GuildId) when is_pid(SessionPid) ->
    case snowflake_id(GuildId) of
        undefined ->
            ok;
        ResolvedGuildId ->
            UserId = session_user_id(SessionPid, State),
            lists:foreach(
                fun(ParentId) ->
                    dispatch_for_parent(ParentId, SessionPid, State, ResolvedGuildId, UserId)
                end,
                ParentIds
            )
    end;
dispatch_for_parents(_ParentIds, _SessionPid, _State, _GuildId) ->
    ok.

-spec dispatch_for_parent(
    channel_id(), pid(), guild_state(), integer(), integer() | undefined
) -> ok.
dispatch_for_parent(_ParentId, _SessionPid, _State, _GuildId, undefined) ->
    ok;
dispatch_for_parent(ParentId, SessionPid, State, GuildId, UserId) ->
    case visible_threads_under(ParentId, UserId, State) of
        [] ->
            ok;
        Threads ->
            WithGuild = [
                Thread#{<<"guild_id">> => integer_to_binary(GuildId)}
             || Thread <- Threads
            ],
            Payload = #{
                <<"guild_id">> => integer_to_binary(GuildId),
                <<"channel_ids">> => [integer_to_binary(ParentId)],
                <<"threads">> => WithGuild,
                <<"members">> => []
            },
            gateway_dispatch_relay:dispatch(SessionPid, thread_list_sync, Payload, GuildId)
    end.

%% The unarchived threads under ParentId that this user may view. Selection is split in two: which
%% threads hang open under this parent, which is this module's own logic and unit tested below, and
%% whether the user may see one, which is the same live call the dispatch filter makes, so a
%% private thread the user is not a member of is absent.
-spec visible_threads_under(channel_id(), integer(), guild_state()) -> [map()].
visible_threads_under(ParentId, UserId, State) ->
    Member = guild_permissions:find_member_by_user_id(UserId, State),
    lists:filter(
        fun(Thread) ->
            case snowflake_id(maps:get(<<"id">>, Thread, undefined)) of
                undefined ->
                    false;
                ThreadId ->
                    guild_visibility_channels:channel_is_visible(UserId, ThreadId, Member, State)
            end
        end,
        candidate_threads_under(ParentId, State)
    ).

%% Every unarchived thread whose parent is ParentId, before any visibility test.
-spec candidate_threads_under(channel_id(), guild_state()) -> [map()].
candidate_threads_under(ParentId, State) ->
    Data = guild_permissions_common:resolve_data_map(State),
    Channels = guild_data_index:channel_list(Data),
    lists:filter(
        fun(Thread) ->
            is_unarchived_thread(Thread) andalso channel_parent_id(Thread) =:= ParentId
        end,
        Channels
    ).

-spec is_unarchived_thread(map()) -> boolean().
is_unarchived_thread(Channel) ->
    is_thread_type(channel_type(Channel)) andalso not is_archived(Channel).

-spec is_thread_type(integer() | undefined) -> boolean().
is_thread_type(?CHANNEL_TYPE_PUBLIC_THREAD) -> true;
is_thread_type(?CHANNEL_TYPE_PRIVATE_THREAD) -> true;
is_thread_type(_Other) -> false.

%% thread_metadata.archived is the stored shape; a thread without metadata counts as open.
-spec is_archived(map()) -> boolean().
is_archived(Channel) ->
    case maps:get(<<"thread_metadata">>, Channel, undefined) of
        Metadata when is_map(Metadata) -> maps:get(<<"archived">>, Metadata, false) =:= true;
        _ -> false
    end.

-spec channel_type(map()) -> integer() | undefined.
channel_type(Channel) ->
    case maps:get(<<"type">>, Channel, undefined) of
        Type when is_integer(Type) -> Type;
        Type when is_binary(Type) ->
            try binary_to_integer(Type) of
                Int -> Int
            catch
                error:badarg -> undefined
            end;
        _ -> undefined
    end.

-spec channel_parent_id(map()) -> channel_id() | undefined.
channel_parent_id(Channel) ->
    snowflake_id(maps:get(<<"parent_id">>, Channel, undefined)).

-spec session_user_id(pid(), guild_state()) -> integer() | undefined.
session_user_id(SessionPid, State) ->
    Sessions = map_utils:ensure_map(map_utils:get_safe(State, sessions, #{})),
    Found = maps:fold(
        fun
            (_SessionId, SessionData, undefined) when is_map(SessionData) ->
                case maps:get(pid, SessionData, undefined) of
                    SessionPid -> snowflake_id(maps:get(user_id, SessionData, undefined));
                    _ -> undefined
                end;
            (_SessionId, _SessionData, Acc) ->
                Acc
        end,
        undefined,
        Sessions
    ),
    Found.

-spec snowflake_id(term()) -> integer() | undefined.
snowflake_id(Value) ->
    case snowflake_id:parse_optional(Value) of
        Id when is_integer(Id), Id > 0 -> Id;
        _ -> undefined
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

sync_test_state() ->
    Parent = #{<<"id">> => <<"10">>, <<"type">> => 0, <<"permission_overwrites">> => []},
    OtherParent = #{<<"id">> => <<"11">>, <<"type">> => 0, <<"permission_overwrites">> => []},
    Open = #{
        <<"id">> => <<"20">>,
        <<"type">> => 11,
        <<"parent_id">> => <<"10">>,
        <<"permission_overwrites">> => []
    },
    Archived = #{
        <<"id">> => <<"21">>,
        <<"type">> => 11,
        <<"parent_id">> => <<"10">>,
        <<"thread_metadata">> => #{<<"archived">> => true},
        <<"permission_overwrites">> => []
    },
    Elsewhere = #{
        <<"id">> => <<"22">>,
        <<"type">> => 11,
        <<"parent_id">> => <<"11">>,
        <<"permission_overwrites">> => []
    },
    Private = #{
        <<"id">> => <<"23">>,
        <<"type">> => 12,
        <<"parent_id">> => <<"10">>,
        <<"thread_member_ids">> => [<<"77">>],
        <<"permission_overwrites">> => []
    },
    #{
        data => guild_data_index:put_channels(
            [Parent, OtherParent, Open, Archived, Elsewhere, Private], #{}
        )
    }.

thread_ids(Threads) ->
    lists:sort([maps:get(<<"id">>, Thread) || Thread <- Threads]).

candidates_take_open_threads_of_that_parent_test() ->
    State = sync_test_state(),
    %% put_channels normalises ids to integers, which is what the index stores.
    ?assertEqual([20, 23], thread_ids(candidate_threads_under(10, State))).

candidates_skip_archived_threads_test() ->
    State = sync_test_state(),
    ?assertEqual(false, lists:member(21, thread_ids(candidate_threads_under(10, State)))).

candidates_skip_another_parents_threads_test() ->
    State = sync_test_state(),
    ?assertEqual([22], thread_ids(candidate_threads_under(11, State))).

candidates_are_empty_for_a_parent_with_no_threads_test() ->
    State = sync_test_state(),
    ?assertEqual([], candidate_threads_under(99, State)).

%% A parent with nothing open under it costs no dispatch, so a plain channel gaining visibility
%% sends CHANNEL_CREATE and nothing else.
dispatch_sends_nothing_without_candidates_test() ->
    State = sync_test_state(),
    ?assertEqual(ok, dispatch_for_parents([99], self(), State, 5)),
    ?assertEqual(ok, receive_nothing()).

receive_nothing() ->
    receive
        Message -> {unexpected, Message}
    after 0 -> ok
    end.

-endif.
