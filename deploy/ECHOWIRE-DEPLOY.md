<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Echowire self-host deploy (fork images)

The stock self-host compose pulls upstream's `ghcr.io/fluxerapp/fluxer-*` images,
which do **not** contain Echowire branding or our Threads/Forum features (those
live in source). To run *our* build you must (1) build the Echowire images via CI
and (2) point the compose at our registry.

## 1. Build the images (CI)

Images are built by `.github/workflows/build-all-fork.yaml` on GitHub-hosted
`ubuntu-24.04` runners (amd64-only — all Echowire infra is x86) and pushed to
`ghcr.io/cproudlock/fluxer-*:{v1,latest}`.

```bash
# build everything from the feature branch
gh workflow run build-all-fork.yaml -R cproudlock/echowire --ref feat/threads -f image_tag=v1

# or one service (validation): -f only=fluxer-api
# watch:  gh run list -R cproudlock/echowire --workflow=build-all-fork.yaml
```

The 11 images built: api, admin, gateway, media-proxy, messages, snowflakes,
static, unfurl, users, marketing, app-proxy-self-hosted.

> The workflow file must exist on the repo **default branch** (`echowire`) to be
> dispatchable; the build itself runs against whatever `--ref` you pass.

## 2. Point the deploy at our images

In the node's `.env` (copied from `.env.example`):

```ini
FLUXER_REGISTRY_OWNER=cproudlock        # was fluxerapp
FLUXER_IMAGE_TAG=v1
FLUXER_EMAIL_FROM_NAME=echowire         # branding (was Fluxer)
```

`FLUXER_REGISTRY` derives from `FLUXER_REGISTRY_OWNER`, so that one line repoints
all 21 services.

## 3. ghcr pull auth

`ghcr.io/cproudlock/fluxer-*` packages inherit the **private** repo visibility, so
each pulling node (staging VM, NC, MI) needs a read token:

```bash
echo "$GHCR_READ_PAT" | docker login ghcr.io -u cproudlock --password-stdin
```

`GHCR_READ_PAT` = a GitHub PAT with `read:packages`. Alternatively, set the
packages to **public** in ghcr (Package settings → Change visibility) and skip
login entirely — acceptable since the images contain no secrets (all config is
injected via `.env` at runtime).

## Notes
- Voice (LiveKit ORD/EWR/ATL) and R2 storage are unchanged — point `FLUXER_LIVEKIT_*`
  and `FLUXER_S3_*` at the existing infra.
- Production cutover is gated on data migration (Scylla→Postgres ETL, transition
  Phase 3); do **not** point echowire.org at this stack until that lands — it would
  serve an empty database.
