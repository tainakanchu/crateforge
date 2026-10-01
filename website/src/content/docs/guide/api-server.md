---
title: 内蔵 API サーバー
description: ローカル HTTP API サーバー（トークン / ペアリング）、AI 連携、iPad 等のリモコン Web UI。
---

Crateforge は **ローカル HTTP API サーバー** を内蔵しています。
これを有効にすると、AI エージェント（dj-curator など）との連携や、スマホ / TV / iPad からの再生・リモコン操作ができます。

> 画像は後日追加

## 有効化と待受先

設定の **「AI 連携 / API」** で API サーバーを有効化します。

- 既定は **OFF**。既定ポートは **8787**。
- 既定では **`127.0.0.1`（ループバックのみ）** で待ち受けます。
- **「LAN 公開」** を有効にすると、同じ Wi-Fi のスマホ / TV / PC のブラウザからアクセスできます。
  接続 URL と **QR コード** が設定に表示されます。

サーバーの停止が確実に完了してから再起動するよう堅牢化されており（`SO_REUSEADDR` / `SO_REUSEPORT`）、
「前のサーバーが落ち切らずに起動できない（address in use）」を解消しています。

## 認証・トークン・ペアリング

- アクセスには **トークンが必須** です（設定に表示されるトークン）。トークンは再生成できます。
- カメラの無い端末（Android TV など）向けに **デバイスペアリング** を用意しています。
  `POST /api/pair/start` → `GET /api/pair/poll`（いずれも token 不要）で開始し、
  設定の **「端末を承認」** UI で許可すると、長いトークンを手入力せずに接続できます。

:::caution
書き込み系の操作は **ローカル（同一 PC）からのみ** を前提としています。LAN 公開時のブラウズは読み取り中心です。
:::

## AI 連携（読み書き API）

ライブラリ・解析データ・プレイリストを読み書きできる REST API を公開します。主なエンドポイント:

### 読み取り

- `GET /api/health` — サーバーの素性 + 現在の曲数
- `GET /api/tracks`（`?q` 検索、`?album` / `?genre` 部分一致、offset/limit）
- `GET /api/tracks/{id}` / `POST /api/tracks/by-ids`
- `GET /api/tracks/{id}/analysis` — 解析結果（未解析なら null）
- `GET /api/tracks/{id}/similar` — 類似曲
- `GET /api/stats` / `GET /api/genres` / `GET /api/albums`
- `GET /api/playlists` / `GET /api/playlists/{id}`（スマート条件 `smartCriteria` を含む） / `GET /api/playlists/{id}/tracks`

### 書き込み（メタデータ）

- `PATCH /api/tracks/{id}` — name / artist / album / genre / year / bpm / rating / composer / comments などを部分更新。
  name / artist / album / genre / year / composer / comments などは実ファイルのタグへ書き戻し、`rating` / `disabled` / `playCount` / `skipCount` は DB のみ。
- `PATCH /api/tracks`（`{trackIds, edit}`） — 複数曲の一括更新。
- `POST /api/tracks/genre-tags/add` / `/remove` — ジャンルタグを末尾に一括で増減。

メタデータの書き込みは DB 更新に加えて **実ファイルの ID3 / Vorbis / MP4 タグへ書き戻し**（フォルダ移動はせずタグのみ）、
GUI に即時反映します。書き戻しの処理はデスクトップ GUI の編集と共通です。

書き戻しには **BPM** と **Key** も含まれます（デスクトップの編集と同じ扱い）。

- **BPM** — TBPM（ID3v2）/ tmpo（MP4）/ `BPM`（Vorbis Comments）へ整数で書きます。
  曲自身の BPM を優先し、未設定なら解析結果を使います。
- **Key** — 解析結果のキーを **InitialKey**（ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY）へ、
  Camelot ではなく音楽表記（`Am` など）で書きます。

### プレイリスト

- `POST /api/playlists` — 新規作成
- `POST /api/playlists/{id}/tracks` — 曲を追加
- `DELETE /api/playlists/{id}/tracks/{trackId}` — 曲を 1 件外す

API 経由の変更は `library-changed` イベントで起動中アプリの UI に即時反映されます。

### AI 選曲（dj-curator）

このリポジトリは Claude Code の **plugin marketplace** にもなっています。

```text
/plugin marketplace add tainakanchu/crateforge
/plugin install dj-curator@crateforge

# コンセプトから選曲の叩き台を生成
/dj-curator:build-set 夏の夕暮れの chill house、90分、ゆるめスタート
```

AI は **候補プールの選定に集中** し、**曲順は GUI で人間が詰める** 方針です。
詳細は [dj-curator の README](https://github.com/tainakanchu/crateforge/tree/main/plugins/dj-curator) を参照してください。

## iPad 等のリモコン Web UI

LAN 公開を有効にすると、**同一オリジンのリモコン Web UI**（`http://PC-IP:PORT/`）をブラウザで開けます。
iPad などから「PC で再生（リモコン）」と「この端末で再生」を切り替えられます。
iOS は **「ホーム画面に追加」で全画面アプリ化（PWA）** できます。

リモコンには **再生 / 一時停止・前後・シーク・音量スライダー・シャッフル / リピートのトグル** があり、
状態は `GET /api/remote/state`（音量 / シャッフル / リピートを含む）、操作は `POST /api/remote/*`
（`play` / `pause` / `resume` / `next` / `prev` / `seek` / `volume` / `shuffle` / `repeat` など）で行います。

Web UI にはデスクトップ本体に近い **キーボードショートカット** があり、`?` で一覧を開けます
（`Space` 再生 / 一時停止、`J` / `K` 前後、`Shift + ←` / `Shift + →` 5 秒シーク、`S` シャッフル、`R` リピート、
`Ctrl + ↑` / `Ctrl + ↓` 音量、`/` と `Ctrl + F` 検索、`Ctrl + L` ライブラリへ戻る、`↑` / `↓` でリスト選択）。
「この端末で再生」しているときも、シャッフル / リピート / 音量を Web UI 側で操作できます。
