%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_permissions_overwrites).
-typing([eqwalizer]).

-export([
    apply_channel_overwrites/5,
    apply_cached_overwrites/5,
    maybe_apply_channel_overwrites/6
]).

-export_type([
    permission/0,
    user_id/0,
    role_id/0,
    member_roles/0,
    channel/0,
    guild_state/0,
    maybe_channel_id/0
]).

-type permission() :: non_neg_integer().
-type user_id() :: integer().
-type role_id() :: integer().
-type member_roles() :: [role_id()].
-type channel() :: map().
-type overwrite() :: map().
-type guild_state() :: map().
-type maybe_channel_id() :: integer() | undefined.

%% Echowire: thread channel types. Threads and forum posts carry no overwrites of their own.
-define(CHANNEL_TYPE_PUBLIC_THREAD, 11).
-define(CHANNEL_TYPE_PRIVATE_THREAD, 12).

-spec apply_channel_overwrites(
    permission(), user_id() | undefined, member_roles(), channel(), role_id()
) -> permission().
apply_channel_overwrites(BasePerms, UserId, MemberRoles, Channel, EveryoneRoleId) ->
    Overwrites = channel_overwrites(Channel),
    EveryonePerms = apply_everyone_overwrites(BasePerms, Overwrites, EveryoneRoleId),
    {RoleAllow, RoleDeny} = accumulate_role_overwrites(MemberRoles, Overwrites),
    RolePerms = permission_bits:apply_allow_deny(EveryonePerms, RoleAllow, RoleDeny),
    apply_user_overwrites(RolePerms, Overwrites, UserId).

-spec apply_cached_overwrites(
    permission(),
    user_id(),
    member_roles(),
    [{integer(), integer(), integer(), integer()}],
    role_id()
) -> permission().
apply_cached_overwrites(BasePerms, UserId, MemberRoles, CachedOWs, EveryoneRoleId) ->
    EveryonePerms = apply_cached_everyone(BasePerms, CachedOWs, EveryoneRoleId),
    {RoleAllow, RoleDeny} = accumulate_cached_roles(MemberRoles, CachedOWs),
    RolePerms = permission_bits:apply_allow_deny(EveryonePerms, RoleAllow, RoleDeny),
    apply_cached_user(RolePerms, CachedOWs, UserId).

-spec maybe_apply_channel_overwrites(
    permission(), user_id(), member_roles(), maybe_channel_id(), role_id(), guild_state()
) -> permission().
maybe_apply_channel_overwrites(Permissions, _UserId, _MemberRoles, undefined, _GuildId, _State) ->
    Permissions;
maybe_apply_channel_overwrites(Permissions, UserId, MemberRoles, ChannelId, GuildId, State) when
    is_integer(ChannelId)
->
    %% Echowire: a thread resolves against its parent channel's overwrites, and a private thread
    %% loses VIEW_CHANNEL for anyone without MANAGE_CHANNELS on the parent. The API applies the
    %% same rules (ThreadAccess.ts) and additionally admits private thread members, which the
    %% gateway cannot see.
    case thread_parent(ChannelId, State) of
        {thread, ThreadType, ParentId} ->
            ParentPerms = apply_non_thread_overwrites(
                Permissions, UserId, MemberRoles, ParentId, GuildId, State
            ),
            restrict_thread_permissions(ThreadType, ParentPerms);
        orphan_thread ->
            permission_bits:remove(Permissions, constants:view_channel_permission());
        not_thread ->
            apply_non_thread_overwrites(Permissions, UserId, MemberRoles, ChannelId, GuildId, State)
    end;
maybe_apply_channel_overwrites(
    Permissions, _UserId, _MemberRoles, _ChannelId, _GuildId, _State
) ->
    Permissions.

-spec thread_parent(integer(), guild_state()) ->
    {thread, integer(), integer()} | orphan_thread | not_thread.
thread_parent(ChannelId, State) ->
    case guild_permissions_check:find_channel_by_id(ChannelId, State) of
        Channel when is_map(Channel) -> classify_thread(Channel);
        _ -> not_thread
    end.

-spec classify_thread(channel()) -> {thread, integer(), integer()} | orphan_thread | not_thread.
classify_thread(Channel) ->
    case channel_type(Channel) of
        Type when Type =:= ?CHANNEL_TYPE_PUBLIC_THREAD; Type =:= ?CHANNEL_TYPE_PRIVATE_THREAD ->
            case snowflake_id:parse_maybe(maps:get(<<"parent_id">>, Channel, undefined)) of
                ParentId when is_integer(ParentId) -> {thread, Type, ParentId};
                _ -> orphan_thread
            end;
        _ ->
            not_thread
    end.

-spec channel_type(channel()) -> integer() | undefined.
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

-spec restrict_thread_permissions(integer(), permission()) -> permission().
restrict_thread_permissions(?CHANNEL_TYPE_PRIVATE_THREAD, Perms) ->
    case permission_bits:has(Perms, constants:manage_channels_permission()) of
        true -> Perms;
        false -> permission_bits:remove(Perms, constants:view_channel_permission())
    end;
restrict_thread_permissions(_Type, Perms) ->
    Perms.

-spec apply_non_thread_overwrites(
    permission(), user_id(), member_roles(), integer(), role_id(), guild_state()
) -> permission().
apply_non_thread_overwrites(Permissions, UserId, MemberRoles, ChannelId, GuildId, State) ->
    Data = guild_permissions_common:resolve_data_map(State),
    OverwriteCache = overwrite_cache_from_data(Data),
    case maps:get(ChannelId, OverwriteCache, undefined) of
        CachedOWs when is_list(CachedOWs) ->
            apply_cached_overwrites(Permissions, UserId, MemberRoles, CachedOWs, GuildId);
        _ ->
            apply_from_channel_lookup(
                Permissions, UserId, MemberRoles, ChannelId, GuildId, State
            )
    end.

-spec apply_from_channel_lookup(
    permission(), user_id(), member_roles(), integer(), role_id(), guild_state()
) -> permission().
apply_from_channel_lookup(Permissions, UserId, MemberRoles, ChannelId, GuildId, State) ->
    case guild_permissions_check:find_channel_by_id(ChannelId, State) of
        undefined -> Permissions;
        Channel -> apply_channel_overwrites(Permissions, UserId, MemberRoles, Channel, GuildId)
    end.

-spec overwrite_cache_from_data(map() | undefined) -> map().
overwrite_cache_from_data(D) when is_map(D) ->
    maps:get(overwrite_perms_cache, D, #{});
overwrite_cache_from_data(_) ->
    #{}.

-spec channel_overwrites(channel()) -> [overwrite()].
channel_overwrites(Channel) ->
    case maps:get(<<"permission_overwrites">>, Channel, []) of
        Overwrites when is_list(Overwrites) -> Overwrites;
        _ -> []
    end.

-spec apply_everyone_overwrites(permission(), [overwrite()], role_id()) -> permission().
apply_everyone_overwrites(BasePerms, Overwrites, EveryoneRoleId) ->
    lists:foldl(
        fun(Overwrite, Acc) ->
            apply_everyone_overwrite(Overwrite, EveryoneRoleId, Acc)
        end,
        BasePerms,
        Overwrites
    ).

-spec apply_everyone_overwrite(overwrite(), role_id(), permission()) -> permission().
apply_everyone_overwrite(Overwrite, EveryoneRoleId, Acc) ->
    case overwrite_matches_role(Overwrite, EveryoneRoleId) of
        true -> apply_overwrite_allow_deny(Acc, Overwrite);
        false -> Acc
    end.

-spec accumulate_role_overwrites(member_roles(), [overwrite()]) -> {permission(), permission()}.
accumulate_role_overwrites(MemberRoles, Overwrites) ->
    lists:foldl(
        fun(RoleId, {AllowAcc, DenyAcc}) ->
            accumulate_single_role(RoleId, Overwrites, AllowAcc, DenyAcc)
        end,
        {0, 0},
        MemberRoles
    ).

-spec accumulate_single_role(role_id(), [overwrite()], permission(), permission()) ->
    {permission(), permission()}.
accumulate_single_role(RoleId, Overwrites, AllowAcc, DenyAcc) ->
    lists:foldl(
        fun(Overwrite, {A, D}) ->
            accumulate_role_overwrite(Overwrite, RoleId, A, D)
        end,
        {AllowAcc, DenyAcc},
        Overwrites
    ).

-spec accumulate_role_overwrite(overwrite(), role_id(), permission(), permission()) ->
    {permission(), permission()}.
accumulate_role_overwrite(Overwrite, RoleId, AllowAcc, DenyAcc) ->
    case overwrite_matches_role(Overwrite, RoleId) of
        true -> accumulate_overwrite_allow_deny(AllowAcc, DenyAcc, Overwrite);
        false -> {AllowAcc, DenyAcc}
    end.

-spec apply_user_overwrites(permission(), [overwrite()], user_id() | undefined) -> permission().
apply_user_overwrites(Perms, Overwrites, UserId) ->
    lists:foldl(
        fun(Overwrite, Acc) ->
            apply_user_overwrite(Overwrite, UserId, Acc)
        end,
        Perms,
        Overwrites
    ).

-spec apply_user_overwrite(overwrite(), user_id() | undefined, permission()) -> permission().
apply_user_overwrite(Overwrite, UserId, Acc) when is_integer(UserId) ->
    case overwrite_matches_user(Overwrite, UserId) of
        true -> apply_overwrite_allow_deny(Acc, Overwrite);
        false -> Acc
    end;
apply_user_overwrite(_Overwrite, _UserId, Acc) ->
    Acc.

-spec apply_cached_everyone(
    permission(), [{integer(), integer(), integer(), integer()}], role_id()
) -> permission().
apply_cached_everyone(BasePerms, CachedOWs, EveryoneRoleId) ->
    lists:foldl(
        fun
            ({OWId, 0, Allow, Deny}, Acc) when OWId =:= EveryoneRoleId ->
                apply_allow_deny(Acc, Allow, Deny);
            (_, Acc) ->
                Acc
        end,
        BasePerms,
        CachedOWs
    ).

-spec accumulate_cached_roles(member_roles(), [{integer(), integer(), integer(), integer()}]) ->
    {permission(), permission()}.
accumulate_cached_roles(MemberRoles, CachedOWs) ->
    lists:foldl(
        fun(RoleId, {AAcc, DAcc}) ->
            accumulate_cached_role(RoleId, CachedOWs, {AAcc, DAcc})
        end,
        {0, 0},
        MemberRoles
    ).

-spec accumulate_cached_role(
    role_id(), [{integer(), integer(), integer(), integer()}], {permission(), permission()}
) -> {permission(), permission()}.
accumulate_cached_role(RoleId, CachedOWs, Acc) ->
    lists:foldl(
        fun
            ({OWId, 0, Allow, Deny}, {A, D}) when OWId =:= RoleId ->
                {permission_bits:add(A, Allow), permission_bits:add(D, Deny)};
            (_, AD) ->
                AD
        end,
        Acc,
        CachedOWs
    ).

-spec apply_cached_user(
    permission(), [{integer(), integer(), integer(), integer()}], user_id()
) ->
    permission().
apply_cached_user(RolePerms, CachedOWs, UserId) ->
    lists:foldl(
        fun
            ({OWId, 1, Allow, Deny}, Acc) when OWId =:= UserId ->
                apply_allow_deny(Acc, Allow, Deny);
            (_, Acc) ->
                Acc
        end,
        RolePerms,
        CachedOWs
    ).

-spec overwrite_matches_role(overwrite(), role_id()) -> boolean().
overwrite_matches_role(Overwrite, RoleId) when is_map(Overwrite), is_integer(RoleId) ->
    overwrite_type(Overwrite) =:= 0 andalso overwrite_id(Overwrite) =:= RoleId;
overwrite_matches_role(_, _) ->
    false.

-spec overwrite_matches_user(overwrite(), user_id()) -> boolean().
overwrite_matches_user(Overwrite, UserId) when is_map(Overwrite), is_integer(UserId) ->
    overwrite_type(Overwrite) =:= 1 andalso overwrite_id(Overwrite) =:= UserId;
overwrite_matches_user(_, _) ->
    false.

-spec overwrite_id(overwrite()) -> integer() | undefined.
overwrite_id(Overwrite) ->
    snowflake_id:parse_optional(maps:get(<<"id">>, Overwrite, undefined)).

-spec overwrite_type(overwrite()) -> integer() | undefined.
overwrite_type(Overwrite) ->
    case map_utils:get_integer(Overwrite, <<"type">>, undefined) of
        V when is_integer(V) -> V;
        _ -> undefined
    end.

-spec overwrite_allow(overwrite()) -> permission() | undefined.
overwrite_allow(Overwrite) ->
    permission_bits:parse(maps:get(<<"allow">>, Overwrite, undefined)).

-spec overwrite_deny(overwrite()) -> permission() | undefined.
overwrite_deny(Overwrite) ->
    permission_bits:parse(maps:get(<<"deny">>, Overwrite, undefined)).

-spec apply_overwrite_allow_deny(permission(), overwrite()) -> permission().
apply_overwrite_allow_deny(Acc, Overwrite) ->
    case {overwrite_allow(Overwrite), overwrite_deny(Overwrite)} of
        {Allow, Deny} when is_integer(Allow), is_integer(Deny) ->
            apply_allow_deny(Acc, Allow, Deny);
        _ ->
            Acc
    end.

-spec accumulate_overwrite_allow_deny(permission(), permission(), overwrite()) ->
    {permission(), permission()}.
accumulate_overwrite_allow_deny(AllowAcc, DenyAcc, Overwrite) ->
    case {overwrite_allow(Overwrite), overwrite_deny(Overwrite)} of
        {Allow, Deny} when is_integer(Allow), is_integer(Deny) ->
            {permission_bits:add(AllowAcc, Allow), permission_bits:add(DenyAcc, Deny)};
        _ ->
            {AllowAcc, DenyAcc}
    end.

-spec apply_allow_deny(permission(), permission(), permission()) -> permission().
apply_allow_deny(Acc, Allow, Deny) ->
    permission_bits:apply_allow_deny(Acc, Allow, Deny).

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

apply_channel_overwrites_e2e_test() ->
    View = constants:view_channel_permission(),
    GuildId = 5,
    RoleId = 9,
    UserId = 11,
    Channel = #{
        <<"permission_overwrites">> => [
            #{
                <<"id">> => integer_to_binary(GuildId),
                <<"type">> => 0,
                <<"allow">> => <<"0">>,
                <<"deny">> => integer_to_binary(View)
            },
            #{
                <<"id">> => integer_to_binary(RoleId),
                <<"type">> => 0,
                <<"allow">> => integer_to_binary(View),
                <<"deny">> => <<"0">>
            },
            #{
                <<"id">> => integer_to_binary(UserId),
                <<"type">> => 1,
                <<"allow">> => <<"0">>,
                <<"deny">> => integer_to_binary(View)
            }
        ]
    },
    Base = View,
    Result = apply_channel_overwrites(Base, UserId, [RoleId], Channel, GuildId),
    ?assertEqual(0, Result).

cached_overwrites_matches_uncached_test() ->
    View = constants:view_channel_permission(),
    GuildId = 5,
    UserId = 11,
    Channel = #{
        <<"id">> => <<"10">>,
        <<"permission_overwrites">> => [
            #{
                <<"id">> => <<"5">>,
                <<"type">> => 0,
                <<"allow">> => <<"0">>,
                <<"deny">> => integer_to_binary(View)
            },
            #{
                <<"id">> => <<"9">>,
                <<"type">> => 0,
                <<"allow">> => integer_to_binary(View),
                <<"deny">> => <<"0">>
            },
            #{
                <<"id">> => <<"11">>,
                <<"type">> => 1,
                <<"allow">> => <<"8">>,
                <<"deny">> => <<"0">>
            }
        ]
    },
    MemberRoles = [9],
    BasePerms = permission_bits:add(View, 16),
    Uncached = apply_channel_overwrites(BasePerms, UserId, MemberRoles, Channel, GuildId),
    Channels = [Channel],
    OverwriteCache = guild_data_index:build_overwrite_perms_cache(Channels),
    CachedOWs = maps:get(10, OverwriteCache),
    Cached = apply_cached_overwrites(BasePerms, UserId, MemberRoles, CachedOWs, GuildId),
    ?assertEqual(Uncached, Cached).

%% Echowire: thread permission resolution.

thread_test_state() ->
    View = constants:view_channel_permission(),
    Parent = #{
        <<"id">> => <<"10">>,
        <<"type">> => 0,
        <<"permission_overwrites">> => [
            #{
                <<"id">> => <<"5">>,
                <<"type">> => 0,
                <<"allow">> => <<"0">>,
                <<"deny">> => integer_to_binary(View)
            },
            #{
                <<"id">> => <<"9">>,
                <<"type">> => 0,
                <<"allow">> => integer_to_binary(View),
                <<"deny">> => <<"0">>
            }
        ]
    },
    PublicThread = #{
        <<"id">> => <<"20">>,
        <<"type">> => 11,
        <<"parent_id">> => <<"10">>,
        <<"permission_overwrites">> => []
    },
    PrivateThread = #{
        <<"id">> => <<"21">>,
        <<"type">> => 12,
        <<"parent_id">> => <<"30">>,
        <<"permission_overwrites">> => []
    },
    OpenParent = #{<<"id">> => <<"30">>, <<"type">> => 0, <<"permission_overwrites">> => []},
    OrphanThread = #{<<"id">> => <<"22">>, <<"type">> => 11, <<"permission_overwrites">> => []},
    Channels = [Parent, PublicThread, PrivateThread, OpenParent, OrphanThread],
    #{data => guild_data_index:put_channels(Channels, #{})}.

thread_inherits_parent_deny_test() ->
    View = constants:view_channel_permission(),
    State = thread_test_state(),
    Hidden = maybe_apply_channel_overwrites(View, 11, [], 20, 5, State),
    ?assertEqual(false, permission_bits:has(Hidden, View)),
    Allowed = maybe_apply_channel_overwrites(View, 11, [9], 20, 5, State),
    ?assertEqual(true, permission_bits:has(Allowed, View)).

thread_matches_parent_permissions_test() ->
    View = constants:view_channel_permission(),
    State = thread_test_state(),
    ?assertEqual(
        maybe_apply_channel_overwrites(View, 11, [9], 10, 5, State),
        maybe_apply_channel_overwrites(View, 11, [9], 20, 5, State)
    ).

private_thread_requires_manage_channels_test() ->
    View = constants:view_channel_permission(),
    Manage = constants:manage_channels_permission(),
    State = thread_test_state(),
    Member = maybe_apply_channel_overwrites(View, 11, [], 21, 5, State),
    ?assertEqual(false, permission_bits:has(Member, View)),
    ManagerBase = permission_bits:add(View, Manage),
    Manager = maybe_apply_channel_overwrites(ManagerBase, 11, [], 21, 5, State),
    ?assertEqual(true, permission_bits:has(Manager, View)).

orphan_thread_is_not_viewable_test() ->
    View = constants:view_channel_permission(),
    State = thread_test_state(),
    Perms = maybe_apply_channel_overwrites(View, 11, [], 22, 5, State),
    ?assertEqual(false, permission_bits:has(Perms, View)).

-endif.
