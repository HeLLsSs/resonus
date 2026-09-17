#!/bin/sh
# Exports the app for the browser and puts it where the proxy serves it: the
# same app as on the phone, at https://<proxy>/app, signed in with your own
# account. Run before `deploy.sh` in the navifind repository, which copies
# `public/app` into the image.
#
#   scripts/build-web.sh            # into ../navifind/public/app
#   scripts/build-web.sh some/dir   # elsewhere
set -e
cd "$(dirname "$0")/.."
OUT="${1:-../navifind/public/app}"
rm -rf "$OUT"
CI=1 corepack pnpm@11 exec expo export --platform web --output-dir "$OUT"
echo "Web app exported to $OUT"
