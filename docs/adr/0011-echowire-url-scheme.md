# 0011. Own an echowire:// scheme and keep accepting fluxer://

## Status

Proposed

Date: 2026-10-08

## Context

Every client registers and parses the `fluxer://` URL scheme: the desktop app (Electron
protocol client, Linux and Arch desktop entries, electron-builder), the web client (link
rendering, deep link routing, the markdown parsers and the Rust markdown parser) and the
mobile apps (Android intent filters, the iOS URL types and the Dart deep link policy). We
inherited the scheme from upstream. It is not ours, and only one application on a machine
can own a given scheme, so on a computer that also runs the official Fluxer app the
operating system picks one of the two for every `fluxer://` link.

We want our own scheme, `echowire://`. We also want `fluxer://` to keep working, because
someone may use this app with another instance (federation), and links written for that
instance or for the upstream app use `fluxer://`.

Facts that shaped the design:

- A link carries no instance. `fluxer://invite/abc` means "invite abc on whichever
  instance this app is connected to", so both schemes mean exactly the same thing and
  accepting both needs no routing change.
- Installed clients cannot be updated at once. A link we write with a scheme an installed
  client does not register opens nothing. Reading is safe to widen immediately; writing is
  not.
- The mobile SSO callback is `fluxer://auth/sso/callback`
  (`packages/constants/src/SsoConstants.ts`), and shipped mobile builds send it. The server
  matches it exactly.
- Upstream is reworking the desktop app (#3254, instance accounts and a bundled renderer)
  and has not adopted a second scheme, so these edits sit in files that will conflict on
  that merge. They are marked `Echowire:`.

## Decision

We will register and accept both schemes everywhere, in two phases.

Phase 1, accept and register (this change for desktop and web; the mobile change follows):

- A shared list, `packages/constants/src/AppProtocolConstants.ts`, is the single source
  for the web client and the markdown parsers. The Rust markdown parser and the Electron
  main process keep their own copy of the list with a comment pointing at the shared one.
- Desktop registers both schemes with the OS (`setAsDefaultProtocolClient` for each, both
  `x-scheme-handler` entries in the Linux, Arch and electron-builder entries, both schemes
  in the electron-builder protocol list), accepts both in the deep link handler, and
  allows both in the external URL allow-list.
- The web client reads either scheme (deep link routing, link rendering, the dev link,
  autolinking, typed-emoji and emoticon boundaries) and the Rust markdown parser links both.
- Mobile adds `echowire` beside `fluxer` in the Android intent filters, the iOS URL types
  and the Dart deep link policy.
- Links we WRITE do not change: `buildAppProtocolUrl` and the settings links still produce
  `fluxer://`, and the SSO callback stays `fluxer://auth/sso/callback`.

Phase 2, write the new scheme (later, a separate change):

- Switch `APP_PROTOCOL` in `fluxer_app/src/features/ui/utils/AppProtocol.ts` to
  `echowire` once desktop and mobile builds that register it are what most people have.
  The adoption check is the Play Console and TestFlight version split plus the desktop
  update feed.
- Add `echowire://auth/sso/callback` to the server's accepted callbacks alongside the
  `fluxer://` one, and only then have a mobile build send it.
- `fluxer://` is never removed.

## Consequences

Easy: no link in the wild breaks, a link from another instance still opens here, and the
operating system now has an unambiguous handler for `echowire://`.

Hard or unhappy:

- Both apps on one machine still contend for `fluxer://`. This change does not fix that and
  cannot, since we keep the scheme on purpose. Only `echowire://` is ours alone.
- Until phase 2, nothing we write uses the new scheme, so it is only useful to people who
  type or paste it. That is the price of not breaking older installs.
- Phase 1 needs a desktop release and a mobile release before phase 2 means anything.
  Windows and macOS register the scheme at install or first run, so users who never update
  never get it.
- Markdown now autolinks `echowire:` in messages as well as `fluxer:`. A message that
  merely contains the word "echowire:" followed by a letter or slash is treated as a link,
  the same rule `fluxer:` already had.
- The shared list, the desktop copy and the Rust copy can drift. Tests pin each to the same
  two names, and the comments name the others.

## Alternatives considered

- Replace `fluxer://` with `echowire://`: breaks every existing link and the federation
  case, and strands installed clients.
- Add `echowire://` only to new builds and write it immediately: links would open nothing
  on the installs we have today.
- Instance-bearing links (`echowire://instance.example/invite/abc`) so a link names its
  instance: the right long-term shape for federation, but it needs instance-aware routing
  and account switching, which is what upstream's #3254 builds. Out of scope here; this ADR
  does not stop it.
- Leave the scheme alone: keeps the collision with the official app and gives us no scheme
  of our own.
