#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${ROOT}/outputs/Silvic.app"
ZIP_OUTPUT="${ROOT}/outputs/Silvic.zip"

cd "${ROOT}"
swift build -c release -j 1
BIN_PATH="$(swift build -c release --show-bin-path)"

rm -rf "${OUTPUT}"
mkdir -p "${OUTPUT}/Contents/MacOS" "${OUTPUT}/Contents/Resources"
cp "${BIN_PATH}/Silvic" "${OUTPUT}/Contents/MacOS/Silvic"
cp "${ROOT}/Resources/Info.plist" "${OUTPUT}/Contents/Info.plist"
cp "${ROOT}/Resources/Silvic.icns" "${OUTPUT}/Contents/Resources/Silvic.icns"

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
  COPYFILE_DISABLE=1 /usr/bin/zip -qry "${ZIP_OUTPUT}" "Silvic.app"
)

echo "Built ${OUTPUT} and ${ZIP_OUTPUT}"
