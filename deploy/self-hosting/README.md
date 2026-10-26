# echowire self-hosting files

echowire deploys from the compose files in this folder, not from upstream's rexctl installer.
Images are built locally with `build-images-local.sh` and shipped to the app VM; see the
deployment notes for the staging gate and the rollback steps.

Upstream moved its own copy of these files into `fluxer_rexctl/internal/stack/files`. That
copy is kept exactly as upstream ships it and is not used by echowire. When merging upstream,
keep this folder, and port a new variable into `docker-compose.yml` and `.env.example` only when
the merged code requires it.
