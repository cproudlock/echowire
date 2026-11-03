# Staging gate

Fork-owned. Brings up the self-host stack from `deploy/self-hosting` for an image tag, runs scenarios against it,
tears it down, and exits non-zero if anything is wrong. Built because the old runner always exited 0, once tested an
empty directory and printed "done", and logged in by username on an instance that logs in by email.

## Run it

```
tools/staging-gate/gate.sh 2026-11-01a                      # gate for a tag (images must be on this box)
tools/staging-gate/gate.sh 2026-11-01a --changed-from PREV  # also run the extras that match the changed paths
tools/staging-gate/gate.sh --self-test                      # only prove the gate can fail
```

Options: `--worktree PATH` (compose and scenarios come from there; default the repo holding this script),
`--results DIR` (default `/root/gate-results`), `--keep` (leave the stack up for debugging).
Environment: `STAGE_DIR` (default `/root/stage-19t`, holds the long-lived `.env`), `GATE_BASE_URL`
(`http://localhost:8080`), `GATE_DEPS_DIR` (a directory with `node_modules/altcha-lib`; default `<worktree>/fluxer_api`),
`MIN_FREE_KEYS`, `MIN_FREE_KEY_BYTES`, `GATE_WAIT_SECONDS` (how long to wait for every service to be healthy),
`GATE_UP_SECONDS` (bound on `docker compose up -d` itself, default 240; see below), `GATE_PRODUCT_NAME`
(the product name `tools/brand-smoke.sh` must find, default `echowire`), `GATE_LOG_RESCAN_MS` (default 15000).

Exit codes: 0 `GATE_PASS`; 1 `GATE_FAIL` (a container missing or sick, or a scenario failed); 2 could not run
(lock held, no kernel key headroom, images missing, self-test failed). Results go to
`<results>/<tag>-<time>/` (`scenarios.json`, `containers.json`, `gate.json`, compose logs).

## What it checks

1. The self-test, first, every time. It plants a failure and asserts the verdict: a dead target, a failing scenario,
   an empty scenario directory, too few scenarios, a hanging scenario, a missing, unhealthy or failed container (and the
   culprit/waiting explanation), low kernel keys, a held lock, an error line in logs (a persistent error, a FATAL line
   and a repeating error fail; a one-off that stops passes), a command that outlives its bound, a wrong `api_public`
   in the discovery document, a 500 on `/help`. A planted failure that passes aborts the gate. Mutant-tested: breaking
   the discovery scenario, the status check of the pages scenario, the FATAL rule or the bound each makes the
   self-test fail.
2. One gate at a time (`flock` on `/root/staging.lock`) and enough kernel keys (the quota is shared by all containers
   of the host user; out of keys, containers die with "disk quota exceeded").
3. Every image the compose names is on the box (no pulls). The merged compose is copied into the stage dir and the tag
   is set in its `.env`.
4. `docker compose down -v`, `up -d`, then wait until every declared service is running and healthy, or (restart "no")
   exited 0. A missing service fails the gate. `up -d` is bounded by `GATE_UP_SECONDS` (240 s): compose waits on
   health checks itself, and a gateway that never serves used to take 413 s to fail. On a timeout the gate prints a
   `CULPRIT` line (the container that is starting, unhealthy, exited or restarting) and a `WAITING` line (containers
   never started because they depend on it), fails, and the EXIT trap still tears the stack down.
5. Scenarios in `scenarios/` (01 to 14, then 99 last): health and discovery, registration behind ALTCHA, claim and
   email login, gateway READY, guild and message, forum thread and reply, attachment upload, download and range
   through the media proxy, a user report that posts a tagged thread with an embed through the review webhook, the web
   app and every asset it references through the app proxy, the discovery 304, admin pages, and (added after the
   2026-11-03 fire-drill) 12 the discovery document (`api`, `api_client` and `api_public` all equal the stack's own
   `<origin>/api`; `age_policy` is an object with a `geos` array; `voice_origins` is an array; `captcha` is an
   object), 13 the marketing and docs pages (`/help`, `/download`, `/press`, `/reverb`, `/docs/` answer 200 with a
   non-empty `<title>`, `/partners` is 404, `/docs` redirects), 14 `tools/brand-smoke.sh` against the stack (the
   same script the deploy runs on prod, so an upstream string a sync brought in fails BEFORE the deploy), and a log
   scan. At least 15 core scenarios must run.

   The log scan (99) has two severities. FATAL class lines (FATAL, CRITICAL, PANIC, panicked, Traceback, unhandled
   rejection, level 60) always fail. ERROR class lines (ERROR, level 50) are re-checked: the scan waits ~15 s and reads
   only what was logged since; it fails if errors are still arriving or one message repeats 3 times, and passes with
   a note when a one-off error (a startup race such as a worker asking a snowflake shard that is not up yet) stopped.
   Nothing is added to the allowlist for that: an allowlist entry would also hide a real shard failure.
6. `extra/*.mjs`: scenarios for a particular kind of change. Each exports `when` (path globs); with `--changed-from
   REF` the runner runs those whose globs match a file changed since REF.

## Traps this handles

- The runner exits non-zero and counts scenarios; an empty or wrong directory is a failure.
- Staging runs `account_identity=email`: a username-only account is "unclaimed" and cannot create guilds, and email is
  off on staging, so the claim shortcut writes the email straight into the staging database (asserted to touch one
  row). Staging only.
- `down -v` wipes the database but the stage `.env` keeps the previous run's report-webhook id. Scenario 08 rewrites
  both webhook variables to the webhook it just created and recreates the api before reporting.
- Registrations from one address are rate-limited; the valkey cache is flushed before each.

## Fire-drill

The gate has been checked against real regressions, one patched image per drill (the 14 images of a good tag with ONE
replaced): gateway that never serves, a container that exits, a missing web asset, a media proxy answering 502, a FATAL
log line, a wrong `api_public`, marketing answering 500, docs answering 500. Every drill must fail for the right reason
and the unmodified control must pass.

## Not covered

The desktop client's upload path through the app proxy, push delivery, voice, the custom CSS trust UI, and anything
that needs a browser or an admin login. Add an extra for a specific sync when it matters.
