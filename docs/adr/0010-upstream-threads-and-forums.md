# 0010. What to do about upstream's threads and forums

## Status

Proposed

Date: 2026-10-07

## Context

On 2026-10-07 upstream landed its own threads and forums, server and mobile. We
already run our own, shipped in September and documented in ADRs 0003 to 0007
and `docs/forums-contract.md`. Neither side is behind the other on features; the
two designs describe the same product with different internals.

Server commits not in `echowire` (all upstream/main): #3250 (gateway, messages
and push thread support), #3251 (thread and forum API, admin, schemas, docs),
#3252 (thread and forum UI on web), #3256 (administrators can grant thread
permissions), #3257 (one admin threads toggle). Mobile: #961 (threads, forums and
announcement threads) plus a `dart_sdk` bump to a regenerated SDK. Also landed
the same day and entangled with them by history: #3253 and #962 (create channel
redesign), #3254 (desktop bundled renderer), and small fixes #3255, #3258, #3259,
#3260 and three mobile fixes.

A read-only comparison (2026-10-07, no merge attempted) found:

- A trial merge of upstream/main conflicts in about 112 server paths (36 catalogs,
  34 web files, 24 API files, 11 schema files, 3 gateway files, Rust push and
  admin, about 16 desktop and CI files). Mobile conflicts in 44 paths, and several
  more files merge cleanly while both sides rewrote the same region.
- Identical: channel type numbers (public thread 11, private thread 12, forum 15)
  and the thread permission bits (positions 34, 35, 36 and 38). Upstream also has
  announcement thread (10), media channel (16) and thread starter message (21),
  which we lack.
- Different storage. We keep thread state as about 17 columns on the channel row
  plus a members table (ADR 0005). Upstream uses eight or more dedicated tables.
  `ensurePostgresKvSchema` creates schemas but does not move data, so adopting
  their shape leaves existing threads invisible, unlisted and memberless unless a
  backfill is written. None was found upstream.
- Upstream gates all of it behind an experiment (`ChannelThreadsGate`, a kill
  switch, per-guild and per-user rollout, an admin panel). We have no gate. Their
  client shows threads only when the guild payload carries a non-null `threads`
  list; whether our server sends one was not verified.
- Mobile: their `dart_sdk` renames and drops fields we rely on (`pinned`,
  `requireTag`), changes `appliedTags`, and deletes our guard test for forum
  fields. Our drift schema is version 90 and theirs 91 with different column
  names for the same data. Their new providers watch drift streams, which the
  widget-test invariant forbids.
- Push: upstream's thread push eligibility reads a `__thread_push` map; ours reads
  `thread_parent_id` and `thread_member_ids` and applies
  `thread_effective_default`. Both merge textually, but only the path the API
  feeds works. The unread cap (ADR 0009) is unaffected.
- History order matters. Upstream commits form a line, and a real merge can only
  take a prefix of it. On the server only #3248 sits before the thread commits; on
  mobile three fixes do. The later small fixes cannot be merged without the thread
  commits unless they are cherry-picked, which our branch model forbids for
  upstream syncs.

Clients in the field (mobile 1.7.33 and 1.7.34) talk to our server's shape.

## Feature parity (2026-10-07)

A second read-only pass compared our feature set with upstream's, feature by
feature, on the server, the web app and mobile. Nothing was built or run, so
these are readings of code, not behaviour tests.

Upstream does the same job and covers most of our feature set, with more on top:
announcement threads (type 10), media channels (type 16), thread search, forum tag
routes, per-member notification settings, THREAD_LIST_SYNC and the other extra
gateway events, a bounded and ordered auto-archive, a shared conformance fixture
for thread permissions, and about twice our API test files (49 against 25).

It lacks several user-visible pieces of ours: the "N New" forum pill, participant
avatars on post cards, "Add to Post", the post header actions on mobile (react,
follow, add media), the add-member UI on mobile, and an OP badge in ordinary
threads (theirs shows it in forum posts only).

Behaviour differs in ways users would notice:

- Push: our thread members get every message; theirs follow the parent or guild
  level, with per-member flags.
- Private-thread moderation needs MANAGE_THREADS or administrator upstream; we also
  accept MANAGE_CHANNELS.
- Enabling upstream's feature rewrites channel overwrites, seeds the thread bits and
  gives @everyone CREATE_PRIVATE_THREADS by default. A forum post needs only
  SEND_MESSAGES.
- A forum post requires a title and a starter message upstream and is rolled back
  if the message fails.
- It is off by default behind an experiment gate. Without the gate, threads and
  forums disappear from their clients entirely, including existing ones. Their
  clients also send a `channel_threads` header and a `CHANNEL_THREADS` identify flag
  and show threads only for guilds whose payload carries a `threads` list.

Their mobile client would not work against our server today (no `guild.threads`,
different routes and wire shapes), and their web client would not either. The
database upgrade on mobile is additive and safe; the server data is not readable.

Gaps found in ours:

1. The guild-wide active thread list checks only MANAGE_CHANNELS, so a moderator
   holding only MANAGE_THREADS does not see private threads in it.
2. The web composer may not disable when a thread is locked or archived by someone
   else (found by absence in a search, to be confirmed).
3. Our auto-archive walks every guild with no cap and no ordering, and does not skip
   pinned threads.
4. Forum post creation takes no starter message in the request.
5. Our mobile sidebar watches a drift stream (`forumNewPostCount`), which breaks the
   widget-test invariant.

## Decision

Not yet accepted. This ADR stays Proposed until the maintainer flips it. The
recommendation, as amended after the parity pass:

We will keep our own threads and forums for now (storage, API, access logic, web and
mobile UI, push eligibility), fix the gaps listed above, and plan adopting
upstream's implementation as a separate project. Until that project starts, treat
upstream's code as a source of ideas, not something to merge.

- Take every upstream change that does not depend on theirs, by merging the safe
  prefix on each repo (server through #3248, mobile through ef65b54ee).
- For small independent fixes stuck behind the thread commits (#3255, #3258 to
  #3260, the mobile voice and test fixes), cherry-pick each one after confirming it
  touches no file the thread commits changed, and record each in the commit
  message. This is a deliberate, narrow exception to "merge, never cherry-pick",
  applied only while we are holding the thread commits back.
- Do not run `git merge -s ours` over the thread commits. It would mark them as
  merged and hide them from later syncs, which would make adopting them later
  harder.
- Port ideas on our own schedule: announcement thread type (10), media channel (16),
  thread starter message type (21), the extra gateway events (THREAD_LIST_SYNC,
  THREAD_MEMBER_UPDATE), thread search, forum tag routes, per-member notification
  settings, and their shared `ThreadPermissionCases.json` as a conformance test for
  our access rules.
- Fix gaps 1 to 3 first (they affect users); then 4 and 5.
- Plan adoption of upstream's implementation as a project, because it is the better
  engineered system and the divergence cost recurs on every sync. The project needs,
  in order: a decision on the gate (adopt it, or remove it and enable for all);
  a backfill from channel-row thread state into upstream's tables, with a dry run on
  a copy of production data; the `thread_members_by_user` key difference resolved;
  a mobile release that speaks upstream's shape and sends the `CHANNEL_THREADS`
  flag, shipped before the server flips, since installed clients speak ours; the
  mobile SDK moved with our guard test re-pointed at `flags`; our visible extras
  (N New pill, participant avatars, Add to Post, OP badge scope) re-added on top if
  we still want them; and a plan for private-thread moderators who rely on
  MANAGE_CHANNELS and for overwrites that enabling would rewrite.
- Revisit this ADR when that project is scheduled, or when upstream's storage or
  gate changes.

## Consequences

Easy: no production data migration, no change for installed mobile clients, no
new gate to configure, and the unread cap and our push path stay as shipped.

Hard: every upstream sync will keep colliding in the same files (about 35 on the
server, the sidebar and channel model on mobile), later upstream fixes may assume
their thread code, and each skipped commit needs a judgement call. Upstream's
create-channel redesign (#3253, #962) lands on thread code and will need adapting
by hand. We carry a growing private fork of a feature upstream now maintains. The parity pass shows upstream's version is
the stronger base, so this is a holding position with a known exit, not a settled
end state.

## Alternatives considered

- Adopt upstream's threads wholesale. Lowest long-term merge debt, but needs a
  backfill from channel rows into eight tables, adopting or removing the gate,
  retiring about 43 web files and our mobile thread files, a mobile SDK and drift
  migration, and a mobile release before the server flips, because installed
  clients speak our shape. Highest risk, and the likely end state; scheduled as a project, not done by accident.
- Reject all of upstream until threads settle. Simplest, but it also drops
  independent fixes and the desktop work and widens the next conflict.
- Merge everything and fix forward. Rejected: git merges these cleanly in the
  places that matter and passes `flutter analyze` while turning forums into plain
  text channels (see the 2026-09-22 SDK regeneration), so tests would be the only
  guard.
- `git merge -s ours` the thread commits. Rejected above: it hides them from
  future syncs.
