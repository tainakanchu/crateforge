#!/usr/bin/env bash
# macOS: Homebrew の libdiscid を .app 同梱用にステージングする。
#
# Homebrew の dylib は install name が絶対パス (/opt/homebrew/opt/libdiscid/lib/...)
# なので、そのままリンクすると実行バイナリがその絶対パスを参照し、
# libdiscid を brew で入れていない Mac では起動直後に dyld が落ちる。
# ここで install name を @rpath に書き換えたコピーを作り、それにリンクさせた上で
# Tauri の bundle.macOS.frameworks で Contents/Frameworks に同梱する
# (rpath @executable_path/../Frameworks は tauri-build が付与する)。
#
# usage: scripts/macos-stage-libdiscid.sh <out-dir>
set -euo pipefail

out="${1:?usage: $0 <out-dir>}"
brew_prefix="$(brew --prefix)"
src="$(brew --prefix libdiscid)/lib/libdiscid.0.dylib"
dst="$out/libdiscid.0.dylib"

mkdir -p "$out"
cp -L "$src" "$dst"
chmod u+w "$dst"
install_name_tool -id "@rpath/libdiscid.0.dylib" "$dst"
# install_name_tool で署名が壊れる (arm64 では未署名 dylib はロード不可) ので ad-hoc 再署名。
codesign --force --sign - "$dst"
# リンカ (-l discid) が拾う名前。
ln -sf libdiscid.0.dylib "$out/libdiscid.dylib"

echo "=== staged $dst ==="
otool -L "$dst"

# 同梱する dylib 自身が Homebrew 配下に依存していないこと (= 単体で配布可能) を確認。
if otool -L "$dst" | tail -n +2 | grep -F "$brew_prefix"; then
  echo "::error::staged libdiscid still references Homebrew paths" >&2
  exit 1
fi
