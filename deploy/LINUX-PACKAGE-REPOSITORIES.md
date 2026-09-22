<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# echowire apt and rpm repositories

echowire publishes its own signed Debian and RPM repositories so that `apt-get
install echowire` and `dnf install echowire` keep working after the first
install, instead of the user re-downloading a package by hand for every release.

Nothing here talks to upstream. The packages are the same `.deb` and `.rpm`
artifacts the desktop release already publishes; this tooling only indexes and
signs them.

## Where the repositories live

They live in the **downloads bucket** (Cloudflare R2), under two prefixes:

```
apt/echowire.asc                                   public signing key
apt/echowire.sources                               ready-made sources.list.d entry
apt/pool/<suite>/main/<initial>/<pkg>/<pkg>_<version>_amd64.deb
apt/dists/<suite>/Release                          index, signed
apt/dists/<suite>/Release.gpg                      detached signature
apt/dists/<suite>/InRelease                        inline-signed index
apt/dists/<suite>/main/binary-amd64/Packages{,.gz}
rpm/echowire.asc                                   public signing key
rpm/echowire.repo                                  ready-made .repo file
rpm/<suite>/x86_64/*.rpm                           signed packages
rpm/<suite>/x86_64/repodata/repomd.xml{,.asc}      index, signed
```

`<suite>` is a release channel: `stable` and `canary`.

**No new edge route is needed.** `fluxer_api` streams objects out of that bucket
for every path under `/dl`, and the edge Caddyfile already forwards `/api/*` to
the api with the prefix stripped, so these objects are public at
`https://echowire.org/api/dl/apt/...` and `https://echowire.org/api/dl/rpm/...`
as soon as they are uploaded. The api gates `/dl` against an allow-list of
bucket prefixes (`DOWNLOAD_KEY_ALLOWED_PREFIXES` in
`fluxer_api/src/api/download/DownloadService.ts`); `apt/` and `rpm/` are on it,
and it still rejects everything else and any path containing `..`.

Cache-Control is chosen per key by `downloadCacheControlForKey`: 60 seconds for
an index, a year for a `.deb` or `.rpm`, because a package filename contains its
version and never changes content, while serving a stale index makes apt refuse
to install a package whose hash it has not seen.

### Optional: shorter URLs

`https://echowire.org/api/dl/apt` works and needs no deploy change. If you would
rather publish `https://echowire.org/apt`, add this to the edge Caddyfile
(`deploy/self-hosting/Caddyfile`) alongside the existing `handle_path` blocks and
redeploy the proxy. The paths do not overlap `/api/*`, so placement among them
does not matter:

```caddyfile
handle_path /apt/* {
	rewrite * /dl/apt{uri}
	reverse_proxy api:8080
}
handle_path /rpm/* {
	rewrite * /dl/rpm{uri}
	reverse_proxy api:8080
}
```

Then pass `--public-base-url https://echowire.org` to `linux-repo build` so the
generated `.sources` and `.repo` files use the short form. Do not change the
base url after clients are installed without leaving the old path working: apt
treats a moved repository as a new one.

## The signing key

**This repository contains no key material and the tooling never creates a
key.** You generate it once, keep it offline, and hand it to the publisher
through the environment.

Create it on a machine you control:

```bash
gpg --quick-generate-key 'echowire package signing <packages@echowire.org>' rsa4096 sign never
gpg --armor --export-secret-keys packages@echowire.org > echowire-repo-signing.key
gpg --armor --export packages@echowire.org > echowire.asc
```

- `sign` is the only capability needed, and `never` means no expiry. An expiring
  key is worse than it sounds here: once it expires, every installed client
  starts failing `apt-get update` until it is given a new key by hand.
- **Back up `echowire-repo-signing.key` offline**, encrypted, somewhere other
  than the publishing host. Every client pins the matching public key. Losing
  the secret key means visiting every installation to repoint it.
- Never commit either file. `echowire-repo-signing.key` is a secret;
  `echowire.asc` is published by the tooling itself from the imported key, so
  there is no reason to check it in either.
- A passphrase is recommended for the offline copy. The publishing host needs
  the passphrase too, so store it alongside the key in the same secret manager.

Give the publisher these variables:

| Variable | Required | Meaning |
| --- | --- | --- |
| `ECHOWIRE_REPO_SIGNING_KEY_FILE` | one of the two | Path to the armored secret key file |
| `ECHOWIRE_REPO_SIGNING_KEY` | one of the two | The armored secret key itself |
| `ECHOWIRE_REPO_SIGNING_PASSPHRASE` | if the key has one | Passphrase for the secret key |
| `ECHOWIRE_REPO_SIGNING_KEY_ID` | only if ambiguous | Fingerprint to sign with, when the key file holds more than one secret key |

The key is imported into a temporary `GNUPGHOME` that is deleted when the
command exits, so it never lands in the publisher's own keyring.

With neither of the first two set, `linux-repo build` stops before touching
anything and prints the generation commands above. There is no way to publish an
unsigned repository: `--unsigned` exists only to check the layout on a host
without a key, and `linux-repo publish` refuses any tree that has no `InRelease`
or `repomd.xml.asc`.

## Host requirements

The apt half needs `apt-utils` (for `apt-ftparchive`), `dpkg`, `gzip` and
`gnupg`, all of which a Debian or Ubuntu build host already has.

The rpm half needs two more, which are packaged for Debian and Ubuntu:

```bash
sudo apt-get install createrepo-c rpm
```

Each tool is probed before use, and a missing one produces a message naming the
package to install rather than a broken repository. Use `--skip-rpm` to build
only the apt side on a host without them.

## Publishing a release

```bash
# 1. Build both trees from the packages the download api is currently serving.
export ECHOWIRE_REPO_SIGNING_KEY_FILE=/run/secrets/echowire-repo-signing.key
export ECHOWIRE_REPO_SIGNING_PASSPHRASE=...
cargo run -p fluxer-ci -- linux-repo build --out linux-repo

# 2. Check what would be uploaded.
export S3_ENDPOINT=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
export S3_DOWNLOADS_BUCKET=<downloads bucket>
cargo run -p fluxer-ci -- linux-repo publish --root linux-repo --dry-run

# 3. Upload.
cargo run -p fluxer-ci -- linux-repo publish --root linux-repo
```

`build` fetches each channel's latest `.deb` and `.rpm` from
`https://echowire.org/api/dl/desktop/<channel>/linux/x64/latest` and verifies
each download against the sha256 in that descriptor, so the repository can be
rebuilt from scratch at any time without access to the build outputs. Pass
`--deb`/`--rpm` with a single `--channels` value to index local build outputs
instead, and `--channels stable` to leave canary alone.

`publish` uploads packages before indexes. An index naming a package the bucket
does not hold yet breaks every client; a package nothing references yet is
inert. Packages are uploaded append-only, so re-publishing does not re-send the
130 MB of unchanged `.deb`.

Only x86_64 is published, because that is the only desktop architecture the
release builds.

## What users run

Debian and Ubuntu:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://echowire.org/api/dl/apt/echowire.asc \
  -o /etc/apt/keyrings/echowire.asc
sudo curl -fsSL https://echowire.org/api/dl/apt/echowire.sources \
  -o /etc/apt/sources.list.d/echowire.sources
sudo apt-get update
sudo apt-get install echowire
```

The served `.sources` file is deb822 and already carries
`Signed-By: /etc/apt/keyrings/echowire.asc`, so the repository is trusted only
for our key and nothing else on the system is affected. It also ships a
`canary` entry with `Enabled: no`; flip it to `yes` to follow the canary
channel.

Fedora, RHEL and openSUSE:

```bash
sudo rpm --import https://echowire.org/api/dl/rpm/echowire.asc
sudo curl -fsSL https://echowire.org/api/dl/rpm/echowire.repo \
  -o /etc/yum.repos.d/echowire.repo
sudo dnf install echowire
```

The `.repo` file sets both `gpgcheck=1` (the package signature) and
`repo_gpgcheck=1` (the index signature), and defines a disabled
`echowire-canary` section.

## Turning on the download page section

The `/download` page carries the two snippets above, but it is **off by default**
and shows nothing until the repositories exist. Instructions for a repository
that does not answer are worse than no instructions.

After the first successful `linux-repo publish`, and after checking that

```bash
curl -fsSL https://echowire.org/api/dl/apt/dists/stable/InRelease | head -3
curl -fsSL https://echowire.org/api/dl/rpm/stable/x86_64/repodata/repomd.xml | head -3
```

both return content, set this in the node's `.env` and restart the marketing
service:

```ini
FLUXER_MARKETING_LINUX_REPO_ENABLED=true
```

The page builds the urls from the marketing service's own `FLUXER_API_ENDPOINT`,
so a self-hosted instance shows its own domain rather than ours.

The page deliberately says nothing about flatpak. It stays that way until a
Flathub submission is accepted; see
`fluxer_desktop/packaging/flathub/README.md`.

## Rotating the key

There is no graceful rotation. A client that has pinned the old key cannot
verify an index signed by a new one, so it must be given the new public key
before the switch. The workable order is:

1. Publish the new public key at a second path and announce it.
2. Sign the indexes with **both** keys for a full release cycle
   (`gpg --clearsign` accepts repeated `--local-user`; this tooling signs with
   one key and would need a change to do it).
3. Only then drop the old key.

Which is the practical argument for generating the key once, without an expiry,
and backing it up properly.
