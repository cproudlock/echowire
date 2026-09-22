#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Assembles the exact contents of a flathub/org.echowire.app pull request into a directory, with
# the archive url and sha256 taken from the live release descriptor so the three version-bearing
# fields can never disagree.
#
# Usage: build-flathub-submission.sh [output-directory]
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
packaging_dir=$(CDPATH= cd -- "${script_dir}/.." && pwd)
desktop_dir=$(CDPATH= cd -- "${packaging_dir}/.." && pwd)
out=${1:-${script_dir}/out}

api_base=${ECHOWIRE_DOWNLOAD_API:-https://echowire.org/api/dl}
descriptor_url="${api_base}/desktop/stable/linux/x64/latest"

for tool in curl python3; do
	command -v "${tool}" >/dev/null 2>&1 || {
		echo "${tool} is required" >&2
		exit 1
	}
done

echo "Reading ${descriptor_url}"
descriptor=$(curl -fsSL "${descriptor_url}")

read_field() {
	printf '%s' "${descriptor}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
path = sys.argv[1].split(".")
value = data
for key in path:
    value = value[key]
if not isinstance(value, str) or not value:
    raise SystemExit(f"{sys.argv[1]} is missing from the release descriptor")
print(value)
' "$1"
}

version=$(read_field version)
archive_url=$(read_field files.tar_gz.url)
archive_sha256=$(read_field files.tar_gz.sha256)

case ${archive_sha256} in
*[!0-9a-f]* | "") echo "The descriptor gave a malformed sha256: ${archive_sha256}" >&2; exit 1 ;;
esac
[ ${#archive_sha256} -eq 64 ] || {
	echo "The descriptor gave a ${#archive_sha256} character sha256" >&2
	exit 1
}

echo "stable is at ${version}"

rm -rf "${out}"
mkdir -p "${out}/icons"

python3 - "${script_dir}/org.echowire.app.yml" "${out}/org.echowire.app.yml" \
	"${archive_url}" "${archive_sha256}" <<'PYTHON'
import re
import sys

source, target, url, sha256 = sys.argv[1:5]
manifest = open(source, encoding="utf-8").read()
manifest, url_count = re.subn(
    r"^(        url: )https://\S+/tar_gz$", rf"\g<1>{url}", manifest, flags=re.MULTILINE
)
manifest, sha_count = re.subn(
    r"^(        sha256: )[0-9a-f]{64}$", rf"\g<1>{sha256}", manifest, flags=re.MULTILINE
)
if url_count != 1 or sha_count != 1:
    raise SystemExit(
        f"Expected one archive url and one sha256 in the manifest, replaced {url_count} and {sha_count}"
    )
open(target, "w", encoding="utf-8").write(manifest)
PYTHON

cp "${script_dir}/org.echowire.app.sh" "${out}/"
cp "${script_dir}/flathub.json" "${out}/"
cp "${packaging_dir}/linux/org.echowire.app.desktop" "${out}/"
cp "${packaging_dir}/linux/org.echowire.app.metainfo.xml" "${out}/"
cp "${packaging_dir}/linux/org.echowire.app.svg" "${out}/"

for size in 16 24 32 48 64 128 256 512; do
	cp "${desktop_dir}/build_resources/icons-stable/${size}x${size}.png" \
		"${out}/icons/${size}x${size}.png"
done

if command -v appstreamcli >/dev/null 2>&1; then
	echo "Validating the metainfo"
	appstreamcli validate --explain "${out}/org.echowire.app.metainfo.xml"
else
	echo "appstreamcli is absent, so the metainfo was not validated here. Flathub runs" >&2
	echo "  appstreamcli validate org.echowire.app.metainfo.xml" >&2
	echo "in review; install appstream to run it locally." >&2
fi

cat <<EOF

Staged ${version} in ${out}

The metainfo <releases> entry must name ${version}, or Flathub's build will publish a
version its own metadata does not mention. Check it before opening the pull request:
  grep 'release version' ${out}/org.echowire.app.metainfo.xml
EOF
