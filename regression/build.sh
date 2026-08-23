#!/bin/zsh
# 构建 AgOS.app —— 原生 Swift 外壳,零第三方依赖。
#   ./build.sh          编译到 ./dist/AgOS.app
#   ./build.sh install  编译后安装到 /Applications
set -euo pipefail

ROOT="${0:A:h}"
DIST="$ROOT/dist"
APP="$DIST/AgOS.app"
BIN="$APP/Contents/MacOS/AgOS"
RES="$APP/Contents/Resources"

echo "▸ 清理"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES"

echo "▸ 编译 (swiftc, arm64, -O)"
swiftc -O -target arm64-apple-macosx13.0 \
	-framework AppKit -framework WebKit \
	-o "$BIN" "$ROOT/Sources/AgOS.swift"

echo "▸ 写 Info.plist"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>AgOS</string>
	<key>CFBundleDisplayName</key><string>AgOS</string>
	<key>CFBundleIdentifier</key><string>com.leo.agos</string>
	<key>CFBundleExecutable</key><string>AgOS</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticTermination</key><false/>
	<key>NSSupportsSuddenTermination</key><false/>
	<key>NSMicrophoneUsageDescription</key><string>AgOS 的语音输入需要使用麦克风把你说的话转成文字。</string>
	<!-- 只连本机后端;允许明文 HTTP 仅限 127.0.0.1 -->
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key><true/>
	</dict>
</dict>
</plist>
PLIST

echo "▸ 生成图标"
ICONSET="$DIST/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
# 用 CoreGraphics 直接画(零第三方依赖,不需要 rsvg/ImageMagick)
swift "$ROOT/Sources/GenIcon.swift" "$ICONSET" >/dev/null 2>&1
if iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns" 2>/dev/null; then
	echo "  图标 ✓"
else
	echo "  (图标生成失败,App 用系统默认图标)"
fi

echo "▸ 打包 SPA(自带 dist:App 包内不受 TCC 管辖,与仓库位置解耦)"
SPA_SRC="${AGOS_SPA_DIST:-$HOME/Projects/agos-frontend/dist}"
if [[ -f "$SPA_SRC/index.html" ]]; then
	rm -rf "$RES/web"; mkdir -p "$RES/web"
	cp -R "$SPA_SRC/" "$RES/web/"
	echo "  已内置 $(du -sh "$RES/web" | awk '{print $1}') ← $SPA_SRC"
else
	echo "  ⚠️ 找不到 SPA dist($SPA_SRC),App 将回退到后端默认路径"
fi

echo "▸ 临时签名"
codesign --force --deep --sign - "$APP" 2>/dev/null && echo "  签名 ✓" || echo "  (签名跳过)"

echo "▸ 完成:$APP"
du -sh "$APP" | awk '{print "  体积 "$1}'

if [[ "${1:-}" == "install" ]]; then
	echo "▸ 安装到 /Applications"
	rm -rf "/Applications/AgOS.app"
	cp -R "$APP" "/Applications/AgOS.app"
	echo "  已安装:/Applications/AgOS.app"
fi
