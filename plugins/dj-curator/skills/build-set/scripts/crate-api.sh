#!/usr/bin/env bash
#
# crate-api.sh — Crateforge ローカル API への薄い curl ラッパ。
#
# Crateforge アプリの「設定 → AI 連携 / API」で有効化した内蔵 HTTP API
# (既定 http://127.0.0.1:8787) を叩くためのヘルパ。jq には依存せず、生 JSON を
# そのまま標準出力へ返す (パースは呼び出し側=Claude が行う想定)。
#
# 使い方:
#   crate-api.sh health
#   crate-api.sh GET    "/api/tracks?genre=House&ratingMin=60&limit=200"
#   crate-api.sh GET    "/api/tracks/123/similar?limit=10&keyCompatible=true"
#   crate-api.sh POST   /api/playlists            '{"name":"夏の夕暮れ 2026"}'
#   crate-api.sh POST   /api/playlists/45/tracks  '{"trackIds":[12,7,30]}'
#   crate-api.sh DELETE /api/playlists/45/tracks/7
#
# 環境変数:
#   CRATEFORGE_API    ベース URL を上書き (既定 http://127.0.0.1:8787)
#   CRATE_API_DRYRUN  非空なら curl を実行せず、実行予定の curl コマンドを表示
#                     (オフライン検証用)。
#
set -euo pipefail

BASE="${CRATEFORGE_API:-http://127.0.0.1:8787}"

usage() {
  sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'
}

# curl を実行する。DRYRUN 時は実行せずコマンド列を表示。
run_curl() {
  if [ -n "${CRATE_API_DRYRUN:-}" ]; then
    # 実行予定のコマンドを安全にクォートして表示する。
    local out="curl"
    local a
    for a in "$@"; do
      out+=" $(printf '%q' "$a")"
    done
    printf '%s\n' "$out"
    return 0
  fi
  curl "$@"
}

cmd="${1:-}"

case "$cmd" in
  -h|--help|"")
    usage
    exit 0
    ;;

  health)
    # 到達確認。到達できなければ、有効化の案内を出して非ゼロ終了する。
    if [ -n "${CRATE_API_DRYRUN:-}" ]; then
      run_curl -fsS "$BASE/api/health"
      exit 0
    fi
    if curl -fsS --max-time 5 "$BASE/api/health"; then
      exit 0
    else
      {
        echo ""
        echo "Crateforge API ($BASE) に接続できませんでした。" >&2
        echo "Crateforge アプリを起動し、設定 → 「AI 連携 / API」で" >&2
        echo "API サーバーを有効化してください (既定ポート 8787)。" >&2
        echo "別ポートの場合は CRATEFORGE_API を設定してください。" >&2
      }
      exit 1
    fi
    ;;

  GET|DELETE)
    path="${2:-}"
    if [ -z "$path" ]; then
      echo "error: $cmd にはパスが必要です (例: $cmd /api/tracks)" >&2
      exit 2
    fi
    run_curl -fsS -X "$cmd" "$BASE$path"
    ;;

  POST|PUT)
    path="${2:-}"
    body="${3:-}"
    if [ -z "$path" ]; then
      echo "error: $cmd にはパスが必要です" >&2
      exit 2
    fi
    if [ -z "$body" ]; then
      run_curl -fsS -X "$cmd" "$BASE$path"
    else
      run_curl -fsS -X "$cmd" \
        -H "Content-Type: application/json" \
        -d "$body" \
        "$BASE$path"
    fi
    ;;

  *)
    echo "error: 不明なコマンド '$cmd'" >&2
    usage
    exit 2
    ;;
esac
