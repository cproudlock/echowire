# 0012. Adopt upstream's threads and forums, then re-add our extras

## Status

Proposed

Date: 2026-10-08

## Context

ADR 0010 recorded that upstream shipped its own threads and forums on 2026-10-07, compared
it with ours feature by feature, and recommended keeping ours for now and planning adoption
as a project. This ADR is that plan. Nothing in it starts until Phase 0 is signed off.

What changed since ADR 0010:

- Upstream is 89 commits ahead of `echowire` and still moving fast, so the cost of staying
  diverged keeps growing.
- Upstream commit #3277 removes the percentage-rollout machinery and ships threads and the
  Plutonium page to everyone. The experiment gate that worried us in ADR 0010 largely
  collapses to "always on". This is read from the commit's file list and diff, not tested;
  verify it when the merge is done.

Facts that drive the plan (all from reading code, none from running it):

- Storage differs. Ours keeps thread state as about 17 `thread_*` and forum columns on the
  channel row plus `thread_members` and `thread_members_by_user`. Upstream uses
  `thread_state`, `thread_stats`, `threads_by_parent`, `active_threads_by_guild`,
  `archived_threads_by_parent`, `thread_parent_config`, `forum_pinned_thread`,
  `thread_only_channels_by_guild`, `guild_thread_state`, `thread_member` and
  `thread_members_by_user`. `ensurePostgresKvSchema` creates tables but moves no data, and
  upstream ships no backfill from channel-row state.
- `thread_members_by_user` exists on both sides with a different key: ours is
  (user_id, thread_id), upstream's is (user_id, guild_id, parent_id, is_private, thread_id).
- Upstream's mobile client shows threads only for guilds whose payload carries a non-null
  `threads` list and sends a `CHANNEL_THREADS` identify flag. Our shipped mobile clients send
  neither, so against an upstream-shaped server they would lose threads until updated.
- Enabling upstream's feature runs a seeding job that clears thread bits from channel
  overwrites and re-derives them from SEND_MESSAGES, and gives @everyone CREATE_PRIVATE_THREADS.
- Private-thread moderation upstream is MANAGE_THREADS or ADMINISTRATOR. Ours also accepts
  MANAGE_CHANNELS.

## What production holds (measured 2026-10-09, read-only)

Counted from the production database in read-only transactions, with no rows changed:

- 6 guilds, 24 guild members, 176 channel rows in total.
- Threads: 20 public threads in 3 guilds, 0 private threads. Only 1 of the 20 is active; 19 are
  archived. 1 is locked and none are pinned. 18 are forum posts and 2 sit under text channels.
- Forum channels: 4 (one has 2 tags, none requires a tag).
- Thread members: 34 rows. 12 of the 32 thread groups belong to threads that no longer exist
  (orphans left behind); 31 groups have 1 member and 1 has 3.
- Permissions: 17 roles, 1 of them administrator. No role has Manage Channels without
  administrator, and no role has any thread permission bit. Every guild's @everyone role can
  send messages and has no thread bit, so all 6 guilds run on our legacy fallback today. 8
  channels have permission overwrites (18 entries in 5 guilds); none carries an explicit
  thread bit, and 9 entries touch Send Messages.

What follows from it:

- The data migration is tiny: 20 thread rows, 4 forum rows and about 22 live member rows, with
  12 orphaned member groups to skip. It can be verified by reading every row.
- The private-thread moderator rule (Manage Threads, not Manage Channels) affects nobody today,
  so no one-time grant of Manage Threads is needed at the cutover.
- Upstream's seeding job would erase no explicit thread setting, since there are none. It would
  add Create Public Threads, Create Private Threads and Send Messages in Threads to @everyone in
  all 6 guilds, and add the same bits to the 9 overwrite entries that touch Send Messages,
  which matches what our fallback already allows. The one new capability is @everyone getting
  Create Private Threads, which our fallback never granted; 0 private threads exist today.

## Decision

We will make upstream's implementation the base for threads and forums, retire ours, and
re-implement on top of it only the extras that match Discord's behaviour, kept as separate as
we can so that merging upstream stays cheap. We will do it as a
phased, reversible project, in this order, and we will not skip a phase gate.

### The rule: upstream by default, Discord for additions

The goal is to stay as close to upstream's implementation as possible and to add our own
behaviour only where it matches Discord's. That gives every later choice a test:

1. Upstream's behaviour wins by default, including where ours was different (permissions,
   notification defaults, error codes, route shapes). We change it only if Discord does
   something else AND the maintainer decides we want that.
2. Our current threads and forums were built to match Discord (maintainer, 2026-10-08, from the
   forum FAQ and screenshots of 2026-09-13), so every feature we have that upstream lacks is
   kept as an addition. Nothing of ours is dropped for lacking a separate reference. A NEW
   addition, one we do not have today, does need a Discord reference.
3. An addition must be cheap to merge around. It lives in its own files and components, wired
   in at the fewest points upstream's files allow (a prop, a hook, a registered row), marked
   `// Echowire:`, with its own tests. Editing the body of an upstream function is a last
   resort and needs a reason in the review.
4. Every addition is listed in `docs/upstream-divergence.md`: what it is, the Discord
   behaviour it matches, the files it touches, the upstream files it hooks into, and its
   tests. Each upstream sync reads that file first, so a merge cannot silently drop one.

### Phase 0. Decisions and measurement (no code)

Exit criteria, all required:

1. Count what exists in production. DONE 2026-10-09, see the section above.
2. Where upstream and ours BEHAVE differently (as opposed to ours having something upstream
   lacks), the maintainer picks one per item. The default is upstream, because that is what
   keeps the merge small, and ours wins only where the maintainer says ours is the Discord
   behaviour. The items: private-thread moderators (upstream: MANAGE_THREADS or administrator;
   ours also MANAGE_CHANNELS), thread members' default notification level (upstream follows the
   parent or guild level with per-member flags; ours: every message), creating a forum post
   (upstream: SEND_MESSAGES; ours: CREATE_PUBLIC_THREADS), a forum post requiring a starter
   message in the request (upstream yes; ours no), who may delete the thread-created system
   message (upstream: like any message; ours: moderators only), and the OP badge scope
   (upstream: forum posts; ours: any thread). Separately the permission seeding job needs a
   decision either way, because it rewrites overwrites: run it, or pre-set
   `guild_thread_state.perms_seeded_at` and seed ourselves.
   Decided 2026-10-08 (maintainer): upstream's behaviour for all six.
   - Private-thread moderators are the guild owner, administrators and holders of MANAGE_THREADS;
     MANAGE_CHANNELS alone no longer moderates private threads. Whether the cutover also grants
     MANAGE_THREADS once to every role that holds MANAGE_CHANNELS, so existing moderators keep
     their access, is decided at the cutover.
   - Thread members' default notification level follows the parent or guild level, with
     per-member flags.
   - Creating a forum post needs SEND_MESSAGES on the forum, plus a title and a starter message
     in the request.
   - The thread-created system message is deletable like any other message.
   - The OP badge shows in forum posts only (ordinary threads lose it).
   The permission seeding job: run upstream's as it is. Measured, it erases nothing we have set.
   The one decision left is whether @everyone gets Create Private Threads, upstream's default.
3. The extras to carry are everything we have that upstream lacks: the "N New" forum pill,
   "Add to Post", participant avatars on post cards, the "Closed posts" toggle, the forum
   examples modal, the mobile post header actions, and the mobile add-member UI. Upstream
   already has React to Post, Follow, moderated tags, THREAD_LIST_SYNC, the add-member
   endpoint and the thread permission bits, so those are no longer ours to carry; their
   behaviour is compared in item 2 where it differs.
4. A way to read a copy of the production database is agreed, kept on the dev container only
   and deleted after the project.

### Phase 1. A scratch environment

A compose stack on the dev container running the current production images against a restored
copy of the production database. Everything below is rehearsed here first. Exit: the stack
boots on the copy, our current thread tests pass against it, and a script prints the Phase 0
counts so they can be compared after migration.

### Phase 2. The server merge

On a branch, merge upstream/main (the full thread stack and everything between, no
cherry-picking: the whole point is to stop diverging). About 112 conflicted paths were
predicted for the first 8 thread commits and there will be more now. Resolve in this order,
running the gates at each step:

1. Constants, schemas and database types (`ChannelConstants`, `ChannelSchemas`, `ThreadTypes`,
   `Tables.ts`).
2. Repositories and the thread services. Retire `ThreadAccess.ts`, the thread methods in
   `ChannelOperationsService`, our auto-archive worker and our thread member repository
   once upstream's equivalents are wired in.
3. Gateway (the Erlang thread modules) and push (`push_eligibility*.erl`). Keep the unread
   cap (ADR 0009) running last in `filter_eligible_users`; re-run its tests and check it still
   keys correctly now that every thread is its own channel id.
4. Admin, then the web client.

Keep our brand (lowercase `echowire`), our feedback-link decisions, and our desktop ids.
Regenerate OpenAPI and the translation catalogs, never hand-merge them. Exit: the full api,
gateway eunit, app and desktop gates pass, and the September leak-regression tests (thread
access review, visibility contract, delivery path) pass against upstream's code, either
unchanged or ported with the same assertions.

### Phase 3. The data migration

An idempotent job, run first against the Phase 1 copy. Mapping, our column to upstream's:

| Ours (channel row) | Upstream |
|---|---|
| thread_archived, thread_locked, thread_invitable | thread_state.archived, locked, invitable |
| thread_auto_archive_duration, thread_archive_timestamp | thread_state.auto_archive_duration, archive_timestamp |
| thread_create_timestamp | thread_state.created_at |
| thread_member_count, thread_recent_participant_ids | thread_state.member_count, member_ids_preview (their field is a member preview; decide how participants map) |
| thread_message_count | thread_stats.message_count (total_message_sent starts equal) |
| thread_pinned | thread_state.flags bit 1<<1, and forum_pinned_thread for forum posts |
| applied_tags | thread_state.applied_tags |
| available_tags, default_reaction_emoji | thread_parent_config.available_tags (tag shape: id, name, moderated, emoji), default_reaction_emoji_id and name |
| forum_require_tag | thread_parent_config.flags bit 1<<4 |
| default_sort_order, default_forum_layout, default_thread_rate_limit_per_user, forum_default_auto_archive_duration | the same names on thread_parent_config (layout values must be mapped: ours GALLERY, theirs GRID) |
| (derived) | threads_by_parent, active_threads_by_guild, archived_threads_by_parent, thread_only_channels_by_guild, thread_state.has_starter and state_version, guild_thread_state |
| thread_members | thread_member, adding guild_id and parent_id (from the thread row) and muted=false |
| thread_members_by_user | rewritten to upstream's key; this one table name collides, so it is migrated in place or renamed with a cut-over |

The enum values for layout and the exact flag bits above come from reading the code; they are
confirmed against upstream's constants before the job is written, not assumed.

Requirements: re-runnable without duplicates; a dry-run mode that only counts and diffs; a
verification pass comparing the Phase 0 counts and spot-checking every guild with threads;
a delta mode that picks up threads created or changed since the last run; the old columns and
tables are left untouched so rollback stays possible. Exit: on the copy, counts match, a
sample of threads and forums read correctly through upstream's API, and a second run changes
nothing.

### Phase 4. The web client

Take upstream's thread and forum UI, delete ours (about 43 files), then re-add the chosen
extras as separate components wired in at the fewest points, each entered in
`docs/upstream-divergence.md`, with translation keys and the lowercase-brand test. The desktop app loads the
web client from the server, so it follows the deploy. Exit: app gates pass and a manual pass
through the QA matrix below on the scratch stack.

### Phase 5. Mobile (ships before the server flips)

Take upstream's thread work and the matching SDK, move our cached thread columns onto
upstream's names (their schema step is additive), point the SDK guard test at `flags`, and
re-add the chosen extras under the same rule (separate files, few hook points, listed in the
divergence ledger). The client must work against BOTH server shapes during the rollout:
it sends the `CHANNEL_THREADS` flag, and treats threads as enabled when the guild carries the
`threads` list or the old shape. Fix or consciously accept upstream's drift-stream providers
under the widget-test invariant. Release it and wait for adoption before the cutover. Exit:
mobile gates pass, the build is installed from the stores on test devices, and it shows
threads against the OLD server and the scratch (new) server.

### Phase 6. Cutover

1. Announce a short window. Take a database backup and record the Phase 0 counts.
2. Run the migration against production while the old code is still live. It only adds data.
3. Deploy the new server images. Enable threads for everyone (or confirm #3277's always-on).
4. Run the delta migration for anything created in between, then the verification pass.
5. Smoke test: create a thread and a forum post, a private thread as a non-member and as a
   member, archive, lock, push for a member and a non-member, the unread cap, the admin
   tools.
6. Watch error rates and the push cache stats for the first hours.

Rollback is the previous image tag. Anything created after the switch lives only in
upstream's tables and is lost on rollback; the window keeps that small and is stated up front.

### Phase 7. Cleanup

Supersede ADRs 0003 to 0007, delete the retired code, later drop the legacy columns once
rollback is no longer wanted, update the docs, and delete the production copy.

## Consequences

Easy afterwards: upstream syncs stop colliding in the same 35 files, we inherit their search,
announcement and media channels, per-member notification settings, THREAD_LIST_SYNC, bounded
auto-archive and their larger test suite.

Hard or unhappy:

- It is a large piece of work with one irreversible-ish step (users creating data in the new
  tables). Phase gates exist to catch problems on a copy first.
- Old mobile clients lose threads until they update, unless the cutover waits for adoption.
  We wait.
- Moderators who rely on MANAGE_CHANNELS alone lose private-thread access unless Phase 0
  chooses a carve-out; guilds' overwrites change when seeding runs.
- Thread members stop receiving every message by default, which is a notification change
  users will feel.
- We keep chasing upstream either way; this just moves the work to merge time. The rule above
  and the divergence ledger are what keep that work small.
- Where upstream behaves differently from ours (the Phase 0 item 2 list), choosing upstream
  changes something users have today, and choosing ours keeps a divergence to maintain. Each
  such choice is made on purpose, one at a time, and recorded in the divergence ledger.

## Risks and checks

| Risk | Check |
|---|---|
| Migration leaves threads invisible or memberless | Phase 3 verification, run on a copy, counts and per-guild spot checks |
| Seeding job strips thread bits an admin set | Run on the copy and diff overwrites before and after |
| Old mobile clients lose threads | Cutover waits for the dual-shape mobile build to be adopted |
| Two thread push paths coexist (`thread_parent_id` and `__thread_push`) | After the merge only upstream's is fed; delete ours and test both a member and a non-member |
| Silent SDK regeneration drops fields again | Guard test on `flags`, and tests, not `flutter analyze`, as the gate |
| Auto-archive hammers production | Upstream's bounded queue; watch the first runs |
| Upstream moves during the project | Merge, do not freeze; re-run the gates; keep the branch short-lived |

## QA matrix (Phase 4 and 6)

Public thread, private thread (member, non-member, MANAGE_THREADS only), forum with and
without required tags, moderated tag, gallery and list layout, slowmode, archive, unarchive on
send, lock, pin, members panel add and remove, push for member and non-member, a muted forum,
the unread cap, search, the admin thread tools, desktop, web, Android and iOS.

## Effort

A guess, not a measurement. With 20 threads in 6 guilds the migration and its rehearsal are
small, so the weight is the server merge and the mobile release. Roughly three to four calendar
weeks for one person working with an assistant, if the mobile adoption wait is kept short. With
6 guilds and 24 members the audience is small enough that the maintainer may choose to cut over
without waiting for old mobile clients, and tell members to update; that is a decision for the
cutover, not assumed here.

## Abort criteria

Stop and reassess if: the production counts show a migration far larger than the copy can
rehearse, the seeding job cannot be made safe, or upstream changes thread storage again before
we ship. The fallback is ADR 0010's holding position.

## Alternatives considered

- Keep ours and port individual upstream features (announcement threads, THREAD_LIST_SYNC,
  per-member settings, search): cheaper now, but every sync keeps colliding.
- Adopt upstream's server only and leave clients: not possible, since their clients and routes
  are tied to their server shape.
- Freeze on upstream's current thread code and stop merging: avoids the chase but forks us
  from their fixes, the opposite of the goal.

## Progress log

### 2026-10-09: decisions

- Seeding: run upstream's `SeedThreadPermissions` as is. `@everyone` gains Create Private Threads
  (upstream's default), as in every other community on upstream. The measured production data shows
  nothing is erased: no role or overwrite carries an explicit thread bit.
- Phase 1 exit revised. The scratch environment is a throwaway Postgres holding only the
  channel, guild, role and thread-member rows (267 rows), not a full copy of production, because a
  full copy carries credentials and message content the migration never reads. The stack cannot log
  in on that copy, so the exit is: the copy loads, the Phase 0 counts reproduce (they do), and the
  Phase 3 job runs against it.
- Premium tier name: upstream made it instance branding. The client fallback is `Reverb`; the server
  default stays upstream's (`Premium` self-hosted, `Plutonium` hosted), so the live instance must set
  `premium_product_name` to `Reverb` in its branding at cutover.

### 2026-10-09: Phase 2 outcome (branch feat/adopt-upstream-threads)

Upstream/main was merged whole (102 commits, merge commit a2d855d20), not cherry-picked. 222 paths
conflicted; 66 were catalogs, regenerated or resolved with `tools/upstream/resolve_po.py`
(`PREFER_THEIRS=1` was added for this adoption: both sides had translated the same new thread strings).
Method that worked: classify every file the fork changed by hunk (all thread-related, so take
upstream's whole file; mixed, so review), delete the fork-built thread modules, then let the type
checker find what still dangled. Clean textual merges were wrong in several places and were caught
by gates, not by git: fork thread glue left inside upstream-shaped files (api services, gateway
modules, docs pages, admin templates), the app proxy losing its discovery cache wiring, a voice
codec helper left unused, upstream's `Plutonium` defaults, and a keep-both resolution that dropped a
closing brace in `InstanceConfigRepository.ts`.

Gates at the end of Phase 4 on the server side: api tsc 0 errors and vitest 6780 passing plus one expected fail; app tsc 0 and vitest 1500; gateway
eunit 3391 tests 0 failures (including the unread cap); cargo fmt, clippy `-D warnings`, deny and
tests clean; biome ci, eslint, knip, docs verify and build, strict lingui compile, desktop main tests
1419 pass 4 skipped.

Decisions taken during the merge: the upstream-only `verify_windows_arm64` job was dropped from
`build-desktop.yaml` because it downloads Actions artifacts and this fork uploads through the S3
handoff, so it verified nothing while adding a runner dependency.

### 2026-10-09: Phases 3 and 4 outcome, and what is left

- Phase 3: `fluxer_api/scripts/MigrateForkThreads.ts` (modes dry-run, apply, delta, verify, cleanup-legacy, with
  `--pre-cutover`). On the scratch copy it wrote 132 rows, `--verify` passed 328 checks, and a second apply wrote
  nothing. It leaves the old columns and tables alone and refuses non-loopback hosts without `--allow-remote`.
- Phase 4: the N New pill, participant avatars and forum examples are re-added as separate components; Add to Post
  is carried as a server route (`StarterAttachmentService`); the Closed posts toggle is not carried, upstream lists
  closed posts under Older posts. The ledger is `docs/upstream-divergence.md`.
- Leak regression: 39 tests port the September assertions onto upstream's code, each shown to fail under a planted
  violation. One finding to take to upstream: acking a private thread you cannot see writes a read-state row (no
  content, only confirms the id is a thread); it is pinned by an expected-fail test. A seventh behaviour
  difference: upstream adds a mentioned member to an invitable private thread.
- Left: mobile (Phase 5), then cutover (Phase 6): backup, `--apply --pre-cutover` while the old image is live, deploy,
  `--delta`, run seeding, set `premium_product_name` to `Reverb`, verify, then `--cleanup-legacy` later.
