// SPDX-License-Identifier: AGPL-3.0-or-later

// Compile-time constants injected by scripts/build.mjs via esbuild `define`.
// These are bare globals (not imports) replaced at bundle time; declare them so
// TypeScript typechecks the sources that reference them.

// Windows desktop build variant: 'default' | 'windows-game-capture'.
// Consumed by src/main/Updater.ts to scope the Velopack update feed path.
declare const DESKTOP_BUILD_VARIANT: string;
