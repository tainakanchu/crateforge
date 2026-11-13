#!/usr/bin/env bash
# 固定版 libdiscid (third_party/libdiscid/libdiscid.env) をソースからビルドする。
# macOS .app / Linux AppImage に同梱するリリースビルド用。
#
# Homebrew / apt のパッケージを使わない理由:
#   - 同梱バイナリと「対応するソース」(LGPL-2.1 §6) を厳密に一致させるため、版と SHA-256 を固定する
#   - macOS では install name を @rpath にし、デプロイメントターゲットを自前で決めるため
#     (brew の dylib は /opt/homebrew の絶対パス参照 + ランナー OS 以上でしか動かない)
#
# usage:
#   scripts/build-libdiscid.sh fetch <dir>     ソース tarball を取得・SHA-256 検証して <dir> に置く
#   scripts/build-libdiscid.sh build <prefix>  ビルドして <prefix> にインストール
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../third_party/libdiscid/libdiscid.env
source "$ROOT/third_party/libdiscid/libdiscid.env"

mode="${1:?usage: $0 fetch|build <dir>}"
dest="${2:?usage: $0 fetch|build <dir>}"
tarball="libdiscid-$LIBDISCID_VERSION.tar.gz"
url="https://github.com/metabrainz/libdiscid/releases/download/v$LIBDISCID_VERSION/$tarball"

fetch() {
  mkdir -p "$1"
  curl -fsSL --retry 3 -o "$1/$tarball" "$url"
  (cd "$1" && echo "$LIBDISCID_SHA256  $tarball" | shasum -a 256 -c -)
}

build() {
  local work src
  work="$(mktemp -d)"
  fetch "$work"
  tar -xzf "$work/$tarball" -C "$work"
  src="$work/libdiscid-$LIBDISCID_VERSION"

  local args=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$dest" -DCMAKE_INSTALL_LIBDIR=lib)
  if [ "$(uname -s)" = Darwin ]; then
    # 実行バイナリには @rpath/libdiscid.0.dylib として記録され、
    # tauri-build が付与する rpath (@executable_path/../Frameworks) で解決される。
    args+=(
      -DCMAKE_INSTALL_NAME_DIR=@rpath
      -DCMAKE_BUILD_WITH_INSTALL_NAME_DIR=ON
      -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
    )
  fi

  cmake -S "$src" -B "$work/build" "${args[@]}"
  cmake --build "$work/build" --target libdiscid --parallel
  cmake --install "$work/build"

  if [ "$(uname -s)" = Darwin ]; then
    local lib="$dest/lib/libdiscid.0.dylib"
    # install 時に install_name_tool が走ると署名が壊れる (arm64 は未署名 dylib をロード不可)。
    codesign --force --sign - "$lib"
    otool -L "$lib"
    otool -l "$lib" | grep -A4 LC_BUILD_VERSION || true
    otool -D "$lib" | grep -q "@rpath/libdiscid.0.dylib"
  else
    objdump -p "$dest/lib/libdiscid.so.0" | grep SONAME
  fi
  rm -rf "$work"
}

case "$mode" in
  fetch) fetch "$dest" ;;
  build) build ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
