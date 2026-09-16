#!/bin/bash
# Build the whole self-host image set locally, mirroring build-all-fork.yaml.
#
# This exists because GitHub Actions is not available to this fork, so the
# workstation is the only builder. Ship the results with:
#   docker save <image> | gzip -1 | ssh root@<host> "gunzip | docker load"
# The gh CLI token can pull from ghcr but not push, so there is no registry hop.
#
# Usage: TAG=2026-09-13 ./deploy/self-hosting/build-images-local.sh [image ...]
set -uo pipefail

TAG=${TAG:?set TAG, e.g. TAG=2026-09-13}
OWNER=${OWNER:-cproudlock}
REPO_ROOT=$(git rev-parse --show-toplevel) || exit 1
cd "$REPO_ROOT" || exit 1

SHA=$(git rev-parse HEAD)
LOG=${LOG:-$HOME/imgbuild-$TAG.log}
FAILED=$HOME/imgbuild-$TAG-failed.txt
: > "$LOG"
: > "$FAILED"
echo "building set $TAG from ${SHA:0:8} in $REPO_ROOT" | tee -a "$LOG"

# image                        dockerfile                     extra build args
IMAGES=(
	"fluxer-api|fluxer_api/Dockerfile|"
	"fluxer-admin|fluxer_admin/Dockerfile|"
	"fluxer-gateway|fluxer_gateway/Dockerfile|"
	"fluxer-media-proxy|fluxer_media_proxy/Dockerfile|"
	"fluxer-messages|fluxer_messages/Dockerfile|"
	"fluxer-snowflakes|fluxer_snowflakes/Dockerfile|"
	"fluxer-gifs|fluxer_gifs/Dockerfile|"
	"fluxer-static|fluxer_static/Dockerfile|"
	"fluxer-unfurl|fluxer_unfurl/Dockerfile|"
	"fluxer-users|fluxer_users/Dockerfile|"
	"fluxer-marketing|fluxer_marketing/Dockerfile|"
	"fluxer-app-proxy-self-hosted|fluxer_app_proxy/Dockerfile|--build-arg FLUXER_APP_PROXY_TIME_FREEZE_ENABLED=false"
)

build() {
	local image=$1 dockerfile=$2 extra=${3:-}
	local start=$SECONDS
	printf "  %-34s " "$image"
	# shellcheck disable=SC2086
	if docker buildx build -f "$dockerfile" \
		--build-arg BUILD_VERSION="$SHA" $extra \
		--platform linux/amd64 --provenance=false \
		-t "ghcr.io/$OWNER/$image:$TAG" --load . >> "$LOG" 2>&1; then
		echo "ok  $(( SECONDS - start ))s"
	else
		echo "FAILED (see $LOG)"
		echo "$image" >> "$FAILED"
	fi
}

WANTED=("$@")
for entry in "${IMAGES[@]}"; do
	IFS="|" read -r image dockerfile extra <<< "$entry"
	if [ ${#WANTED[@]} -gt 0 ]; then
		case " ${WANTED[*]} " in *" $image "*) ;; *) continue ;; esac
	fi
	build "$image" "$dockerfile" "$extra"
done

echo "== built =="
docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}" | grep ":$TAG" | sed "s/^/  /"
echo "  failures: $(wc -l < "$FAILED")"
sed "s/^/    /" "$FAILED" 2>/dev/null
