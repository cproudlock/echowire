#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
export FLUXER_FLATPAK_COMMAND="${FLATPAK_ID}"

exec zypak-wrapper "/app/echowire/echowire" "$@"
