When a platform sells advertising and answers to investors, your attention and your data are part of what it sells. echowire and Fluxer have no ad system. You can read the code, and you can run your own copy. This article sets out what is documented about Discord today and how the alternatives compare.

## What is documented about Discord

Each item links to its source. Where a figure comes from a third party, the article says so.

### October 2025: a support vendor leaked ID photos

Hackers breached a third-party vendor that handled age-related appeals. Discord said about 70,000 users may have had government ID photos exposed. The attackers claimed to hold far more. Discord says it no longer works with that vendor. Sources: [TechCrunch](https://techcrunch.com/2025/10/09/discord-suffers-data-breach-impacting-at-least-70000-users) and [Computing](https://www.computing.co.uk/news/2025/security/discord-privacy-breach-fears-personal-ids).

### February 2026: every account defaults to "teen"

Discord announced that all accounts would start in a restricted teen experience unless the user proves they are an adult with a face scan or a government ID. It also described an age inference model that can classify some users as adults using signals such as account tenure, device information and activity data. Sources: [Help Net Security](https://www.helpnetsecurity.com/2026/02/10/discord-age-verification-settings/) and [Redact](https://redact.dev/blog/discord-teen-by-default-global-age-verification-2026).

### 24 February 2026: rollout delayed after backlash

Discord's CTO said the company had "failed at our most basic job: clearly explaining what we're doing and why." Users had objected to a verification vendor backed by an investment firm co-founded by Peter Thiel. Discord now says it will use only vendors that verify on the user's device. The global rollout moved to the second half of 2026. Sources: [TechCrunch](https://techcrunch.com/2026/02/24/discord-delays-global-rollout-of-age-verification-after-backlash/) and [GameSpace](https://gamespace.com/all-articles/news/discord-delays-global-age-verification-rollout-after-privacy-backlash/).

### 2024 to 2026: advertising is growing

Sponsored Quests, introduced in 2024, were Discord's first step into advertising. Third-party estimates put ads at roughly 6 to 8 percent of revenue and the fastest-growing stream. Discord has also been reported to have confidentially filed for an IPO in January 2026. These figures are estimates and reports, not numbers Discord has confirmed. Sources: [Revenue Memo](https://www.revenuememo.com/p/how-does-discord-make-money) and [Everything PR](https://everything-pr.com/discord-the-community-layer-of-the-creator-economy).

### 2026: a FanDuel ad test

Discord confirmed a limited U.S. test of FanDuel daily fantasy sports ads shown to some adults. Its ads policy bans real-money gambling ads such as casinos and sportsbooks, with an exception for daily fantasy sports in some jurisdictions. Sources: [All About Cookies](https://allaboutcookies.org/discord-age-verification-sport-gambling-ads) and [Discord's Ads Policy](https://support.discord.com/hc/en-us/articles/25516720403223-Ads-Policy).

## What we can and cannot say

Honesty is the point of this article, so here is where the evidence stops.

- We cannot show that Discord brought back age verification in order to sell gambling ads. Discord says age signals "are used to ensure users in the teenage age group don't see ads meant for adults, and are not used to target ads." One analyst wrote that there is no evidence of that motive, but "extremely convenient timing."
- What is documented is a company that is moving toward more advertising and a public listing, while asking users for face scans or IDs, after a breach of ID photos held by its own vendor.
- The question to ask of any free platform is how it earns money from you. For Discord, the answer includes advertisers.

## The comparison

| | Discord | Fluxer (hosted) | Fluxer (self-hosted) | echowire |
| --- | --- | --- | --- | --- |
| Who pays | Nitro subscriptions and a growing ad business | Open-source project from Sweden, with an optional paid tier | You pay for your own server | No ad system. Optional paid features are planned; real payments are not live yet |
| Advertising | Yes: Sponsored Quests and a FanDuel test | None | None | None |
| Age checks (face scan or ID) | Planned for everyone, now due in the second half of 2026 | Follows the laws it is subject to | The server owner decides | None. No face scans and no ID uploads |
| Source code | Closed | Open, AGPL-3.0 | Open, AGPL-3.0 | Open, AGPL-3.0, published on GitHub |
| Run your own | No | Not applicable, this is the hosted service | Yes, Docker-based setup | Yes, same codebase with deploy scripts in the repository |
| Where your data lives | On Discord's systems and its vendors' systems | On the operator's servers | On a machine you control | On echowire.org's server, or your own if you self-host |
| Outside services | Many, including identity vendors and ad partners | Some: check the operator's privacy policy | Your choice | A few: Cloudflare Turnstile (sign-up captcha), SMTP2GO (email), Klipy (GIF search), Cloudflare R2 (downloads). Stripe is set up but not taking live payments |
| Chat features | Most: servers, voice, video, bots and a huge ecosystem | Core: servers, channels, DMs, voice and video, threads | Same as hosted | Fluxer's features, plus forum boards and a few extras |
| Joining | Anyone can sign up | Open | You decide who joins | Accounts on echowire.org are approved by hand for now |

## What you give up

Why people stay on Discord:

- Almost everyone you know is already there.
- Bots, integrations and game tools are far more mature.
- There is nothing to host, update or secure yourself.

What to expect from echowire and Fluxer:

- A smaller community, so you may be bringing your friends with you.
- Young software. Expect rough edges and fast change.
- Self-hosting means you own the uptime, backups and security.

## Pick your path

- Use echowire: request an account at [echowire.org](https://echowire.org). Accounts are approved by hand.
- Use Fluxer: the upstream project, run by its own team, at [fluxer.app](https://fluxer.app).
- Host your own: run [Fluxer](https://github.com/fluxerapp/fluxer) or [echowire](https://github.com/cproudlock/echowire) on your own server and keep every message on a machine you control.

## Sources

1. [TechCrunch, 9 Oct 2025: Discord data breach, at least 70,000 users](https://techcrunch.com/2025/10/09/discord-suffers-data-breach-impacting-at-least-70000-users)
2. [Computing, 2025: proof-of-age IDs leak through a third-party provider](https://www.computing.co.uk/news/2025/security/discord-privacy-breach-fears-personal-ids)
3. [Help Net Security, 10 Feb 2026: face scans and ID checks are coming to Discord](https://www.helpnetsecurity.com/2026/02/10/discord-age-verification-settings/)
4. [Redact: Discord's global age verification rollout and your privacy](https://redact.dev/blog/discord-teen-by-default-global-age-verification-2026)
5. [TechCrunch, 24 Feb 2026: Discord delays global rollout of age verification after backlash](https://techcrunch.com/2026/02/24/discord-delays-global-rollout-of-age-verification-after-backlash/)
6. [GameSpace: rollout postponed to the second half of 2026](https://gamespace.com/all-articles/news/discord-delays-global-age-verification-rollout-after-privacy-backlash/)
7. [Revenue Memo: how Discord makes money (third-party estimates)](https://www.revenuememo.com/p/how-does-discord-make-money)
8. [Everything PR: Discord IPO status and revenue model (reported, not confirmed by Discord)](https://everything-pr.com/discord-the-community-layer-of-the-creator-economy)
9. [All About Cookies: did Discord bring back age verification to sell sports gambling ads?](https://allaboutcookies.org/discord-age-verification-sport-gambling-ads)
10. [Discord Ads Policy](https://support.discord.com/hc/en-us/articles/25516720403223-Ads-Policy)

Figures and dates were checked on 2026-10-11 and may change. echowire is not affiliated with Discord.
