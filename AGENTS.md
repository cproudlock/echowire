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
leak to fix, and inside `fluxer_app` that is now asserted rather than remembered:
`fluxer_app/src/features/i18n/BrandInUserVisibleText.test.ts`. `Reverb` (premium, upstream's Plutonium) and `EchoTag` (upstream's
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
    pnpm test                                 # the whole sweep; see below for what that means
    cd fluxer_api && pnpm exec vitest run     # fluxer_api alone, for iterating
    pnpm --filter fluxer_docs verify          # sidebar, coverage, schemas, style

`pnpm test` is `cargo run -p fluxer-dev -- test`, and `tools/dev/src/tasks.rs` is the
only answer to what it covers: a recursive `--if-present test` over the workspace
excluding `fluxer_desktop`, then `fluxer_desktop`, then `fluxer_api`. So it already
includes both of the suites that look like they need a separate run, and on
2026-10-03 the slice gate ran the fluxer_api suite twice for identical results, 590
files and 5547 tests both times. Line 2 above is for iterating on api tests alone,
not a gate the sweep leaves out.

That annotation previously read "excludes fluxer_api", which was simply false, and
it is worth seeing it as the mirror image of the `voice_engine_v2` finding rather
than as a separate slip. There, the gate list claimed *more* coverage than it had,
which wasted nothing and hid real defects. Here it claimed *less*, which hid nothing
and wasted six minutes a slice. Both came from describing a gate from memory instead
of reading what it runs, so the defence is the same either way: when you want to know
what a gate covers, read the task that defines it, and count the suites in its own
output.

**The local gate above is NOT the whole of CI, and CI had been red far longer
than anyone noticed.** `tests.yaml` runs on every push to `echowire`, and when
this was measured on 2026-10-04 the last 40 runs, oldest 2026-09-16, contained
**not one pass**. (An earlier version of this note said "five consecutive
pushes", counted from one session's own pushes; that was badly wrong.) The
breakage was inherited rather than introduced by any recent merge, and it
persisted because the local gate was the only gate being read.

**It is green again as of `a37d5142e`** (run 37173653281, all nine jobs, zero
failed steps), the first pass in at least 41 runs. The entire backlog was four
things, and nothing was hiding behind the last of them:

1. `cargo deny` — three unmatched skips left behind as merges moved the graph.
2. `gateway_fmt` — nine merge-touched Erlang modules.
3. `cargo fmt` — three `tools/ci` modules. CI runs THREE formatting scopes:
   `--all`, libfluxwebp by its own manifest, and 31 desktop native workspaces.
4. `clippy` — five dead `desktop_release_*` helpers in `release.rs`, plus twelve
   items after the test module in `common.rs`.

Each fix only revealed the next, because CI stops at the first failing step. So
a green local gate plus a red CI means walking the steps in order rather than
expecting one fix, and "I fixed the failure" is never the same claim as "CI
passes". The local gate ran none of these:

    cargo deny --locked check -D warnings
    cargo run -p fluxer-ci -- ci --step gateway_fmt
    cargo run -p fluxer-ci -- ci --step gateway_compile
    cargo run -p fluxer-ci -- ci --step gateway_dialyzer

The two that were actually failing are the two that are cheapest to forget.
`cargo deny` fails on **unmatched-skip** whenever the dependency graph moves
under a merge, because `-D warnings` promotes it: a skip naming a version no
longer in the graph is an error, not a tidy-up. And `gateway_fmt` catches
formatting in any Erlang module a merge touched, which no other step sees.

So after any upstream merge, run those four as well, and **read the CI result
for the push** rather than treating the local gate as the last word. A local
gate that covers less than CI is a gate that reports green on a red tree, which
is the same defect as a gate that cannot fail, arrived at from the other side.
`rebar3` is not in this container; the gateway steps need the `erlang:28` image
or the `fluxer_gateway` image build.

**Invoke these commands. Do not reimplement them.** A wrapper that paraphrases a
documented command is a copy that rots silently, and the 2026-10-03 audit found two
such copies, both of which had been reporting greens they had not earned:

- `pnpm --filter @fluxer/app lint` matched no project at all, because the package is
  named `fluxer_app` and has no `lint` script. pnpm printed "No projects matched the
  filters" and **exited 0**. Six slices reported "eslint clean" having never run
  eslint once. `pnpm --filter` succeeding on an empty match is the perfect example of
  the hazard: the failure is indistinguishable from success.
- Running `packages/schema`, `packages/config` and `packages/constants` individually
  instead of `pnpm test` silently skipped nine workspace packages that have tests:
  `errors`, `hono`, `i18n`, `ip_utils`, `limits`, `logger`, `openapi`, `snowflake`
  and `voice_engine_v2`. The last one covers voice, where this fork carries
  divergences, so the paraphrase skipped exactly the code most in need of a gate.

A third variant is an **incomplete list**. On 2026-10-03 the docs check was missing
from the list above, and someone reaching for it invented `pnpm docs:verify`, which
does not exist. That failed loudly, which is the good outcome, but the invention was
caused by the omission: a list that looks complete and is not invites exactly this.
The real command, now listed, is `pnpm --filter fluxer_docs verify`, a four-part
check over sidebar, coverage, schemas and style. It also prints a handful of
pre-existing optionality advisories in the admin blocklists and discovery pages
without failing, so advisories in its output are not a regression.

So the three variants, each with its own defence: a **wrong rule** is fixed by
rewriting it, **drifted automation** only by invoking the documented command rather
than an equivalent, and an **incomplete list** only by adding the gate to the list
the moment you notice you had to go looking for it.

One deliberate exception to "invoke these commands", and it is the only one. An
automated runner should spell the docs gate `cd fluxer_docs && pnpm verify` rather
than `pnpm --filter fluxer_docs verify`, because `--filter` is the construct the
eslint finding above condemns: it exits 0 when it matches nothing, so a rename of
either the package or the script would turn the gate green instead of red. The
directory form cannot pass vacuously. This is not licence to paraphrase the rest.
It is a narrower claim: where the documented spelling can succeed without running,
the runner should use the spelling that cannot, and say which line it departs from
and why.

Note that this is a different failure from a rule being wrong, and it needs a
different defence. The `.po` rule below was **documentation that was wrong**, and the
fix was to write a better rule. These two were **documentation that was right, with
automation that had drifted from it**, and no amount of rule-writing prevents that.
The only defence is to invoke the documented command rather than an equivalent, and
to mutation-check any wrapper: inject a fault of the class each gate catches and
confirm it goes red. A gate that has never been seen to fail is not yet a gate.

Two gates cannot be a bare tool invocation, because running the tool alone cannot
fail for the property worth gating:

- **`openapi:generate` writes the specs**, so by itself it only fails when generation
  errors. A committed spec that has drifted passes. Gate on regeneration producing no
  change: run it, then `git diff --quiet` the two spec files.
- **The gateway eunit** always fails a fixed set of tests in this container, which
  cannot build the `guild_member_list_oset_nif` Rust NIF, so its exit status is not
  pass/fail. Gate on the criterion: the tree compiled fully, no assertion failure, no
  undefined function other than that NIF.

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
  3. Where a hunk does touch them, keep the fork side **for a renamed string**.
     These are brand divergences (Pickles, Reverb, echowire), not translation
     updates.
  4. The kept side then carries stale `#:` source references. Fix them by
     re-extracting with `pnpm --filter fluxer_app i18n:extract`, the project's own
     flow, rather than hand-editing hunks.
  5. **Then backfill, because keeping ours is only half the rule.** Keeping the fork
     side discards upstream's side wholesale, including its translations for msgids
     that are genuinely *new* rather than renamed. Re-extracting re-adds those msgids
     from the merged source with empty values, and `lingui compile --strict` refuses
     to build with a missing translation, so on #3090 this left 9 missing per locale,
     297 in total. Copy those in from upstream's own catalogs, filling **only**
     entries that are empty here and translated there, so a fork translation can
     never be overwritten.

     The asymmetry is the durable part: **ours wins for a string the fork renamed,
     theirs wins for a string the fork does not have.** Confirm with
     `pnpm --filter fluxer_app lingui:compile`, which fails on any locale still
     missing one, and check the extract summary reports 0 missing.
  6. Account for the result: distinct fork source strings, messages per locale and
     missing count from the extract summary.

     The leak question itself is no longer yours to remember.
     `BrandInUserVisibleText.test.ts` asks it per entry across all 34 catalogs,
     which is the only way it can be asked correctly, since `\bNeko\b` also
     matches Croatian and Bosnian words and counting occurrences over a file gives
     a false positive. It also asserts how many catalogs and entries it scanned,
     so a broken walk fails instead of reporting a clean sweep of nothing. A
     deliberately kept upstream-name msgid, such as the `Neko` settings-search
     synonym, goes in that test's `ALLOWED` list with its reason, not in a comment
     someone has to find.

  Catalog merges must carry metadata, not only values.

  **Never assume ASCII word boundaries in catalog work.** A brand or term in 34
  languages is not a standalone ASCII word, and `\b` quietly stops matching in at
  least three ways. On 2026-10-03 a substitution using `/\bFluxer\b/` missed four
  values in two locales from opposite directions: Japanese `によりFluxer APIから`,
  where Python's `\w` is Unicode-aware so kana count as word characters and there is
  no boundary on either side, and Swedish `Fluxers API`, where the genitive *s*
  breaks the trailing boundary. A dotted host is the third: a boundary falls between
  a letter and a dot, so a trailing `\b` rejects `fluxer.app` inside
  `fluxer.app/download` exactly when it matters. Substitute without boundaries and
  protect the longer tokens explicitly, the way `Fluxer(?!Tag)` does.

  Worth knowing that `\b` is not even consistent across the two languages in this
  repo: Python's is Unicode-aware, JavaScript's is ASCII-only. That is what caught
  the mistake. The Python fixer skipped the Japanese value while the gate's
  JavaScript regex flagged it, and the disagreement surfaced as the mutation
  harness reporting `clean run: FAIL` before injecting anything. If a fixer and its
  gate disagree about the same file, the gate is usually right, because it was
  written to describe the property rather than to perform the edit.

  **Where to be suspicious.** This rule has now been corrected twice in one day, and
  both times the step order survived while the wrong part was a claim about *which
  side is right*: first "almost always header stamps, take upstream's", then "keep
  ours wherever a hunk touches text". So trust the procedure and re-derive the side.
  If a step tells you a side wins, check whether the string is one the fork renamed
  or one the fork does not have, because that is the question the rule keeps getting
  wrong.
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
- **A revert whose scope is wider than the change will take the change with it.**
  This is the stash rule in a different costume, and it bites hardest while
  mutation-checking, which is now standard practice for every gate and guard. On
  2026-10-03 a mutation script ended with `git checkout -- <file>` to undo its own
  injected fault, and silently removed the uncommitted fix in the same file; the
  commit that followed contained nothing and the fix had to be written twice.

  So: **commit the fix first, then mutate.** That makes the restore point the thing
  you want to keep, and `git checkout` becomes safe rather than destructive. Prefer
  reverting the mutation itself, by replacing the mutant string with the original,
  over restoring a whole file. After any mutation run, check that the thing under
  test is still present rather than assuming the revert was surgical. The general
  form holds by construction, like the stash case: `checkout`, `restore`,
  `reset --hard` and `stash` all operate on a unit larger than the edit, so anything
  else living in that unit goes too.
- **Replace a hand-enumerated set with the thing that derives it.** A list of
  packages, filters, crates, locales or files silently stops covering whatever is
  added later, and the gap never announces itself. Five were found on 2026-10-03, and
  between them they concealed two real pre-existing failures: `pnpm --filter` on a
  name that matched nothing, per-package test runs covering 4 of 20, three cargo
  crates named instead of the workspace's 16, the gateway NIF exception, and
  `MODULE_REGISTRY_TEST_FILES` in `fluxer_api/vitest.config.ts`.

  That last one is the worst-presenting of the family and the one to learn from,
  because it fails **randomly** rather than silently. The api project runs with
  `isolate: false`, so a test replacing a module with a `vi.mock` factory leaks it
  into other files in the pool and the failure appears intermittently in a file the
  author never touched. A single green run looks like proof.

  It turned out to be derivable: of 588 api test files only seven use a mock factory,
  and the one that was unlisted replaced `@app/api/Logger`, which 225 source files
  import, with a Proxy that throws on any property access. So
  `VitestIsolationCoverage.test.ts` now derives the requirement and fails by name
  when the list stops covering a file.

  The order to try: **derive the set** if the property is mechanically detectable;
  failing that, **make the symptom deterministic**, since a check that fails one run
  in two is worse than one that fails every time; and failing both, keep the
  enumeration but write down **why each member is there**, as the gateway gate does
  for the single NIF it cannot build. A deliberate list with a rationale is fine. An
  inherited one is not.
- **A clean merge is not evidence that a wire value is still unique.** When upstream
  appends to a numbered or bitmasked set this fork has also appended to, both sides
  add a distinct name, git merges both, nothing conflicts, and every gate stays green
  while one number means two things. The collision is in the meaning, not the syntax,
  so no compiler and no test can see it.

  The blast radius is worse than a web bug. `ChannelTypes` 11, 12 and 15 (threads and
  forums) exist only in `cproudlock/dart_sdk` branch `echowire`, so a collision
  silently reinterprets channel types on mobile clients already in the field, which a
  deploy cannot fix. Whichever side moves has to move in the API, the SDK and the
  Flutter client together, so a renumbering is never a merge-time decision: stop and
  escalate.

  Before resolving a merge that touches `packages/constants`, diff the sets by
  **value**, not by name: `ChannelTypes`, `MessageTypes`, `MessageFlags`,
  `Permissions`, the channel and attachment flags, and the guild feature strings.

  **Why this keeps coming out clean, and when it would not.** Both sides take
  Discord's numbering, so two independently added Discord-compatible features land on
  different numbers by construction rather than by luck. #3090 is the worked example:
  upstream took `GUILD_ANNOUNCEMENT: 5` and `CHANNEL_FOLLOW_ADD: 12`, clear of the
  fork's 11, 12 and 15 channel types and its `THREAD_CREATED: 18`. The residual risk
  is an **invented** value with no Discord counterpart, which is why upstream parks
  its own at 998 and 999. So the check stays necessary, but expect it to pass, and
  treat a fork-invented number as the case that needs real care.

  One standing risk, recorded rather than acted on: the fork's four thread
  permissions sit at bits 34, 35, 36 and 38, gaps **below** upstream's high-water mark
  of 54, deliberately skipping 37 where upstream holds `USE_EXTERNAL_STICKERS`. If
  upstream ever fills 34, 35, 36 or 38 that is a silent collision of this kind.
  Moving them above upstream's maximum would remove the hazard but is an API, SDK and
  Flutter change together, so it needs deciding rather than doing mid-merge.
- **A clean merge is not evidence that the clients in the field still work.** The
  wire-value rule above is about a number meaning two things. This is the same hazard
  with a path instead of a number: when upstream moves an asset from
  network-fetched to bundle-included, the change is correct for every client built
  after it and broken for every client already installed, because an installed client
  keeps requesting the URL it was built with. No gate here can see it, for the same
  reason no gate can see a number collision: the stale client is not in this tree.

  The worked example is upstream #3087, which bundled the DeepFilterNet3 wasm and
  model into the app and deleted `fluxer_static/libs`. Checking that no Dockerfile,
  Caddyfile or compose in the repo still referenced the path was the right check *for
  the repo*, and it came back clean, so the slice went green on every gate. The
  problem was outside the repo: the SPA fetched those assets over the network as
  `${RuntimeConfig.staticCdnEndpoint}/libs/deepfilternet3`, production's Caddyfile
  routed `/libs/*` to the static image, and that image served 40.1 MB of them.

  What made it bite is the part the repo cannot tell you: **desktop ships its own
  renderer bundle, and desktop stable was 2026.825.12857 from 25 August 2026, seven
  weeks behind.** That build requests `/libs/deepfilternet3` by absolute path.
  Deploying the deletion would have killed DeepFilter noise suppression for every
  desktop user on stable, reported as nothing more specific than "noise suppression
  stopped working". A browser self-heals on the next reload; a desktop install does
  not.

  So the question to ask is not what the repo references. It is **what the oldest
  supported client fetches.** Before taking a commit that deletes a served asset or
  changes an asset URL, check the published desktop stable version and whether its
  renderer bundles the asset itself. If it does not, keep the served copy as a fork
  divergence alongside the new in-bundle copy, and say in the comment what retires
  the duplication, so the next reader does not delete it for looking redundant.

  Mitigated by a gate rather than a note:
  `fluxer_app/src/features/voice/utils/StaticAssetContract.test.ts` pins the paths
  deployed clients still fetch, asserts each resolves in `fluxer_static`, asserts the
  Dockerfile still copies the tree, and separately derives the paths the current voice
  code constructs so a new network-fetched asset cannot be added without the file.
  The pinned half **cannot be derived**, and that is the point rather than a
  shortcoming: the paths an installed client requests live in that client's bundle,
  not in this repository. So it is enumerated, each row carrying the build that
  fetches it and the condition that retires it, and a row is retired by the published
  desktop build catching up, never by the repo no longer needing it.
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
- **Re-run before theorising.** When a test fails and the code under test looks
  correct, the cheapest next move is another run, not a hypothesis. The second
  failure's *identity* is the diagnostic: the same test twice is a defect, a
  different test in the same pool is shared state, and a clean run is a flake whose
  cause is still worth a minute.

  This is not a counsel of patience, it names a specific trap. On 2026-10-03 a fork
  thread test failed right after a merge, and instrumenting it showed the code doing
  exactly what the assertion asked: first run writes, second run skips. From a single
  failure the tempting reading is that the instrumentation is wrong, and the next hour
  goes into the subject under test. What settled it was re-running, which failed a
  *different* test in the same non-isolated pool, and two unrelated failures in one
  shared pool is shared mutable state rather than a bug in either. Upstream's very
  next commit was the fix.

  So when instrumentation says the code is healthy, believe the measurement and widen
  the question instead of doubting it. Ask whether the failure moves between runs,
  whether the file passes alone, and whether upstream has already fixed it, before
  forming any theory about the code. One data point does not have a shape.
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
  with `pnpm openapi:generate` rather than taking upstream's.

  The general "grep for `Fluxer`" instruction that used to live here is gone,
  because `BrandInUserVisibleText.test.ts` now asserts it for `fluxer_app` display
  strings and all 34 catalogs, and a rule duplicating a gate is what people trust
  when the gate is inconvenient. What that gate does **not** cover, and so is
  still yours to check:

  - the generated specs above, where `Plutonium` in a `.describe()` string is
    deliberate and matches upstream on purpose,
  - `fluxer_admin`'s Maud templates, which are Rust and operator-facing. The
    pattern there is upstream's own: take the configured
    `branding.premium_product_name` rather than a literal, as
    `premium_mode_form` and `plutonium_page_section` both do, and assert it.
  - every package other than `fluxer_app`.

  Extending the gate is better than re-adding the grep. If you find a leak in one
  of those three, the fix is a case in the test, not a line here.
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
