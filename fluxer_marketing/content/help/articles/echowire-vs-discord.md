When a platform sells advertising and answers to investors, your attention and your data are part of what it sells. echowire and Fluxer have no ad system. You can read the code, and you can run your own copy. The table below is the short version. The sections after it set out [what is documented about Discord](#what-is-documented-about-discord) today, with a source for each item.

## At a glance

| | Discord | Fluxer | echowire |
| --- | --- | --- | --- |
| Advertising | <span class="cmp-no">YES</span> Sponsored Quests, a FanDuel test | <span class="cmp-ok">NONE</span> | <span class="cmp-ok">NONE</span> |
| Paid for by | <span class="cmp-no">ADS + SUBS</span> | <span class="cmp-ok">SUBS</span> Optional paid tier | <span class="cmp-ok">NOBODY YET</span> Paid features planned |
| Face scan or ID check | <span class="cmp-no">PLANNED</span> Due in the second half of 2026 | <span class="cmp-mid">VARIES</span> Follows the laws it is subject to | <span class="cmp-ok">NONE</span> |
| Source code | <span class="cmp-no">CLOSED</span> | <span class="cmp-ok">OPEN</span> AGPL-3.0 | <span class="cmp-ok">OPEN</span> AGPL-3.0 |
| Run your own copy | <span class="cmp-no">NO</span> | <span class="cmp-ok">YES</span> [Setup guide](https://docs.fluxer.app/operator/get-started/) | <span class="cmp-ok">YES</span> Deploy scripts in the repository |
| Where your data lives | <span class="cmp-no">DISCORD</span> And its vendors | <span class="cmp-mid">OPERATOR</span> | <span class="cmp-mid">US OR YOU</span> echowire.org, or your own server |
| Outside services | <span class="cmp-no">MANY</span> Identity vendors, ad partners | <span class="cmp-mid">SOME</span> See the operator's policy | <span class="cmp-mid">4</span> See below |

Each badge carries a word as well as a color: green is good for your privacy, amber is mixed, red is bad.

- **Fluxer, self-hosted:** you pay for your own server, you decide who joins and whether to check ages, and your data stays on a machine you control. The same is true of echowire if you host it yourself.
- **echowire's four outside services:** Cloudflare Turnstile (sign-up captcha), SMTP2GO (email), Klipy (GIF search) and Cloudflare R2 (downloads). Stripe is set up but not taking live payments.
- **Where Discord wins:** features and ecosystem. See "What you give up" below.

## What you give up

Why people stay on Discord:

- Almost everyone you know is already there.
- Bots, integrations and game tools are far more mature. Discord has the most features of the three; echowire has Fluxer's core set (servers, channels, DMs, voice, video and threads) plus forum boards.
- There is nothing to host, update or secure yourself.

What to expect from echowire and Fluxer:

- A smaller community, so you may be bringing your friends with you.
- Joining echowire.org is by approval for now: accounts are approved by hand. Discord lets anyone sign up.
- Young software. Expect rough edges and fast change.
- Self-hosting means you own the uptime, backups and security.

## Pick your path

- Use echowire: request an account at [echowire.org](https://echowire.org). Accounts are approved by hand.
- Use Fluxer: the upstream project, run by its own team. Try the service at [fluxer.app](https://fluxer.app) or read the [Fluxer docs](https://docs.fluxer.app).
- Host your own: run Fluxer or echowire on your own server and keep every message on a machine you control. Fluxer's [self-hosting guide](https://docs.fluxer.app/operator/get-started/) takes you from a fresh server to a working instance with Docker Compose. Source code: [Fluxer](https://github.com/fluxerapp/fluxer) and [echowire](https://github.com/cproudlock/echowire).

## What is documented about Discord

Each item links to its source. Where a figure comes from a third party, the article says so.

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

## When Discord users' data leaked

Discord says none of these were a breach of its own servers, and two of the three involved other companies. The common thread is that user data, including government ID photos, sat with outside services that had to collect and store it.

### 4 October 2026: Double Counter, a Discord security bot (the most recent)

An attacker got into the bot's cloud systems through an analytics tool left exposed on an old server and copied about 12 GB. Reported exposure: Discord IDs and usernames for about 28 million accounts, IP addresses with coarse location, and about 1 million email addresses. Have I Been Pwned lists roughly 275,000 unique emails from the data that was published. Passwords and card numbers were not part of it. Discord said the incident "was not a breach of Discord" and disabled new installs of the app. The larger figures are the attacker's claims, and they overlap, so they do not mean 28 million people lost every kind of data. Sources: [Cybersecurity News](https://cybersecuritynews.com/discord-users-data-exposed/) and [Yahoo Tech](https://tech.yahoo.com/cybersecurity/articles/hackers-stole-millions-discord-ids-185629432.html).

### Late September to October 2025: a support vendor leaked ID photos

Attackers were inside a customer-support vendor's ticketing system for about 58 hours. Discord said about 70,000 users may have had government ID photos exposed, along with names, emails, IP addresses and support messages. The attackers claimed to hold far more. Discord says it no longer works with that vendor. Sources: [TechCrunch](https://techcrunch.com/2025/10/09/discord-suffers-data-breach-impacting-at-least-70000-users), [Computing](https://www.computing.co.uk/news/2025/security/discord-privacy-breach-fears-personal-ids) and [CM Alliance](https://www.cm-alliance.com/cyber-insights-on-the-discord-data-breach).

### August 2023: Discord.io, an unofficial invite service

Over 760,000 users of a service that was not run by Discord had their usernames, Discord IDs and emails exposed, plus billing addresses and hashed passwords for older sign-ups. Discord stated: "Discord is not affiliated with Discord.io. We do not share any user information with Discord.io directly." It is here because it shows how much user data ends up outside Discord, not because Discord was breached. Source: [CSHub](https://www.cshub.com/attacks/news/discordio-exposes-personal-data-of-more-than-760000-users).

### What this does and does not show

- It shows that the more a platform collects (IDs, selfies, support tickets, bot databases), the more there is to lose. Age verification asks for exactly the most sensitive kind of data.
- It does not show that any self-hosted or smaller service is immune. echowire can be breached too. What it collects is limited, it asks for no ID or face scans, and the comparison below lists the few outside services it uses.

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
11. [Cybersecurity News: Double Counter breach exposes Discord users' data (October 2026)](https://cybersecuritynews.com/discord-users-data-exposed/)
12. [Yahoo Tech: hackers stole millions of Discord IDs and emails in a multi-stage attack](https://tech.yahoo.com/cybersecurity/articles/hackers-stole-millions-discord-ids-185629432.html)
13. [CSHub: Discord.io exposes personal data of more than 760,000 users (August 2023)](https://www.cshub.com/attacks/news/discordio-exposes-personal-data-of-more-than-760000-users)
14. [CM Alliance: cyber insights on the Discord data breach (vendor breach, 2025)](https://www.cm-alliance.com/cyber-insights-on-the-discord-data-breach)
15. [Fluxer documentation: get started with self-hosting](https://docs.fluxer.app/operator/get-started/)

Figures and dates were checked on 2026-10-11 and may change. echowire is not affiliated with Discord.
