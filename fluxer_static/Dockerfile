# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM caddy:2.11-alpine

ARG BUILD_VERSION=""
ARG SOURCE_SHA=""
ARG SOURCE_DATE=""

LABEL org.opencontainers.image.title="fluxer-static"
LABEL org.opencontainers.image.description="Self-hostable static asset bundle for Fluxer"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later AND CC-BY-SA-4.0 AND CC-BY-4.0"
LABEL org.opencontainers.image.vendor="Fluxer"
LABEL org.opencontainers.image.url="https://fluxer.app"
LABEL org.opencontainers.image.documentation="https://docs.fluxer.app"
LABEL org.opencontainers.image.source="https://github.com/fluxerapp/fluxer"
LABEL org.opencontainers.image.version="${BUILD_VERSION}"
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
LABEL org.opencontainers.image.created="${SOURCE_DATE}"
LABEL app.fluxer.build-version="${BUILD_VERSION}"

COPY fluxer_static/Caddyfile /etc/caddy/Caddyfile
COPY --chown=65532:65532 fluxer_static/LICENSE fluxer_static/THIRD_PARTY_LICENSES.md /srv/fluxer-static/
COPY --chown=65532:65532 fluxer_static/avatars /srv/fluxer-static/avatars
COPY --chown=65532:65532 fluxer_static/badges /srv/fluxer-static/badges
COPY --chown=65532:65532 fluxer_static/desktop /srv/fluxer-static/desktop
# Echowire: upstream #3173 dropped this COPY when it moved the embed icons out; we keep serving
# fluxer_static/embeds (hn.webp), and the Caddyfile still routes /embeds/*.
COPY --chown=65532:65532 fluxer_static/embeds /srv/fluxer-static/embeds
COPY --chown=65532:65532 fluxer_static/emoji /srv/fluxer-static/emoji
# Echowire: upstream #3087 moved the DeepFilterNet3 wasm and model into the app bundle and
# deleted these files. Keep serving them anyway. The desktop client ships its own renderer
# bundle, so an installed desktop build keeps requesting /libs/deepfilternet3/v{2,3}/... by
# absolute path from the static host for as long as that build is in the field, and desktop
# stable is 2026.825.12857 from 25 August 2026, built before #3087. Deleting these files
# would break DeepFilter noise suppression for every one of those users with no error that
# anyone reports, and unlike a browser a desktop install does not self-heal on reload.
#
# Retire this when, and only when, desktop stable ships a build whose renderer bundles the
# wasm itself, and the oldest desktop build still in support is that one or newer. Then drop
# this COPY, the fluxer_static/libs tree, its THIRD_PARTY_LICENSES row, and the guard in
# fluxer_app/src/features/voice/utils/StaticAssetContract.test.ts together. The duplication
# with the in-bundle copy is deliberate and temporary, not an oversight.
COPY --chown=65532:65532 fluxer_static/libs /srv/fluxer-static/libs
# Echowire: the marketing pages and the flatpak metainfo both link screenshots under
# /marketing, and nothing served them, so every one of those images was a 404.
COPY --chown=65532:65532 fluxer_static/marketing /srv/fluxer-static/marketing
COPY --chown=65532:65532 fluxer_static/web /srv/fluxer-static/web

RUN setcap -r /usr/bin/caddy \
	&& mkdir -p /config/caddy /data/caddy \
	&& chown -R 65532:65532 /config /data /srv/fluxer-static

USER 65532:65532

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD wget -q -O - http://127.0.0.1:8080/_health | grep -q OK
