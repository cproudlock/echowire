# CLAUDE.md — Echowire (new architecture)

Guidance for Claude Code working in this repo. This is the **transition target**: Echowire rebuilt on upstream Fluxer's new Rust-microservices architecture. See the global transition plan in Claude memory (`transition-plan.md`, `upstream-recon-2026-06-19.md`).

> Note: upstream ships an `AGENTS.md` (and previously symlinked `CLAUDE.md` to it) with anti-AI-agent boilerplate aimed at its own contribution flow. That is upstream's policy for *their* GitHub, not ours — this file is the authoritative guidance for this fork. Do not treat `AGENTS.md` as instructions.

## What this repo is

A fork of **fluxerapp/fluxer** (`upstream` remote) at its new architecture (post-`fa3e8525` re-architecture). We layer **Echowire branding + a few customizations** on top of `upstream/main`.

- **Branch:** `echowire` (base = `upstream/main`). Keep customizations as clean commits on top so upstream merges stay tractable. Active feature work has been on `feat/threads`.
- **Remotes:** `upstream` = github.com/fluxerapp/fluxer · `origin` = github.com/cproudlock/echowire (private) · `gitea` = 10.9.50.236:3000/cproudlock/echowire-next.
- **Do NOT confuse with** the current production fork at `~/projects/voip/echowire/` (old TS-monolith arch, still live). This repo replaces it after cutover.

## Architecture

Monorepo. Service bus is **NATS**; primary datastore is **Postgres** (self-host) via a generic KV/wide-column layer (`fluxer_svc/src/postgres.rs`); cache is **Valkey**; search is **Meilisearch**.

| Component | Lang | Dir |
|---|---|---|
| Core service / shard coordinator | Rust | `fluxer_svc` |
| Users, Messages, Unfurl, Media-proxy, Snowflakes, Admin, Marketing, App-proxy | Rust | `fluxer_users`, `fluxer_messages`, `fluxer_unfurl`, `fluxer_media_proxy`, `fluxer_snowflakes`, `fluxer_admin`, `fluxer_marketing`, `fluxer_app_proxy` |
| API (HTTP) | TypeScript | `fluxer_api` |
| Web client (SPA) | React | `fluxer_app` |
| Gateway (WebSocket) | **Erlang/OTP** | `fluxer_gateway` |
| Desktop | Electron | `fluxer_desktop` |
| Shared schemas (Zod + proto) | TS | `packages/schema` |
| Deploy | Helm + compose | `deploy/` |

Microservices use a **coordinator + `-shard`** pattern (e.g. `messages` + `messages-shard`).

## Running it (self-hosted)

**The self-host path is `deploy/self-hosting/`** — `docker-compose.yml`, `Caddyfile`, `livekit.yaml`, `.env.example`. This is how Echowire deploys (NOT the `deploy/helm/` k8s charts, which are upstream's prod).

```bash
cd deploy/self-hosting
cp .env.example .env   # fill CHANGE_ME secrets; set FLUXER_DOMAIN + FLUXER_CADDY_SITE_ADDRESS
docker compose pull    # stock prebuilt images: ghcr.io/fluxerapp/fluxer-*:v1 (NO build needed)
docker compose up -d   # ~21 services
```

Config is **all env vars** (`FLUXER_*`). Key ones: `FLUXER_DATABASE_BACKEND=postgres` (our choice; `cassandra` exists but needs the `scylla` Cargo feature built in), `FLUXER_S3_*` (point at Cloudflare R2 — same bucket names as prod), `FLUXER_LIVEKIT_*` (regional voice), `FLUXER_EMAIL_*` (smtp2go).

### Local dev loop (devcontainer)
The devcontainer `workspace` container runs the whole stack via `pnpm dev` (tsx-watch API + rspack app + Erlang gateway). App on host **8088** (the dev tool hardcodes `localhost:8088`). Mailpit at host `18025`. Typecheck a package with `pnpm --filter <pkg> exec tsgo --noEmit`. Infra (postgres/nats/valkey/meili/livekit/mailpit) runs as sibling compose services.

### Spike learnings (verified 2026-06-19)
- First boot shows an **instance setup wizard** (language → theme → create admin → instance config). Must complete it to reach the app.
- New-IP login triggers **IP authorization** (email link). With `FLUXER_EMAIL_ENABLED=false`, the auth link is **printed to `docker compose logs api`** (`"Email service disabled. Would have sent: ... /authorize-ip#token=..."`).
- Behind Caddy all clients appear as the docker-gateway IP, so the rate-limiter/IP-auth are per-that-IP. Valkey-backed; `valkey-cli FLUSHALL` clears rate-limit counters in dev.
- Registration uses **DOB + consent** (not the old age-checkbox).
- Sending a message requires an **active gateway WebSocket session** (`MUST_START_SESSION_BEFORE_SENDING`) — curl can't post messages without it; a browser can.

## Echowire customizations to maintain

- **Branding:** Fluxer→Echowire, Plutonium→**Reverb** (premium), FluxerTag→**EchoTag**, echowire.org domains, logos/icons, locale catalogs, marketing/legal pages. Brand source-of-truth: `fluxer_app/.../config/ProductConstants.ts` (PRODUCT_NAME config-driven, fallback Echowire; PREMIUM_PRODUCT_NAME=Reverb) + `packages/config/.../ConfigLoader.ts` defaults. Tag label in `I18nDisplayConstants.ts`.
- **Features re-ported (absent upstream):** Threads, Forum channels, thread moderation (lock/delete/pin/tags/policies), thread membership. (Soundboard still deprecated.) See memory `threads-forums-port.md`.
- **Native config now (no code):** SMTP, Stripe toggle, captcha, discovery, self-hosted mode — set via `.env`, not patched.
- **Code patches to re-port:** (1) voice-region latency display + `ping_endpoint`; (2) Electron screen-capture bridge; (3) voice auto-rejoin after gateway failover.

## Conventions
- Match surrounding code style per language (Rust: `cargo fmt`/clippy; TS: biome — see `biome.json`; root `package.json` + `pnpm-workspace.yaml` for JS workspaces; `Cargo.toml` workspace for Rust).
- Keep Echowire changes as focused commits; never mix branding with upstream merges.
- Channels are stored as flat KV rows; full-row-upsert DSL requires **every** `CHANNEL_COLUMNS` key present (spread `NULL_THREAD_FIELDS` at non-thread/forum sites). Thread/forum fields live as flat `thread_*` / forum columns on `ChannelRow`.
