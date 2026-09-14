# 0001. Build and ship images locally instead of through GitHub Actions

## Status

Accepted

Date: 2026-09-11

## Context

Until 2026-08-25 the fork's server images were built by `build-all-fork.yaml`
on a self-hosted runner and pulled from ghcr. That runner died with the
workstation wipe. Hosted runners then worked for a while, but on 2026-09-11
GitHub began refusing jobs because the account's payment had failed or its
spending limit was reached. The failure did not look like billing: one build
died 24 minutes in with no error, and a re-dispatch failed with no log at all,
which cost a wrong disk diagnosis. The owner decided the same day not to pay for
Actions. The `gh` CLI token can pull from ghcr but cannot push to it.

A local build was proven the same day: buildx installed by hand in `dev-personal`
(Docker 29 dropped the legacy builder), `docker buildx build --load` with the
matrix's build args, and `docker save | gzip | ssh docker load` to prod. The
2026-09-12, 2026-09-13b and 2026-09-14 deploys all shipped this way.

## Decision

We build every image in `dev-personal` with
`deploy/self-hosting/build-images-local.sh` and ship it to the prod box over SSH
with `docker save`. No registry is involved. The local gate described in
`AGENTS.md` replaces CI as the merge gate. We do not propose restoring Actions
billing, raising the spending limit, or waiting for CI.

## Consequences

- Nothing enforces the gate mechanically; it holds only if whoever merges runs
  it. The workflow files stay in the tree as the reference for exact commands.
- Locally built images exist only on the workstation and on prod. Rebuilding a
  lost tag means rebuilding from its commit.
- Builds compete with other work for the container's memory cap. A starved cgroup
  on 2026-09-13 turned builds into hours of disk thrash and dropped IPv4
  mid-build, failing five images.
- Shipping a one-service fix is cheap: build that image only and retag the rest.
- Upstream workflow changes still arrive with merges and must be kept in step
  with the local script's image list.

## Alternatives considered

- Pay for Actions: rejected by the owner.
- Re-register the unused self-hosted runner in `ci-echowire`: another
  runner to maintain, still depends on GitHub dispatching jobs, and its images
  would still have no registry to push to.
- Push to ghcr from the workstation: the available token lacks the scope.
