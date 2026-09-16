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
    %% loses VIEW_CHANNEL for anyone who is neither one of its members nor holds MANAGE_CHANNELS on
    %% the parent. The API applies the same rules (ThreadAccess.ts). Member ids arrive on the
    %% thread's channel map as thread_member_ids and are kept current by THREAD_MEMBERS_UPDATE.
    case thread_parent(ChannelId, State) of
        {thread, ThreadType, ParentId, MemberIds} ->
            ParentPerms = apply_non_thread_overwrites(
                Permissions, UserId, MemberRoles, ParentId, GuildId, State
            ),
            restrict_thread_permissions(ThreadType, ParentPerms, UserId, MemberIds);
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
    {thread, integer(), integer(), [term()]} | orphan_thread | not_thread.
thread_parent(ChannelId, State) ->
    case guild_permissions_check:find_channel_by_id(ChannelId, State) of
        Channel when is_map(Channel) -> require_indexed_parent(classify_thread(Channel), State);
        _ -> not_thread
    end.

%% Echowire: a thread whose parent channel is no longer indexed (deleted) has nothing to resolve
%% its permissions against. Treat it as an orphan, which is not viewable, rather than letting the
%% unknown parent fall back to guild-level permissions.
-spec require_indexed_parent(
    {thread, integer(), integer(), [term()]} | orphan_thread | not_thread, guild_state()
) -> {thread, integer(), integer(), [term()]} | orphan_thread | not_thread.
require_indexed_parent({thread, _Type, ParentId, _MemberIds} = Thread, State) ->
    case guild_permissions_check:find_channel_by_id(ParentId, State) of
        Parent when is_map(Parent) -> Thread;
        _ -> orphan_thread
    end;
require_indexed_parent(Other, _State) ->
    Other.

-spec classify_thread(channel()) ->
    {thread, integer(), integer(), [term()]} | orphan_thread | not_thread.
classify_thread(Channel) ->
    case channel_type(Channel) of
        Type when Type =:= ?CHANNEL_TYPE_PUBLIC_THREAD; Type =:= ?CHANNEL_TYPE_PRIVATE_THREAD ->
            case snowflake_id:parse_maybe(maps:get(<<"parent_id">>, Channel, undefined)) of
                ParentId when is_integer(ParentId) ->
                    {thread, Type, ParentId, thread_member_ids(Channel)};
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

-spec thread_member_ids(channel()) -> [term()].
thread_member_ids(Channel) ->
    case maps:get(<<"thread_member_ids">>, Channel, []) of
        Ids when is_list(Ids) -> Ids;
        _ -> []
    end.

-spec restrict_thread_permissions(integer(), permission(), user_id() | undefined, [term()]) ->
    permission().
restrict_thread_permissions(?CHANNEL_TYPE_PRIVATE_THREAD, Perms, UserId, MemberIds) ->
    IsManager =
        permission_bits:has(Perms, constants:manage_threads_permission()) orelse
            permission_bits:has(Perms, constants:manage_channels_permission()),
    IsMember =
        is_integer(UserId) andalso UserId > 0 andalso snowflake_id:member(UserId, MemberIds),
    case IsManager orelse IsMember of
        true -> Perms;
        false -> permission_bits:remove(Perms, constants:view_channel_permission())
    end;
restrict_thread_permissions(_Type, Perms, _UserId, _MemberIds) ->
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
        <<"thread_member_ids">> => [<<"77">>],
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

%% Echowire: MANAGE_THREADS is the thread-specific moderator bit, and it opens a private thread
%% on its own. MANAGE_CHANNELS keeps working, which is what every existing moderator role holds.
private_thread_admits_a_thread_moderator_test() ->
    View = constants:view_channel_permission(),
    ManageThreads = constants:manage_threads_permission(),
    State = thread_test_state(),
    Base = permission_bits:add(View, ManageThreads),
    Moderator = maybe_apply_channel_overwrites(Base, 11, [], 21, 5, State),
    ?assertEqual(true, permission_bits:has(Moderator, View)).

private_thread_admits_its_members_test() ->
    View = constants:view_channel_permission(),
    State = thread_test_state(),
    Member = maybe_apply_channel_overwrites(View, 77, [], 21, 5, State),
    ?assertEqual(true, permission_bits:has(Member, View)),
    Outsider = maybe_apply_channel_overwrites(View, 78, [], 21, 5, State),
    ?assertEqual(false, permission_bits:has(Outsider, View)).

private_thread_member_still_needs_parent_view_test() ->
    View = constants:view_channel_permission(),
    Hidden = #{
        <<"id">> => <<"40">>,
        <<"type">> => 0,
        <<"permission_overwrites">> => [
            #{
                <<"id">> => <<"5">>,
                <<"type">> => 0,
                <<"allow">> => <<"0">>,
                <<"deny">> => integer_to_binary(View)
            }
        ]
    },
    Private = #{
        <<"id">> => <<"41">>,
        <<"type">> => 12,
        <<"parent_id">> => <<"40">>,
        <<"thread_member_ids">> => [<<"77">>],
        <<"permission_overwrites">> => []
    },
    State = #{data => guild_data_index:put_channels([Hidden, Private], #{})},
    Perms = maybe_apply_channel_overwrites(View, 77, [], 41, 5, State),
    ?assertEqual(false, permission_bits:has(Perms, View)).

orphan_thread_is_not_viewable_test() ->
    View = constants:view_channel_permission(),
    State = thread_test_state(),
    Perms = maybe_apply_channel_overwrites(View, 11, [], 22, 5, State),
    ?assertEqual(false, permission_bits:has(Perms, View)).

thread_with_deleted_parent_is_not_viewable_test() ->
    View = constants:view_channel_permission(),
    %% The parent (50) is not in the index: it was deleted while the thread row survived.
    Stranded = #{
        <<"id">> => <<"51">>,
        <<"type">> => 11,
        <<"parent_id">> => <<"50">>,
        <<"permission_overwrites">> => []
    },
    State = #{data => guild_data_index:put_channels([Stranded], #{})},
    Perms = maybe_apply_channel_overwrites(View, 11, [], 51, 5, State),
    ?assertEqual(false, permission_bits:has(Perms, View)),
    Admin = maybe_apply_channel_overwrites(View, 11, [9], 51, 5, State),
    ?assertEqual(false, permission_bits:has(Admin, View)).

%% Echowire: the gateway half of the thread visibility contract. The api decides the same question
%% in ThreadAccess.ts and is tested against the same file by
%% fluxer_api/src/api/channel/tests/ThreadVisibilityContract.test.ts, so a rule that changes on one
%% side without the other fails on one of the two. The file lives at contracts/
%% thread_visibility_cases.json in the repository root.
contract_cases_path() ->
    Candidates = [
        "../contracts/thread_visibility_cases.json",
        "contracts/thread_visibility_cases.json",
        "../../contracts/thread_visibility_cases.json"
    ],
    case lists:search(fun filelib:is_regular/1, Candidates) of
        {value, Path} -> Path;
        false -> error({thread_visibility_contract_not_found, Candidates})
    end.

contract_permission_bits(Names) ->
    lists:foldl(
        fun
            (<<"VIEW_CHANNEL">>, Acc) ->
                permission_bits:add(Acc, constants:view_channel_permission());
            (<<"MANAGE_CHANNELS">>, Acc) ->
                permission_bits:add(Acc, constants:manage_channels_permission());
            (<<"MANAGE_THREADS">>, Acc) ->
                permission_bits:add(Acc, constants:manage_threads_permission());
            (Other, _Acc) ->
                error({unmapped_contract_permission, Other})
        end,
        0,
        Names
    ).

%% One case as the gateway sees it: the thread in the channel index, its parent present unless the
%% case says it was deleted, and the caller's parent permissions supplied as the base permissions.
contract_case_can_view(Case) ->
    ThreadType = maps:get(<<"thread_type">>, Case),
    ParentMissing = maps:get(<<"parent_missing">>, Case),
    UserId = binary_to_integer(maps:get(<<"user_id">>, Case)),
    MemberIds = maps:get(<<"member_ids">>, Case),
    Base = contract_permission_bits(maps:get(<<"parent_permissions">>, Case)),
    Thread = #{
        <<"id">> => <<"9000">>,
        <<"type">> => ThreadType,
        <<"parent_id">> => <<"9001">>,
        <<"thread_member_ids">> => MemberIds,
        <<"permission_overwrites">> => []
    },
    Parent = #{
        <<"id">> => <<"9001">>,
        <<"type">> => 0,
        <<"permission_overwrites">> => []
    },
    Channels =
        case ParentMissing of
            true -> [Thread];
            false -> [Thread, Parent]
        end,
    State = #{data => guild_data_index:put_channels(Channels, #{})},
    Perms = maybe_apply_channel_overwrites(Base, UserId, [], 9000, 5, State),
    permission_bits:has(Perms, constants:view_channel_permission()).

thread_visibility_contract_test() ->
    {ok, Raw} = file:read_file(contract_cases_path()),
    Contract = json:decode(Raw),
    Cases = maps:get(<<"cases">>, Contract),
    ?assert(length(Cases) > 0),
    lists:foreach(
        fun(Case) ->
            Expected = maps:get(<<"expect_can_view">>, Case),
            Actual = contract_case_can_view(Case),
            ?assertEqual(
                Expected,
                Actual,
                binary_to_list(maps:get(<<"name">>, Case))
            )
        end,
        Cases
    ).

-endif.
