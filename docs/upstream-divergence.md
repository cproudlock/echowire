# Upstream divergence ledger

Every place echowire deliberately differs from upstream (fluxerapp/fluxer). Read this before each
upstream sync (ADR 0012, rule 4): a merge must not silently drop or "fix" a row below.

How to use it:

- "Drift check" says how to tell a row has been lost or has gone stale after a merge. Run it after
  the merge, not before.
- An addition lives in its own files and is hooked into upstream files at as few points as
  possible, each marked `// Echowire:` (or `%% Echowire:` in Erlang). Searching the tree for
  `Echowire:` lists every hook.
- Add a row in the same change that introduces the divergence. Remove it only when the divergence
  is retired, and say why in the commit.

## Threads and forums (ADR 0010, ADR 0012)

The standing rule: keep as closely as possible to upstream's implementation, with our own
additions where they match Discord's behaviour. Upstream's web UI for threads and forums runs
as-is; the rows below are the only places we differ.

| Item | Our files (new) | Hook points in upstream files | What and why | Drift check |
| --- | --- | --- | --- | --- |
| "N New" pill beside a forum in the channel list | `fluxer_app/src/features/forum/components/ForumNewPostsPill.tsx` and `.module.css`; `fluxer_app/src/features/forum/utils/ForumNewPostCount.ts` (+ `.test.ts`); copy in `ForumEchowireDescriptors.ts` | `fluxer_app/src/features/app/components/layout/ChannelItem.tsx`: one import and one render next to the mention badge | Upstream shows an unread dot on a forum and a "New" badge per post card, but no count in the channel list. Discord shows "N New". The pill counts open posts by other people newer than the forum's ack, and renders only when upstream's `hasForumUnread` is true, so the new-posts setting and acking stay upstream's. | `ForumNewPostCount.test.ts` fails if the rule changes. Grep `ForumNewPostsPill` in `ChannelItem.tsx`; if absent the hook was dropped. If upstream renames `hasForumUnread` or `ReadStates.get().ackMessageId` typecheck fails. |
| Participant avatars on forum post cards | `fluxer_app/src/features/forum/components/ForumPostParticipants.tsx` and `.module.css` | `ForumPostCard.tsx`: one import and one render in the footer. `fluxer_app/src/features/channel/models/Channel.ts`: `member_ids_preview` added to `ThreadChannelFields` and `THREAD_FIELD_KEYS`, plus a `memberIdsPreview` getter | Discord shows who is in a post on its card. Our retired build used a `recent_participant_ids` server field; upstream has no such field, so this uses upstream's `member_ids_preview` (most recently joined members, newest first). Sending a message joins the thread (`ThreadMessageActivity`), so repliers appear. It is a join-recency window, not a list of authors; that gap is accepted. | Grep `ForumPostParticipants` in `ForumPostCard.tsx` and `member_ids_preview` in `Channel.ts`. If upstream starts reading `member_ids_preview` in its own getter, delete ours and use theirs. |
| Forum examples ("See Examples") | `fluxer_app/src/features/forum/components/ForumExamples.tsx` and `.module.css`; copy in `ForumEchowireDescriptors.ts` | `ForumChannelView.tsx`: `ForumEmptyState` and `ForumPostList` take a `forum` and an `onNewPost` prop (threaded from the existing `handleNewPost`); one render of `ForumExamplesButton` in the empty state | Discord's empty forum offers example first posts. Picking one opens upstream's own inline composer with that title. Client-side copy only; shown only to people who can create a post. | Grep `ForumExamplesButton` in `ForumChannelView.tsx`. If upstream adds its own empty-state action, drop ours. |
| Closed posts | None | None | Not carried. Upstream (#3309, and `buildForumPostList`) always lists closed posts under an "Older posts" heading with load-more, and keeps a just-closed post visible without a reload. Our toggle hid them by default; upstream's behaviour covers the need. Recorded so nobody re-adds the toggle. | If upstream stops listing archived posts in `getForumPostListView`, reopen this row. |
| Add to Post | None yet | None | NOT carried, blocked on the server. It needs `POST /channels/{id}/starter-message/attachments`, the `STARTER_ATTACHMENT_*` error codes and the decay re-pointing, all from the retired `docs/forums2-contract.md` section 2; upstream has none of these (its #3295 only keeps composer attachments). Needs a maintainer decision on whether to port that API. | `grep -r starter-message fluxer_api/src` is empty until it is ported. |
| Mobile post header actions, mobile add-member UI | Not in this change | n/a | Phase 5 (mobile). Listed so the ledger is complete. | n/a |

Behaviour where we chose upstream over our old behaviour (no code to carry, listed so a reader
does not "restore" the old behaviour): private-thread moderators are MANAGE_THREADS or
administrator; default thread notification follows the parent; forum posts need SEND_MESSAGES
plus a starter message; the thread-created system message is deletable; the OP badge is for forum
posts only. See ADR 0012, Phase 0 item 2.

## Other divergences

| Item | Files | What and why | Drift check |
| --- | --- | --- | --- |
| Unread push cap | `fluxer_gateway/src/push/push_unread_cap.erl` (and its eunit tests); called last in `filter_eligible_users` in the push eligibility modules | Per user, per channel cap on pushes since the channel was last read; past the cap a message still arrives in the app but does not buzz the phone. ADR 0009. It must keep running last, and must key correctly now that every thread has its own channel id. | Run the gateway eunit tests for `push_unread_cap`. After a push eligibility merge, check the cap is still the last filter. |
| Multi-provider captcha | `fluxer_api/pkgs/captcha` (provider interface, Turnstile, hCaptcha), `fluxer_api/src/api/middleware/CaptchaMiddleware.ts`, `fluxer_api/src/api/instance/InstanceConfigRepository.ts`, the `FLUXER_CAPTCHA_*` config layer, the admin Bot protection selector | Upstream made ALTCHA the only provider; shipped mobile clients can only render hCaptcha or Turnstile, so we keep a provider dimension. The challenge response carries both `captcha_provider` and `altcha_challenge`. A provider with missing keys turns the check off rather than falling back to ALTCHA. ADR 0008. | `CaptchaChallenge.test.ts`, `CaptchaMiddleware.test.ts` and `InstanceController.test.ts`. `provider` must still appear in the instance discovery document. |
| Dual `echowire://` and `fluxer://` URL schemes | `packages/constants/src/AppProtocolConstants.ts`, `fluxer_app/src/features/ui/utils/AppProtocol.ts`, `fluxer_desktop/src/common/Constants.ts` (`APP_PROTOCOLS`) | We own `echowire://` and keep accepting `fluxer://` so existing links and shipped clients keep working. ADR 0011. | `AppProtocolConstants.test.ts` and `AppProtocol.test.ts`. `APP_PROTOCOLS` must list both outside development. |
| Voice region ping endpoint | `packages/schema/src/domains/channel/ChannelSchemas.ts` (`ping_endpoint` in `RtcRegionResponse`), `fluxer_api/src/api/channel/services/ChannelRequestService.ts`, `fluxer_api/src/api/rpc/RpcService.ts`, client `fluxer_app/src/features/voice/utils/useRegionLatencies.ts` | The settings voice-region list measures latency by pinging each region's endpoint, so the API returns `ping_endpoint` (null for the automatic region). | Grep `ping_endpoint` in all four places after a merge; the region list shows no latency if one is lost. |
| App proxy discovery of `/.well-known/fluxer` | `fluxer_app_proxy/src/discovery_cache.rs`, `fluxer_app_proxy/src/config.rs` (`DEFAULT_DISCOVERY_UPSTREAM_URL`) | The proxy caches the instance discovery document and reads endpoints from it. Upstream's defaults point at fluxer.app hosts; this deployment must resolve its own discovery document. Recorded from the maintainer's list; the exact local edits were not re-derived when this ledger was created, so confirm them against `git log -- fluxer_app_proxy` at the next sync. | App proxy tests (`cargo test` in `fluxer_app_proxy`), and a request for `/.well-known/fluxer` through the proxy on a staging stack. |
| Premium tier name "Reverb" | `fluxer_app/src/features/app/config/ProductConstants.ts` (`DEFAULT_PREMIUM_PRODUCT_NAME`) | Client default for the premium tier is "Reverb", not upstream's name. Brand rule: the product is lowercase `echowire`. | `fluxer_app/src/features/premium/utils/PremiumUtils.test.ts` and `BrandInUserVisibleText.test.ts`. |
| Voice engine codec negotiation | `fluxer_app/src/features/voice/engine/ScreenShareCodecNegotiation.ts`; `knip.json` ignoreIssues entries for `fluxer_app/src/features/voice/utils/ScreenShareCodecSelection.ts` and `CodecCapabilityDetector.ts` | Our screen share codec negotiation among participants (what the known participants can decode versus what we can encode). The knip exemptions keep those modules' exports from being reported as unused. | `pnpm exec knip` stays clean; if it starts reporting those files, an upstream merge moved a consumer. |
| Desktop update endpoints and app URLs | `fluxer_desktop/src/common/Constants.ts` (`STABLE_APP_URL`, `CANARY_APP_URL`, `DOWNLOAD_PAGE_URLS`), update feed host in `fluxer_desktop/src/main/ShellDownloadFormats.ts` | Stable and canary both load `https://echowire.org` (the SPA withholds credentials off-origin); `canary.echowire.org` serves the update feed. Upstream's second-domain migration origins are neutralised, not removed. | After a desktop merge, check `CHANNEL_APP_URLS` still point at echowire origins and that an update check hits the echowire feed. |
