#!/bin/bash
# Rebuild the native "Cable Speed Monitor.app" from "Cable Speed Monitor.swift".
# Usage: ./build-app.sh
set -euo pipefail
cd "$(dirname "$0")"

APP="Cable Speed Monitor.app"
BIN="$APP/Contents/MacOS/Cable Speed Monitor"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Compile the native WebKit app (replaces the old launcher-script binary).
swiftc -O -o "$BIN" "Cable Speed Monitor.swift"
chmod +x "$BIN"

# Write Info.plist.
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Cable Speed Monitor</string>
	<key>CFBundleDisplayName</key>
	<string>Cable Speed Monitor</string>
	<key>CFBundleIdentifier</key>
	<string>com.cablespeed.monitor</string>
	<key>CFBundleExecutable</key>
	<string>Cable Speed Monitor</string>
	<key>CFBundleIconFile</key>
	<string>icon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.utilities</string>
</dict>
</plist>
PLIST

# Refresh the icon from the source PNG (if assets/icon-source.png exists).
if [ -f assets/icon-source.png ]; then
  mkdir -p /tmp/cable-icon.iconset
  sips -z 16 16    assets/icon-source.png --out /tmp/cable-icon.iconset/icon_16x16.png >/dev/null
  sips -z 32 32    assets/icon-source.png --out /tmp/cable-icon.iconset/icon_16x16@2x.png >/dev/null
  sips -z 32 32    assets/icon-source.png --out /tmp/cable-icon.iconset/icon_32x32.png >/dev/null
  sips -z 64 64    assets/icon-source.png --out /tmp/cable-icon.iconset/icon_32x32@2x.png >/dev/null
  sips -z 128 128  assets/icon-source.png --out /tmp/cable-icon.iconset/icon_128x128.png >/dev/null
  sips -z 256 256  assets/icon-source.png --out /tmp/cable-icon.iconset/icon_128x128@2x.png >/dev/null
  sips -z 256 256  assets/icon-source.png --out /tmp/cable-icon.iconset/icon_256x256.png >/dev/null
  sips -z 512 512  assets/icon-source.png --out /tmp/cable-icon.iconset/icon_256x256@2x.png >/dev/null
  sips -z 512 512  assets/icon-source.png --out /tmp/cable-icon.iconset/icon_512x512.png >/dev/null
  sips -z 1024 1024 assets/icon-source.png --out /tmp/cable-icon.iconset/icon_512x512@2x.png >/dev/null
  iconutil -c icns /tmp/cable-icon.iconset -o "$APP/Contents/Resources/icon.icns"
  rm -rf /tmp/cable-icon.iconset
fi

# Ad-hoc sign so the app runs cleanly.
codesign --force --deep --sign - "$APP"
echo "Built: $APP"
