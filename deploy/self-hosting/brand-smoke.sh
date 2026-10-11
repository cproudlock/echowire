#!/usr/bin/env bash
# Post-deploy check: the public surfaces of an instance must not name the upstream product.
# Run it after every web, app proxy or marketing deploy.
#
#   deploy/self-hosting/brand-smoke.sh [base-url] [expected-product-name]
#
# Defaults: https://echowire.org and echowire. Exits 1 and lists every surface that names Fluxer,
# Plutonium or Neko in a field a user reads (install name, page titles, instance branding).
# Prose such as the comparison article is not checked here: it names Fluxer on purpose.
set -u

BASE="${1:-https://echowire.org}"
EXPECTED="${2:-echowire}"
BASE="${BASE%/}"
UA="brand-smoke/1"
UPSTREAM='(^|[^A-Za-z])(Fluxer|Plutonium|Neko)([^A-Za-z]|$)'
failures=0

fail() {
	echo "FAIL  $1"
	failures=$((failures + 1))
}
pass() { echo "ok    $1"; }

fetch() { curl -fsS -A "$UA" --max-time 20 "$BASE$1"; }

check_value() { # label value
	if printf '%s' "$2" | grep -Eq "$UPSTREAM"; then
		fail "$1 names upstream: $(printf '%s' "$2" | cut -c1-90)"
	else
		pass "$1"
	fi
}

manifest="$(fetch /manifest.json)" || { fail "manifest.json could not be fetched"; manifest=""; }
if [ -n "$manifest" ]; then
	for field in name short_name description; do
		value="$(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$field" 2>/dev/null)"
		check_value "manifest.json $field" "$value"
	done
fi

for path in / /help /reverb; do
	html="$(fetch "$path")" || { fail "$path could not be fetched"; continue; }
	title="$(printf '%s' "$html" | tr '\n' ' ' | grep -o -i -E '<title>[^<]*</title>' | head -1)"
	check_value "$path <title>" "$title"
done

home="$(fetch /)" && {
	for meta in apple-mobile-web-app-title application-name og:site_name; do
		value="$(printf '%s' "$home" | tr '\n' ' ' | grep -o -i -E "<meta[^>]*(name|property)=\"$meta\"[^>]*>" | head -1)"
		[ -n "$value" ] && check_value "meta $meta" "$value"
	done
}

wk="$(fetch /.well-known/fluxer)" || { fail "/.well-known/fluxer could not be fetched"; wk=""; }
if [ -n "$wk" ]; then
	product="$(printf '%s' "$wk" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("app_public") or {}).get("branding", {}).get("product_name") or "")' 2>/dev/null)"
	if [ "$product" = "$EXPECTED" ]; then
		pass "instance branding product_name is $EXPECTED"
	else
		fail "instance branding product_name is '$product', expected '$EXPECTED'"
	fi
fi

if [ "$failures" -gt 0 ]; then
	echo "brand-smoke: $failures problem(s) on $BASE"
	exit 1
fi
echo "brand-smoke: clean on $BASE"
