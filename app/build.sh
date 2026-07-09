#!/usr/bin/env bash
# Build HumansApp and assemble it into a runnable humans.sh.app bundle.
#
# There's no Xcode project here — the app is a SwiftPM executable, and this
# script wraps the built binary in the .app layout macOS needs for a menu-bar
# agent (LSUIElement) with a stable bundle identity for notifications and
# SMAppService. Ad-hoc code-signs so notifications and launch-at-login work
# locally; pass a Developer ID to SIGN_IDENTITY for a distributable build.
#
# Usage:
#   ./build.sh                                  # ad-hoc, local only
#   SIGN_IDENTITY="Developer ID Application: …" ./build.sh
#   SIGN_IDENTITY="Developer ID Application: …" ./build.sh --notarize
#
# --notarize zips the bundle, submits it to Apple's notary service, staples the
# ticket, and re-verifies with Gatekeeper — the full one-command release. It
# needs a stored notarytool credential profile (NOTARY_PROFILE, default
# "humans.sh"); create one once with:
#   xcrun notarytool store-credentials humans.sh \
#     --apple-id <you> --team-id <TEAMID> --password <app-specific-password>
set -euo pipefail

cd "$(dirname "$0")"

CONFIG="${CONFIG:-release}"
APP_NAME="humans.sh"
BUNDLE="build/${APP_NAME}.app"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"   # "-" = ad-hoc
NOTARY_PROFILE="${NOTARY_PROFILE:-humans.sh}"

NOTARIZE=0
for arg in "$@"; do
    case "$arg" in
        --notarize) NOTARIZE=1 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if [ "$NOTARIZE" = 1 ] && [ "$SIGN_IDENTITY" = "-" ]; then
    echo "error: --notarize requires a Developer ID (set SIGN_IDENTITY)" >&2
    exit 2
fi

echo "› swift build -c $CONFIG"
swift build -c "$CONFIG"
BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/HumansApp"

echo "› assembling $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$BIN_PATH" "$BUNDLE/Contents/MacOS/HumansApp"
cp Info.plist "$BUNDLE/Contents/Info.plist"
printf 'APPL????' > "$BUNDLE/Contents/PkgInfo"

echo "› codesign ($SIGN_IDENTITY)"
codesign --force --deep --options runtime \
    --sign "$SIGN_IDENTITY" \
    --identifier sh.humans.app \
    "$BUNDLE"

if [ "$NOTARIZE" = 1 ]; then
    ZIP="build/${APP_NAME}.zip"
    echo "› notarize (profile: $NOTARY_PROFILE)"
    /usr/bin/ditto -c -k --keepParent "$BUNDLE" "$ZIP"
    xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
    echo "› staple"
    xcrun stapler staple "$BUNDLE"
    rm -f "$ZIP"
    echo "› verify"
    spctl -a -vv -t exec "$BUNDLE"
fi

echo "✓ built $BUNDLE"
[ "$NOTARIZE" = 1 ] && echo "  notarized & stapled — runs on any Mac"
echo "  run:     open $BUNDLE"
echo "  install: cp -R $BUNDLE /Applications/"
