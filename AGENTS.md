# echowire-next: agent guidance

The one committed AI-config file for this repo (contract rule C5.1). `CLAUDE.md`
is a symlink to it. Accurate as of 2026-09-14.

Upstream fluxerapp once shipped its own `AGENTS.md` with anti-agent boilerplate
for its contribution flow (removed upstream in #1571). If an upstream merge ever
brings one back, it is not authoritative here: this file is.

## What this repo is

The live echowire server, web client and desktop app. It is a monorepo fork of
`fluxerapp/fluxer` and is what runs echowire.org. There is no other live
codebase to confuse it with: the old TypeScript monolith is no longer live.

- **Branch model:** `echowire` is the default branch. Upstream is brought in on
  a `merge-upstream-<date>` branch, then merged into `echowire` with `--no-ff`.
  Feature and fix work goes on `feat/*` and `fix/*` branches, merged the same way.
  Split a huge mechanical upstream commit (such as the 2026-09-13 path-alias
  rewrite, #2741) into its own merge step.
- **Remotes:** `origin` = github.com/cproudlock/echowire (private),
  `upstream` = github.com/fluxerapp/fluxer (public HTTPS fetch, no credential),
  `gitea` = the Gitea mirror `cproudlock/echowire-next`.
- **PR titles** must match
  `^(revert: )?(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+\))?!?: .{1,72}$`
  (`.github/workflows/validate.yaml`). A merge PR is
  `chore(merge): bring upstream/main into echowire (N commits)`.

## Brand rule

The brand is all lowercase, `echowire`, in every user-visible string, default,
title, email, catalog value and artifact name (desktop files are `echowire-*`),
even at the start of a sentence. A capitalized `Echowire` in display text is a
leak to fix. `Reverb` (premium, upstream's Plutonium) and `EchoTag` (upstream's
FluxerTag) keep their casing. Code identifiers, env var names, `org.echowire.*`
ids and the `// Echowire:` divergence markers are not display text and stay as
they are. Download and updater matching must stay tolerant of old `Echowire-*`
artifact names so existing installs still update. See ADR 0002.

## Architecture

Service bus NATS, datastore Postgres through a KV layer (self-migrates on boot
via `ensurePostgresKvSchema`, so `Tables.ts` changes need no manual DDL), cache
Valkey, search Meilisearch, voice LiveKit.

| Component | Lang | Dir |
|---|---|---|
| HTTP API and worker | TypeScript (Hono) | `fluxer_api` |
| Web client (SPA) | React, rspack | `fluxer_app` |
| Gateway (WebSocket) | Erlang/OTP 28 | `fluxer_gateway` |
| Desktop | Electron, plus Rust native capture modules | `fluxer_desktop` |
| Shared service runtime | Rust library | `fluxer_svc`, `fluxer_common` |
| Users, messages, unfurl, gifs, snowflakes | Rust, coordinator plus `-shard` | `fluxer_users`, `fluxer_messages`, `fluxer_unfurl`, `fluxer_gifs`, `fluxer_snowflakes` |
| Media proxy (R2 reads, image transforms) | Rust | `fluxer_media_proxy` |
| Admin panel | Rust, tailwind via `build.rs` | `fluxer_admin` |
| Marketing site (`/help`, `/blog`, `/terms`, `/reverb`) | Rust, vendored in-tree | `fluxer_marketing` |
| App proxy (serves the SPA) | Rust | `fluxer_app_proxy` |
| Static assets | Caddy | `fluxer_static` |
| Shared TS packages (schema, config, limits, errors, i18n, openapi) | TypeScript | `packages/*` |
| Dev and CI tooling (`fluxer-dev`, `fluxer-ci`) | Rust | `tools/` |
| Self-host deploy (the only deploy path used) | compose, Caddy | `deploy/self-hosting/` |

`fluxer_marketing` is 195 vendored, rebranded files. Upstream turned it into a
submodule; this fork did not, and `pnpm-workspace.yaml` lists it so its
tailwindcss installs.

## Toolchain in dev-personal

Work happens in the `dev-personal` Incus container at `~/dev/echowire-next`.
Neither node nor cargo is on the non-login PATH, so export both first:

    export PATH=/home/camp/.local/node/bin:$HOME/.cargo/bin:$PATH

`pnpm typecheck`, `pnpm knip` and `pnpm test` wrap `cargo run -p fluxer-dev`, so
they need cargo as well as node. In a fresh worktree or after a merge, generated
gitignored files (`SVGMasks.tsx`, `AvatarStatusGeometry.ts`,
`*.module.css.d.ts`) are missing or stale, which shows up as "property does not
exist" errors. That is not a code error:

    cd fluxer_app && pnpm generate:masks && pnpm generate:css-types

The container has an 18 GiB memory cap. Do not run a full api vitest run, the
13-image docker build and a Flutter release build at the same time.

## The local gate

GitHub Actions is not used (the account will not be paid for; see ADR 0001), so
nothing gates a merge except this. Run it before committing to `echowire`:

    pnpm typecheck
    pnpm exec biome ci .
    pnpm exec eslint . --max-warnings 0
    pnpm knip
    pnpm test                                 # workspace sweep, excludes fluxer_api
    cd fluxer_api && pnpm exec vitest run     # its own vitest project; ~4,500 tests

Plus, depending on what changed:

- **After any upstream merge:** `cargo check -p fluxer_admin` (typecheck does not
  cover Rust crates; a merge once deleted a flag the fork's admin badge uses).
  For Rust changes, copy commands verbatim from `.github/workflows/tests.yaml`,
  which is stricter than bare forms: `cargo deny --locked check -D warnings`,
  `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`.
- **After any compose edit:** every `${NAME}` in the compose needs a line (a
  commented `#NAME=` counts) in `deploy/self-hosting/.env.example`:
  `cd packages/config && pnpm exec vitest run src/__tests__/DeployEnvCoverage.test.ts`.
  `NonDefaultPortCompose.test.ts` uses a hardcoded secrets fixture, so a new
  required variable goes there too.
- **After API route or schema changes, and after merges:** `pnpm openapi:generate`
  and commit the result. Response schemas must be exported named schemas; an
  inline `z.array(...)` fails generation.
- **Gateway:** rebar3 is not in the container. Compile inside the `erlang:28-slim`
  docker image and run the touched modules' eunit there; the `fluxer-gateway` image
  build does the full compile. Three details decide whether that works, and each
  fails quietly:

  1. Modules use `-include_lib("fluxer_gateway/include/...")`, which resolves by
     searching `ERL_LIBS` for an application directory of that name. Mount the
     checkout at `/libs/fluxer_gateway` and set `ERL_LIBS=/libs:/libs/fluxer_gateway/_build/test/lib`.
     Mounting at `/gw` fails every include.
  2. Compile with `+debug_info`. `meck(passthrough)` recovers a module's abstract
     code, so without it every passthrough mock dies `{abstract_code_not_found, M}`.
     rebar3 sets it by default; `erlc` does not.
  3. Do **not** have `ERL_LIBS` set when running the tests, or the stale
     `fluxer_gateway/ebin` left in `_build` by an earlier rebar run shadows the
     freshly compiled modules and `-pa` does not win. Compile with it, run without
     it and pass the dep ebins explicitly.

  Two traps when reading the output. `erlc` reports a bad include as `can't find
  include lib`, with no occurrence of the word "error", so grepping for `/error/`
  hides a completely failed compile: assert the emitted `.beam` count equals the
  `.erl` count instead. And this container cannot build the
  `guild_member_list_oset_nif` Rust NIF, so a fixed set of tests always fails
  `undef`; raw eunit exit status is therefore useless as pass/fail. Gate on the
  criterion instead: the tree compiled fully, no assertion failure, and no undefined
  function other than that NIF.

Bare text nodes beside elements in JSX fail both biome and eslint
(`no-conditional-text-nodes-with-siblings`) because Chrome page translation
breaks them. Wrap each text run in its own element.

## Build and deploy

Images are built locally and shipped over SSH. No registry push is involved
(the `gh` token can pull from ghcr but not push).

1. Build: `TAG=<date> ./deploy/self-hosting/build-images-local.sh [image ...]`
   builds the 13 `ghcr.io/cproudlock/fluxer-*:<tag>` images with buildx
   (`--load`). Name images to rebuild only what changed and retag the rest.
   Check `docker inspect` `.Created` before shipping: a killed build can leave a
   stale image carrying the tag.
2. Ship: `docker save <image> | gzip -1 | ssh root@10.9.50.31 "gunzip | docker load"`.
3. Stage the repo's `deploy/self-hosting/` files and `.env` beside the live ones
   in `/root/selfhost`, diff them, and back up the live set.
4. Preflight: `docker compose --env-file .env.new -f docker-compose.yml.new run --rm --no-deps -e FLUXER_POSTGRES_HOST=preflight-nodb api`.
   It passes when the log ends in a `getaddrinfo` failure (config validated,
   DB not touched). `docker compose config` alone proves nothing.
5. Flip `FLUXER_IMAGE_TAG`, `docker compose up -d` (no `--remove-orphans`).
6. Smoke: containers healthy, `/`, `/_health`, `/help`, `/reverb` return 200,
   media loads cold-cache, and `cf-connecting-ip` is present in the api env.

Reusable scripts live in the container home (`~/deploy-0914.sh`,
`~/smoke-0914.sh`). Rules:

- **Disk:** the box has a 40 GB root volume and an image set is about 11 GB.
  `df -h /` first, and keep at most two tags (live and one rollback). Remove old
  sets with an anchored pattern (`^ghcr.io/cproudlock/fluxer-.*:<tag>$`); a bare
  tag also matches third-party images.
- **Client IP:** `FLUXER_CLIENT_IP_HEADER_NAME=cf-connecting-ip` must stay in
  the prod `.env`. The compose default is `x-forwarded-for`, which makes every
  client look like a Cloudflare address.
- **Rollback:** restore `/root/backup-<ts>` and set the previous tag.
- Do not put credentials, keys or new hostnames in this repo or this file.

## Upstream merges: rules and traps

- **`.po` conflicts: script the check, fail closed, never take upstream's on
  faith.** This rule used to read "almost always header stamps, confirm then take
  upstream's". That is known wrong: on 2026-10-03 all 34 catalogs conflicted on
  `msgid`/`msgstr` lines and every hunk was the Pickles rename, so taking
  upstream's would have reverted the cursor cat across 34 languages in one commit.
  Nothing would have caught it, because no test asserts translated values. Expect
  the same from the Plutonium series, and from any slice touching the Pickles
  settings strings.

  Note how the previous version of this rule came to be wrong: it was written in
  good faith from real merges where the conflicts genuinely were header stamps, and
  it generalised from them. The correction below rests on one run, 2026-10-03, where
  it failed on all 34 catalogs at once. Treat the step order as the durable part and
  the word "almost always" as the part that misled.

  The procedure:

  1. Script the precondition over every conflicted catalog: for each conflict hunk,
     look for a line starting `msgid` or `msgstr`.
  2. **Fail closed.** A file whose hunks touch either one is left conflicted and
     reported, not resolved. Only header-stamp-only files may take upstream's.
  3. Where a hunk does touch them, keep the fork side. These are brand divergences
     (Pickles, Reverb, echowire), not translation updates.
  4. The kept side then carries stale `#:` source references. Fix them by
     re-extracting with `pnpm --filter fluxer_app i18n:extract`, the project's own
     flow, rather than hand-editing hunks.
  5. Account for the result: distinct fork source strings, messages per locale and
     missing count from the extract summary, and zero fork strings translated to
     the upstream name. Count the leak, not the occurrences: ask whether any
     *Pickles* msgid has a Neko translation, since `\bNeko\b` also matches
     Croatian and Bosnian words. A deliberately kept upstream-name msgid, such as
     the `Neko` settings-search synonym, belongs in the catalog with a comment
     saying why, so the next person does not delete it as a leak.

  Catalog merges must carry metadata, not only values.
- **Compose anchor changes need a set difference, not a diff read.** When upstream
  reorganises `deploy/self-hosting/docker-compose.yml` or `.env.example`, git
  silently drops fork variables that sit inside a moved region: #3047 dropped 30 of
  them, including the six `FLUXER_CAPTCHA_*` entries restored one commit earlier.
  Reading the diff does not reveal this. Compute, for each file, the `FLUXER_` names
  present at the fork's HEAD and absent from upstream's, then assert every one of
  them is still present in the merged result. Investigate each loss and either
  re-add it or record why it is safe to drop: a name with no consumer in
  TypeScript, Rust or Erlang, or one that only restates a default the code already
  applies, is genuinely dead.

  Observed once, on #3047. The mechanism is general, git aligning a moved region
  against unrelated text, but the frequency is not established: treat the set
  difference as cheap insurance rather than as a known-frequent failure.
- **Never `git stash` mid-merge.** It destroys `MERGE_HEAD`, so the next commit is a
  single-parent commit that orphans the upstream commits from the ancestry and
  leaves them listed as unmerged forever. It also strands the stashed work, which
  then misses the slice. Commit to a scratch branch instead. If it has already
  happened, write the merged sha to `$(git rev-parse --git-dir)/MERGE_HEAD` and
  confirm `git log -1 --pretty=%P` shows two parents, and check `git stash list` is
  empty before calling a merge done.

  This one holds by construction rather than by observation: `git stash` always
  clears the merge state, so the single-parent commit follows every time, not
  sometimes.
- **A clean merge is not evidence that the result compiles.** Git merges text. In a
  language with no type checker between the merge and the build, it will combine the
  fork's old function signatures with upstream's new bodies and report no conflict.
  #3072 did exactly that in `fluxer_gateway/src/guild/guild_sessions.erl`: upstream
  reshaped visibility checks to thread a per-pass memo, the fork had split the same
  function for thread channels, and the merge produced
  `session_can_view_non_thread_channel` taking no `Memo` while its body used one. The
  gateway built 235 of 344 modules with `variable 'Memo' is unbound`, and nothing in
  the conflict list hinted at it. So after any merge touching Erlang, compile the
  tree and check the module count, do not infer health from the absence of conflicts.
  This applies with full force to Erlang and to Rust macro-generated code, and to any
  generated file nothing typechecks.
- **When upstream reshapes an API, carry what the divergence defends, not the code
  as written.** Work out what the fork's version was protecting, then express that
  inside upstream's new shape. In the #3072 case the divergence was about keeping
  thread channels off the session's `viewable_channels` map, because that map is
  shared across users with equal roles and goes stale on membership change. It was
  never about function arity. So the fix routed the thread branch through upstream's
  `memo_member_channel_access` rather than restoring the fork's bare-boolean
  signature, which preserved both the objection and upstream's performance work.
  Preserving the fork's code as written would have kept the arity and lost the memo.
- **Prefer a guard test over a reviewer's memory.** Where a divergence can be
  expressed as an assertion, assert it, and mutation-check that the assertion fails
  when the divergence is reverted. `VoiceProcessingDefaults.test.ts` is the model:
  it states the divergence, says that a failure after a merge means re-apply rather
  than update the expectation, and asserts the runtime is capable first so an
  enhanced default cannot pass by silently downgrading.

  The failure mode to watch for in a check of any kind, gate or test, is one that
  **cannot go red**. Two were found in a single slice on 2026-10-03: a gate whose
  wrapper swallowed the exit status and reported a pass while the run returned 1, and
  a draft assertion that would have passed because the value it compared was
  downgraded to the expected one before comparison. Both are worse than no check,
  because the attention that would have gone to verifying by hand goes to reading
  their green instead. Mutation-check every gate and every guard: inject the fault it
  exists to catch, confirm red, revert. A check that has never been seen to fail is
  not yet a check.
- **`fluxer_marketing`** conflicts as a gitlink every time. Keep the vendored tree.
- **Deliberate divergence** is marked `// Echowire:` (or `%% Echowire:`). Keep
  ours there; where upstream reshapes an API, take its structure and carry our
  identity into it. Union distinct config fields.
- **`ChannelRow` fixtures:** upstream tests build channel rows without the
  fork's thread and forum columns, which `ChannelTypes.ts` makes non-optional on
  purpose. Add them (spread `NULL_THREAD_FIELDS` for non-thread rows).
- **Alias-rewrite import conflicts** can be scripted: union both sides, convert
  our relative paths to `@app/` aliases, dedupe per module, and watch for imports
  the fork removed on purpose.
- **Branding leaks through generated files and defaults:** regenerate
  `fluxer_api/src/api/openapi/openapi.json` and `fluxer_admin/openapi-admin.json`
  with `pnpm openapi:generate` rather than taking upstream's. Grep for `Fluxer`
  outside `fluxer_*` names and for capitalized `Echowire` in display text.
- **Desktop updater:** `fluxer_desktop/src/main/UpdaterDownloads.ts` carries four
  fork values: the `/api`-suffixed update endpoint, the Windows
  `DESKTOP_BUILD_VARIANT` segment, the echowire.org download page, and the
  artifact product name that `DownloadService` matches on.
- **Media proxy:** `fluxer_media_proxy/src/storage/response_body.rs` counts only
  empty frames against the chunk limit. Upstream's version breaks every
  Cloudflare R2 read. Keep it and its regression test.
- **Tests that assert upstream identity** (`Fluxer-*.dmg` fixtures, platform
  strings, passkey origins, OpenAPI variant counts) need the fork's values, not
  a revert of fork code.

## Fork features to protect

- **Threads and forums.** The client contract is `docs/forums-contract.md`.
  Access rules (ADR 0003, `fluxer_api/src/api/channel/services/ThreadAccess.ts`):
  a thread has no overwrites of its own and resolves every permission from its
  parent channel (VIEW_CHANNEL on the parent comes first); a thread whose parent
  is gone is inaccessible; a private thread is visible only to its members and
  to members with MANAGE_CHANNELS on the parent. The gateway applies the same rules and never caches or memoises thread
  visibility by role set (`guild_sessions.erl`,
  `guild_member_list_channel_engine.erl`). Any change to a thread permission path
  needs api integration tests (`ThreadAccessControl.test.ts`,
  `ThreadAccessReview.test.ts`, `ForumsServerParity.test.ts`).
- **Voice customisations** in `fluxer_app/src/features/voice/`: AGC and
  DeepFilter noise suppression off by default with the low-processing profile,
  the Opus application setting, region latency badges from each region's
  `ping_endpoint`, and screen-share codec and resolution clamping.
- **Desktop screen-capture bridge:** the X11 fallback in
  `fluxer_desktop/native/linux-screen-capture` (no ScreenCast portal does not
  mean no capture) and the Windows game-capture variant.
- **Pickles:** the Neko cursor cat is displayed as "Pickles". Only display
  strings changed; identifiers keep upstream's Neko names.
- **Self-hosted billing gate:** upstream disables Stripe routes when
  `FLUXER_SELF_HOSTED=true`, so billing 404s on this instance by design until the
  fork changes those gates.

## Decisions

Recorded in `docs/adr/` using `0000-template.md`: 0001 local image builds,
0002 lowercase brand, 0003 thread access control.
