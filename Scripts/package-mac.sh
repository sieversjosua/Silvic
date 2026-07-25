#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

pnpm --filter @silvic/desktop build
pnpm --filter @silvic/desktop exec electron-builder --mac dir

app="$root/release/mac-arm64/Silvic.app"
staging="$(mktemp -d /tmp/silvic-package.XXXXXX)"
trap 'rm -rf "$staging"' EXIT
mv "$app" "$staging/Silvic.app"
xattr -cr "$staging/Silvic.app"
if ! codesign --verify --deep --strict "$staging/Silvic.app" 2>/dev/null; then
  codesign --force --deep --sign - "$staging/Silvic.app"
fi
codesign --verify --deep --strict "$staging/Silvic.app"

archive="$root/release/Silvic-mac-arm64.zip"
rm -f "$archive"
COPYFILE_DISABLE=1 ditto -c -k --norsrc --keepParent \
  "$staging/Silvic.app" "$archive"
mkdir "$staging/verify"
ditto -x -k "$archive" "$staging/verify"
xattr -cr "$staging/verify/Silvic.app"
codesign --verify --deep --strict "$staging/verify/Silvic.app"
