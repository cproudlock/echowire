# 0006. Follow upstream and remove fluxer_recon

## Status

Accepted

Date: 2026-09-16

## Context

Upstream added `fluxer_recon` on 2026-09-13 in #2719, a Rust service that
reconciles gateway voice state against what LiveKit actually holds. The same
change deleted the in-API voice reconciliation worker, but upstream wired the
new service into no deployment: not helm, not the self-hosting compose, not the
dev stack. This fork noticed the gap and deployed it, so prod has run
`fluxer-recon` since the `2026-09-13` image set, in the default `observing`
mode.

Two days later upstream deleted the service outright in #2808 (17,661 lines) and
removed its leftovers in #2810: the gateway RPC handler `gateway_rpc_misc_push`
that answered `repair_state_from_cache`, the service interfaces, and
`FLUXER_API_WORKER_ENABLE_VOICE_RECONCILIATION` from the worker. Upstream
appears to have dropped voice reconciliation as a capability rather than moving
it somewhere else.

The 2026-09-16 upstream merge initially kept recon as fork divergence, because
accepting the deletion would leave the compose pointing at an image that can no
longer be built. That left recon calling five gateway RPCs of which four still
have handlers; only `repair_state_from_cache` had lost its handler, so the
repair path would have failed at runtime while the rest kept working.

## Decision

We follow upstream and remove `fluxer_recon` entirely: the crate, its workspace
member, its Dockerfile, its build workflow and build-matrix entry, its local
build-script image, its `tools/ci` image-set component, its compose service, and
its `FLUXER_RECON_*` variables in `.env.example`. `AdditionalMetricsRenderer`
and `ServiceMetrics::with_additional_renderer` go back to `pub(crate)`, matching
upstream, since `fluxer_svc::shard` is the only remaining caller and it lives in
the same crate.

We keep the gateway voice handlers that serve the api and clients:
`confirm_connection`, `disconnect_user_if_in_channel`,
`get_pending_joins_for_channel` and `get_voice_states_for_channel` all have
callers besides recon. Only what upstream removed is removed.

## Consequences

- Voice reconciliation no longer runs anywhere. A client publishing media while
  the gateway holds no connection record for it stays invisible to others until
  it resyncs itself. That was the failure recon was deployed to cover, and we
  accept it rather than maintain 17k lines upstream abandoned.
- `repair_state_from_cache` is gone on both sides, so nothing calls a missing
  handler.
- The image set drops from 19 services to 18, and a build produces 12 images
  instead of 13.
- Prod needs a manual step at deploy time: compose no longer defines `recon`, so
  the running `fluxer-recon-1` container and its images must be removed by hand.
  `docker compose up -d` will not remove it, and `--remove-orphans` is not used
  on this stack because the marketing container has historically run outside
  compose.
- If voice state divergence shows up in practice, reviving this means taking
  upstream's deleted code out of history along with the gateway handler, and
  owning both.

## Alternatives considered

- Keep recon and restore the deleted gateway handler from history: rejected by
  the owner. It leaves the fork maintaining a service upstream abandoned, whose
  gateway counterpart only we would carry.
- Keep recon with the repair path disabled: rejected. It leaves a half-working
  service running in prod for no clear benefit.
