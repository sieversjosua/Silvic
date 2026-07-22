#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${ROOT}/outputs/WorktreePilot.app"
BIN_PATH="$(cd "${ROOT}" && swift build -c release --show-bin-path)"

rm -rf "${OUTPUT}"
mkdir -p "${OUTPUT}/Contents/MacOS" "${OUTPUT}/Contents/Resources"
cp "${BIN_PATH}/WorktreePilot" "${OUTPUT}/Contents/MacOS/WorktreePilot"
cp "${ROOT}/Resources/Info.plist" "${OUTPUT}/Contents/Info.plist"
xattr -cr "${OUTPUT}"
codesign --force --deep --sign - "${OUTPUT}"

echo "Built ${OUTPUT}"
