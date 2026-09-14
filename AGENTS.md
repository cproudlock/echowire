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
| Voice fleet reconciler (LiveKit census and control) | Rust | `fluxer_recon` |
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
- **Gateway:** rebar3 is not in the container. Compile the touched modules with
  `erlc -DTEST` inside the `erlang:28-slim` docker image and run their eunit
  there; the `fluxer-gateway` image build does the full compile.

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

- **`.po` conflicts** are almost always header stamps. Confirm no hunk touches
  msgid/msgstr, then take upstream's. Catalog merges must carry metadata, not
  only values.
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
