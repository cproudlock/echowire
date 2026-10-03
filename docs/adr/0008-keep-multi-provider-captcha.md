# 0008. Keep multi-provider captcha after upstream made ALTCHA the only one

## Status

Accepted

Date: 2026-10-03

## Context

Upstream `4f968bbc4` (#3035) made [ALTCHA](https://altcha.org) the only captcha. It
deleted the provider factory, the hCaptcha, Turnstile and reCAPTCHA providers, the
`FLUXER_CAPTCHA_*` environment layer, the captcha block of the admin Runtime
Integrations panel, the web Turnstile and hCaptcha widgets, and the Turnstile and
hCaptcha hosts from the app proxy CSP. In their place it put a keyless proof-of-work
challenge the API issues and verifies itself, configured only by `enabled`, `cost`
and `max_counter` in instance config.

For upstream this is a clear improvement: no third-party dependency, no keys to
rotate, no widget, and no user interaction. It is not available to us yet, for one
reason.

The mobile clients already published implement hCaptcha and Turnstile only, and
**fall back to hCaptcha for any provider string they do not recognise**. An
ALTCHA-only server answers their login and registration attempts with a challenge
they can neither solve nor identify. Every install at 1.7.32 or earlier would lose
both. Those builds are on the stores now and cannot be recalled; adoption of a new
build takes weeks, and some installs never update.

Two further facts shaped the decision.

Upstream does not merely drop the old configuration, it actively migrates away from
it. `getCaptchaConfig` ignores a stored legacy `altcha_captcha_config` row that had
the experiment switched off, the next write to instance integrations deletes the
stored captcha provider and its secrets, and the new `enabled` defaults to `true`.
So deploying #3035 unchanged does not leave the captcha as it was: it switches the
instance to ALTCHA on first boot, discards the Turnstile keys, and locks out every
published client, with no action by an operator.

Production configures its captcha in the environment, not the database:
`FLUXER_CAPTCHA_ENABLED=true` and `FLUXER_CAPTCHA_PROVIDER=turnstile` with live keys.
`getEffectiveCaptchaConfig` read instance config first and fell back to those
variables, and nothing had ever been written through the admin panel. #3035 deleted
the environment layer, so those variables became dead config: present in the
deployed environment, read by nothing.

## Decision

We will take #3035 as written, then restore multi-provider captcha as one deliberate
fork commit, scoped to what the lockout actually requires.

We will restore:

- `ICaptchaProvider`, `HttpCaptchaProvider`, `TurnstileProvider` and
  `HcaptchaProvider` in `fluxer_api/pkgs/captcha`.
- The `FLUXER_CAPTCHA_*` environment layer: `MasterConfig`, the loader defaults, the
  environment overrides, boot validation, the `APIConfig` projection, and the entries
  in `.env.example`, the shipped Compose file and `development.env`.
- A `provider` field on the instance captcha config (`altcha`, `hcaptcha`,
  `turnstile`, or null to inherit the environment), and a provider selector in the
  admin Bot protection panel.
- `provider` plus `hcaptcha_site_key` and `turnstile_site_key` on the instance
  discovery document, which is where a published mobile client reads what to render.
- The `X-Captcha-Type` request header, so one instance can verify ALTCHA from the web
  app and Turnstile from a mobile client.

A single challenge response will serve both client families. It always carries
`captcha_provider`, naming the provider offered to clients that cannot solve ALTCHA,
**and** `altcha_challenge`. The web app solves the ALTCHA challenge and retries with
`X-Captcha-Type: altcha`. A published mobile client reads `captcha_provider`, renders
the widget it already implements, and retries with that solution. Neither client
needed a change for this to work.

A provider whose keys are missing will turn the check **off** rather than falling
back to ALTCHA. Falling back would hand an unsolvable challenge to exactly the
clients this divergence exists to protect.

### Scope boundary: the web client and the CSP stay on upstream's shape

This divergence is **server-side only**. The web app keeps upstream's headless ALTCHA
solver, and the app proxy CSP keeps upstream's shape, including its test asserting
that no third-party captcha host is allowed.

Do not "complete" this divergence by restoring the web Turnstile or hCaptcha widgets,
the captcha modal, `useCaptcha`, the `@marsidev/react-turnstile` or
`@hcaptcha/react-hcaptcha` dependencies, or the `hcaptcha.com` and
`challenges.cloudflare.com` CSP hosts. That looks like the missing half of the
restoration and is not:

- The web app updates on reload, so it is never the client stuck without an ALTCHA
  solver. Only the published mobile builds are, and they are native, so our CSP does
  not apply to them.
- Upstream rewrote the REST interceptor contract in the same release: `RestInterceptor`
  went from `(reply, retry, reject)` to `(reply, retry)`, per-request `intercept` and
  `prepareRequest` were removed, and retries now set `skipIntercept`. The modal flow
  depended on the old three-argument contract and on being re-entered on a second 400.
  Restoring the modal means reverting that rework, which is a far larger and riskier
  divergence than the one this ADR accepts.
- Re-adding the CSP hosts weakens the policy for every web visitor to serve a widget
  no web visitor needs.

The only client-side change this fork makes is in
`fluxer_app/src/features/auth/altcha/AltchaSolver.ts`: `readAltchaChallenge` accepts a
well-formed `altcha_challenge` whatever `captcha_provider` says, because the server
now names the provider offered to clients that cannot solve ALTCHA while still
carrying a challenge this app can. Keep that, and keep the rest of the web captcha
path identical to upstream.

Two mutation-checked tests guard the property that matters, and both were verified to
fail when that property is broken:

- `packages/schema/src/domains/admin/CaptchaSchemas.test.ts`, that provider
  validation keeps accepting `turnstile` and `hcaptcha`. Narrowing the enum to
  `z.enum(['altcha'])` fails it.
- `fluxer_api/src/api/middleware/tests/CaptchaProviderDispatch.test.ts`, that the
  challenge names the offered provider. Making the challenge always report `altcha`
  fails it.

`fluxer_api/src/api/instance/InstanceController.test.ts` covers the discovery half:
that the provider and its site key are advertised, and that a provider with missing
keys advertises `none`.

## Consequences

Production keeps the captcha it has. Nothing about the deployed behaviour changes:
Turnstile for the published mobile clients, and the environment variables that
configure it are live again rather than dead. The web app moves to ALTCHA, which
removes a third-party script from the login page.

We carry a divergence in the captcha surface, and future upstream captcha commits
will conflict there. It is confined to one commit and the files it touches, and the
ALTCHA path is upstream's own code unmodified, so adopting ALTCHA fully later is a
deletion rather than a rewrite.

Captcha secrets are read from the environment only. Rotating a captcha key therefore
needs a restart rather than an admin edit, which is worse than upstream's old
behaviour for an operator and better for anyone worried about secrets in the instance
database.

Self-hosted instances are unaffected by default. With no `FLUXER_CAPTCHA_*` set, the
provider resolves to `altcha` and the instance behaves as upstream intends.

The provider selector is a new way to cause the outage this ADR prevents: setting it
to `altcha` while pre-ALTCHA mobile builds are still in use breaks login for them.
That is deliberate, because the same control is how we eventually migrate, but it
means the panel can do damage that no test can catch.

Migrating to ALTCHA-only, when we choose to:

1. Ship a mobile release that solves ALTCHA, reading `altcha_challenge` from the
   challenge response and sending `X-Captcha-Type: altcha`. It can ship while the
   server still offers Turnstile, because both fields are always present, so this
   step is safe on its own and needs no server change.
2. Wait for store adoption. The trigger is a telemetry question, not a date: when the
   share of registration and login attempts arriving from pre-ALTCHA builds is small
   enough to accept losing, and no sooner. Until then `captcha_provider` must keep
   naming a widget provider.
3. Set the provider to `altcha` in the admin Bot protection panel. This is reversible
   in one edit, which is the point of making it instance config rather than a code
   change.
4. Once no supported client needs a widget, delete the divergence: the four provider
   files, the environment layer, the provider field, the discovery site keys and
   `X-Captcha-Type`. That returns us to upstream's shape exactly.

Step 3 before step 2 is the outage this ADR exists to prevent.

## Alternatives considered

**Resolve around the commit, keeping our captcha files and taking the rest.** Smears
the divergence across a dozen conflict resolutions in every later captcha commit, and
leaves upstream's ALTCHA work only half present, so adopting it later means redoing
the merge.

**Take the commit and default `enabled` to false.** One line, and it does prevent the
lockout, but it trades the instance's entire spam protection on registration and
login for that safety, and leaves prod with no captcha at all for however long the
migration takes.

**Restore the web Turnstile and hCaptcha widgets, the captcha modal, the two npm
dependencies and the CSP hosts too.** Unnecessary: the web app updates on reload, so
it can run upstream's headless ALTCHA solver. Restoring them would also mean
reverting upstream's rewrite of the REST interceptor contract, which the modal flow
depended on, and re-adding third-party script hosts to the CSP for no benefit.

**Restore reCAPTCHA and the provider factory.** No instance has ever configured
reCAPTCHA, and two provider classes do not need a factory.

**Keep captcha secrets in instance config, as upstream did before #3035.** Would mean
restoring the whole `integrations.captcha` surface across the repository, the admin
Rust types, the admin UI and the admin OpenAPI spec, which is the single largest piece
of the revert, to store secrets that production already keeps in the environment.

**Restore the ALTCHA rollout experiment** (`rollout_basis_points`, allowlists,
per-user targeting). Upstream collapsed it, and the web app simply uses ALTCHA, so
there is nothing left to roll out gradually.

**Stay on the pre-#3035 captcha and skip the commit entirely.** Leaves the fork unable
to take any later upstream captcha work without first doing this merge anyway, and
forgoes ALTCHA on web, which is a real improvement available now.
