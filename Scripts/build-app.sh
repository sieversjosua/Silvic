#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${ROOT}/outputs/Branchdeck.app"
ZIP_OUTPUT="${ROOT}/outputs/Branchdeck.zip"

cd "${ROOT}"
swift build -c release -j 1
BIN_PATH="$(swift build -c release --show-bin-path)"

rm -rf "${OUTPUT}"
mkdir -p "${OUTPUT}/Contents/MacOS" "${OUTPUT}/Contents/Resources"
cp "${BIN_PATH}/Branchdeck" "${OUTPUT}/Contents/MacOS/Branchdeck"
cp "${ROOT}/Resources/Info.plist" "${OUTPUT}/Contents/Info.plist"
cp "${ROOT}/Resources/Branchdeck.icns" "${OUTPUT}/Contents/Resources/Branchdeck.icns"

for attempt in 1 2 3; do
  xattr -cr "${OUTPUT}"
  xattr -d com.apple.FinderInfo "${OUTPUT}" 2>/dev/null || true
  if codesign --force --deep --sign - "${OUTPUT}"; then
    break
  fi
  if [[ "${attempt}" == "3" ]]; then
    exit 1
  fi
  sleep 0.2
done

codesign --verify --deep --strict "${OUTPUT}"

rm -f "${ZIP_OUTPUT}"
xattr -cr "${OUTPUT}"
codesign --verify --deep --strict "${OUTPUT}"
(
  cd "${ROOT}/outputs"
  COPYFILE_DISABLE=1 /usr/bin/zip -qry "${ZIP_OUTPUT}" "Branchdeck.app"
)

echo "Built ${OUTPUT} and ${ZIP_OUTPUT}"
