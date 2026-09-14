# 0002. Spell the brand all lowercase, including artifacts

## Status

Accepted

Date: 2026-09-13

## Context

The fork rebranded upstream's Fluxer, but the spelling drifted between
`echowire` and `Echowire`. Earlier sessions treated lowercase defaults as bugs:
`ConfigLoader`'s `product_name` default and the `ProductConstants.ts` fallbacks
were "fixed" to `Echowire` on 2026-09-12. On 2026-09-13 the owner stated the
brand is all lowercase and, asked how far that goes, chose everything, including
desktop artifact and product names, and held that day's deploy so the rename
shipped with it (tag `2026-09-13b`).

## Decision

We write `echowire` in every user-visible string, default, title, email, catalog
value and artifact name, even at the start of a sentence. Desktop artifacts are
`echowire-*`. A capitalized `Echowire` in display text is a leak to lowercase.

These do not change: `Reverb` and `EchoTag` keep their casing; code identifiers,
env var names, `org.echowire.*` package and app ids, and the `// Echowire:`
divergence markers are not display text. The mobile signing certificate subject
(`CN=Echowire`) and the Firebase project cannot change without breaking updates.

## Consequences

- Every upstream merge can reintroduce `Fluxer` or `Echowire` through generated
  specs, catalogs and defaults, so post-merge greps and regeneration are routine.
- Desktop download and updater matching must accept both the old `Echowire-*`
  and new `echowire-*` artifact names, or existing installs stop finding updates.
- Some places read oddly (a sentence starting lowercase); that is accepted.

## Alternatives considered

- Capitalized `Echowire` in prose, lowercase in logos: rejected by the owner.
- Lowercase display text but leave artifact names alone: rejected by the owner,
  who chose to include artifacts.
