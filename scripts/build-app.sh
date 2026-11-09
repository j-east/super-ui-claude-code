#!/bin/sh
# Builds "Claude Code Super UI.app" (Swift + WKWebView host for build/server.js).
#
#   sh scripts/build-app.sh          dev build: uses this checkout's build/, public/ and your node;
#                                    installs to ~/Applications and registers it with Spotlight.
#   sh scripts/build-app.sh --dist   self-contained build for other Macs: bundles node, the server,
#                                    the page and production node_modules; zipped, not installed.
#
# Signing for --dist: ad-hoc unless SIGN_ID is set to a "Developer ID Application: …" identity
# (then hardened runtime + entitlements). With NOTARY_PROFILE set too (a `xcrun notarytool
# store-credentials` profile name) it is notarized and stapled, so it opens without Gatekeeper warnings.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=dev; [ "$1" = "--dist" ] && MODE=dist
NAME="Claude Code Super UI"
BIN="ClaudeCodeSuperUI"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "node not found on PATH" >&2; exit 1; }
[ -f "$ROOT/build/server.js" ] || { echo "run 'npm run build' first" >&2; exit 1; }

if [ "$MODE" = dist ]; then OUT="$ROOT/dist.noindex/release"; else OUT="$ROOT/dist.noindex"; fi
APP="$OUT/$NAME.app"  # .noindex: Spotlight skips the build copy
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Dev: bake in absolute paths so Finder/Spotlight launches don't depend on your shell PATH.
# Dist: the app finds Contents/Resources/{node,app} itself; the placeholders stay unused.
if [ "$MODE" = dev ]; then
  sed -e "s|NODE_PATH_PLACEHOLDER|$NODE|" -e "s|SERVER_PATH_PLACEHOLDER|$ROOT/build/server.js|" \
    "$ROOT/native/main.swift" > "$TMP/main.swift"
else
  cp "$ROOT/native/main.swift" "$TMP/main.swift"
fi
ARCH="$(uname -m)"
swiftc -O -swift-version 5 -target "$ARCH-apple-macos13.0" -o "$APP/Contents/MacOS/$BIN" "$TMP/main.swift" \
  -framework Cocoa -framework WebKit -framework UserNotifications

# Icon
swift "$ROOT/native/icon.swift" "$TMP/icon.png"
mkdir "$TMP/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>world.pathwriter.claude-super-ui</string>
  <key>CFBundleExecutable</key><string>$BIN</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSArchitecturePriority</key><array><string>$ARCH</string></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

if [ "$MODE" = dev ]; then
  # Ad-hoc signature: required for notifications, fine for a local app.
  codesign --force --sign - "$APP" >/dev/null
  echo "built: $APP"
  # Install: a real bundle in ~/Applications (Spotlight skips symlinks), registered with LaunchServices.
  DEST="$HOME/Applications/$NAME.app"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  "$LSREG" -f "$DEST"
  "$LSREG" -u "$APP" 2>/dev/null || true
  mdimport "$DEST"
  echo "installed: $DEST"
  exit 0
fi

# ---------- dist: bundle node + server + page + production deps ----------
RES="$APP/Contents/Resources"
STAGE="$RES/app"
mkdir -p "$STAGE"
cp -R "$ROOT/build" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
rm -f "$STAGE"/build/*.map
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# node-pty ships prebuilt binaries; keep only this Mac's architecture and make the helper executable.
PTY="$STAGE/node_modules/node-pty"
find "$PTY/prebuilds" -mindepth 1 -maxdepth 1 ! -name "darwin-$ARCH" -exec rm -rf {} +
rm -rf "$PTY/src" "$PTY/deps" "$PTY/scripts" "$PTY/third_party" 2>/dev/null || true
chmod +x "$PTY/prebuilds/darwin-$ARCH/spawn-helper"
rm -f "$STAGE/package-lock.json"
cp "$NODE" "$RES/node"
chmod +x "$RES/node"
# Node is MIT-licensed; its license ships with it (bundled npm packages carry their own).
NODE_LICENSE="$(dirname "$(dirname "$NODE")")/LICENSE"
[ -f "$NODE_LICENSE" ] && cp "$NODE_LICENSE" "$RES/node-LICENSE"

ENT="$TMP/entitlements.plist"
cat > "$ENT" <<ENTS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
ENTS

# Sign inside-out: native addons and helpers, then node, then the app.
if [ -n "$SIGN_ID" ]; then
  SIGN="codesign --force --timestamp --options runtime --entitlements $ENT --sign"
  ID="$SIGN_ID"
else
  SIGN="codesign --force --sign"; ID="-"
fi
find "$STAGE" -type f \( -name "*.node" -o -name "spawn-helper" \) -exec $SIGN "$ID" {} \;
$SIGN "$ID" "$RES/node"
$SIGN "$ID" "$APP"
codesign --verify --deep --strict "$APP"
echo "built: $APP ($(du -sh "$APP" | cut -f1))"

ZIP="$OUT/Claude-Code-Super-UI-$VERSION-$ARCH.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
if [ -n "$SIGN_ID" ] && [ -n "$NOTARY_PROFILE" ]; then
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"; ditto -c -k --keepParent "$APP" "$ZIP"
fi
echo "zipped: $ZIP ($(du -sh "$ZIP" | cut -f1))"
[ -n "$SIGN_ID" ] || echo "note: ad-hoc signed. Other Macs will block it until it is signed with a Developer ID and notarized."
