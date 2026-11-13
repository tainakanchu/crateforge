---
title: 內建 API 伺服器
description: 本機 HTTP API 伺服器（權杖 / 配對）、AI 整合、iPad 等的遙控 Web UI。
---

Crateforge 內建 **本機 HTTP API 伺服器**。
啟用後，即可與 AI 代理（如 dj-curator）整合，或從手機 / TV / iPad 進行播放與遙控操作。

> 截圖稍後補上

## 啟用與監聽位置

在設定的 **「行動裝置 / API」** 啟用 API 伺服器。

- 預設為 **OFF**。預設連接埠為 **8787**。
- 預設以 **`127.0.0.1`（僅 loopback）** 監聽。
- 啟用 **「LAN 公開」** 後，可從同一 Wi-Fi 的手機 / TV / PC 瀏覽器存取。
  連線 URL 與 **QR 碼** 會顯示在設定中。

伺服器已強化為在確實完成停止後才重新啟動（`SO_REUSEADDR`），
解決了「前一個伺服器尚未完全關閉而無法啟動（address in use）」的問題。
若已有其他 Crateforge 在同一連接埠等待連線，不會重複佔用該連接埠，而是改用其他空閒的連接埠（實際連接埠會顯示在設定的連線 URL，並以「8787 は使用中のため 9797 で起動しました」（8787 使用中，已改用 9797 啟動）明確標示）。

## 認證、權杖、配對

- 存取 **必須要有權杖**（顯示在設定中的權杖）。權杖可重新產生。
- 為了沒有相機的裝置（如 Android TV），備有 **裝置配對** 機制。
  以 `POST /api/pair/start` → `GET /api/pair/poll`（兩者皆不需 token）開始，
  在設定的 **「核准裝置」** UI 中允許後，即可不必手動輸入冗長的權杖就連線。

:::caution
寫入類的操作前提為 **僅限本機（同一台 PC）**。LAN 公開時的瀏覽以讀取為主。
:::

## AI 整合（讀寫 API）

公開可讀寫音樂庫、解析資料、播放清單的 REST API。主要端點：

### 讀取

- `GET /api/health` — 伺服器資訊 + 目前曲目數
- `GET /api/tracks`（`?q` 搜尋、`?album` / `?genre` 部分比對、offset/limit）。加上 `?albumExact=true` 可讓 `album` 完全比對
- `GET /api/tracks/{id}` / `POST /api/tracks/by-ids`（ID 列 → 曲目。屬唯讀查詢，LAN 端帶權杖也可使用）
- `GET /api/tracks/{id}/stream` — 音訊串流（`?native=true` 裝置可播放的格式不轉檔 / `?original=true` 原始檔 / `?fmt=aac&br=192` 轉為 AAC）
- `GET /api/tracks/{id}/analysis` — 解析結果（未解析時為 null）
- `GET /api/tracks/{id}/similar` — 相似曲
- `GET /api/stats` / `GET /api/genres` / `GET /api/albums`
- `GET /api/playlists` / `GET /api/playlists/{id}`（含智慧型條件 `smartCriteria`） / `GET /api/playlists/{id}/tracks`
  （智慧型播放清單的 `trackCount` 為條件即時評估後的曲數）

回傳曲目的 API（`/api/tracks` 系列・`/api/tracks/by-ids`・`/api/tracks/lookup`・`/similar`・`/api/playlists/{id}/tracks`・
`PATCH /api/tracks/{id}` 的回應）的 `bpm` 一律為**實效 BPM**（標籤的 BPM，沒有時為解析 BPM）。
需要標籤原值時，請加上 `?effectiveBpm=false` 明確指定（sync 角色的權杖也一律回傳標籤值）。
同步（取回・寫回）為避免把解析值存成標籤，一定會帶上 `?effectiveBpm=false` 發出請求。

標籤中沒有演出者 / 專輯的曲目不會以資料夾名稱補上，而是維持空白（曲名仍會以檔名補上）。
`GET /api/artists` 會把這些曲目彙整為一筆 `artist: ""`，`GET /api/albums` 彙整為一筆 `album: ""`，並排在最後
（「未知的演出者」「未知的專輯」等顯示名稱請由用戶端自行加上）。
這些曲目可透過 `GET /api/tracks?artist=`（空值）／ `GET /api/tracks?album=&albumExact=true` 取得。

查詢參數的布林值除了 `true` / `false` 之外，也接受 `1` / `0`。
用戶端送出 `Accept-Encoding: gzip` 時，較大的 JSON 回應（例如全部曲目清單）會以 gzip 壓縮回傳。

### 寫入（中繼資料）

- `PATCH /api/tracks/{id}` — 部分更新 name / artist / album / genre / year / bpm / rating / composer / comments 等。
  name / artist / album / genre / year / composer / comments 會寫回實際檔案的標籤，`rating` / `disabled` / `playCount` / `skipCount` 僅寫入 DB。
- `PATCH /api/tracks`（`{trackIds, edit}`） — 多曲一次更新。
- `POST /api/tracks/genre-tags/add` / `/remove` — 對類型標籤在尾端批次增減。

中繼資料的寫入除了更新 DB 之外，還會 **寫回實際檔案的 ID3 / Vorbis / MP4 標籤**，
並即時反映到 GUI。寫回的處理與桌面 GUI 的編輯共用同一條路徑。
若已設定整理目標資料夾（自動整理），會與 GUI 編輯相同，依編輯後的中繼資料 **移動資料夾並重新命名**，
回應中的 `locationPath` 即為移動後的路徑（移動失敗時編輯本身仍視為成功，並以 `relocateFailed` 告知）。

寫回的內容也包含 **BPM** 與 **Key**（與桌面端的編輯相同）。

- **BPM** — 以整數寫入 TBPM（ID3v2）/ tmpo（MP4）/ `BPM`（Vorbis Comments）。
  優先採用曲目自身的 BPM，未設定時則採用解析結果。
- **Key** — 將實際採用的調性（有手動覆寫則用覆寫值，否則用解析結果）寫入 **InitialKey**（ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY），
  使用音樂記法（例如 `Am`）而非 Camelot。

### 執行解析

- `POST /api/tracks/analyze`（`{trackIds, force?}`） — 將指定曲目的 BPM / Key / Energy / 相似度解析排入背景佇列，以 `202` 回傳 `queued`（排入件數）等資訊。已解析的曲目除非 `force: true` 否則不會排入。每次請求最多 1000 筆。僅限 loopback（從 LAN 會回 `403`）。
- `GET /api/analysis/status` — 解析進度（`analyzed` / `total` / 佇列剩餘 `pending`）。排入後用來輪詢。

這與同步用、匯入其他裝置已計算之解析結果的 `POST /api/analysis` 不同。進度仍會照常顯示在桌面 GUI。

### 轉換並取代

將曲目轉換為其他格式，並讓**同一首曲目**（ID、評分、播放次數、播放清單、編輯過的標籤都不變）改指向新檔案。由於會移動、刪除檔案，**僅限 loopback**（從 LAN 不論權杖或角色一律回 `403`）。

- `POST /api/convert-replace`（`{trackIds, format?, bitrateKbps?, original?}`） — 開始背景工作，以 `202` 回傳 `{jobId, total}`。`format` 為 `mp3`（預設）/ `aac` / `opus` / `flac` / `alac` / `wav`，`bitrateKbps` 僅適用於有損格式（MP3 預設 320）。`original` 決定原始檔案的處理：`trash`（預設，作業系統的資源回收筒）或 `replaced`（保留在 `_replaced/<日期>/`）。每次請求最多 5000 筆。工作一次執行一個。
- `GET /api/convert-replace/{jobId}` — `state`（`queued` / `running` / `done` / `failed`）、`done` / `total`、`counts`（`ok` / `skipped` / `failed`）與每首曲目的 `results`。

`results` 的每個項目包含 `trackId`、`status`（`ok` / `skipped` / `failed`）、`reason`（`already_target_format` / `no_file` / `encode_failed` / `decode_failed` / `duration_mismatch` 等）、`warnings`（`lossy_to_lossy` = 有損轉有損，`trash_failed` = 無法移到資源回收筒，改保留在 `_replaced`）、`sourceCodec` / `sourceLossless`（由實際檔案判定）、`newLocationPath` 與 `original`（`{kind: "trashed" | "moved" | "keptShared" | ...}`）。

- 已是目標編碼且位元率相同或更低的曲目（例如 MP3 320 → MP3 320）不做任何事，回報為 `skipped`。有損轉有損不會拒絕，只會加上警告。
- 改指向之前會將新檔案完整解碼，並確認長度與原始檔案幾乎相同。失敗的曲目不會動到原始檔案與曲目資訊。
- 其他曲目也參照的原始檔案不會被移動。
- 篩選對象時可使用曲目的 `codec`（`ALAC` / `AAC` / `FLAC` / `MP3` …）、`bitrateKbps`、`bitDepth`（工作本身也會由實際檔案判定編碼，直接傳入候選也沒問題）。

### 播放清單

- `POST /api/playlists` — 新增建立
- `POST /api/playlists/{id}/tracks` — 加入曲目
- `DELETE /api/playlists/{id}/tracks/{trackId}` — 移除 1 首曲目

經由 API 的變更會以 `library-changed` 事件即時反映到執行中應用程式的 UI。

### AI 選曲（dj-curator）

此儲存庫同時也是 Claude Code 的 **plugin marketplace**。

```text
/plugin marketplace add tainakanchu/crateforge
/plugin install dj-curator@crateforge

# 從概念產生選曲初稿
/dj-curator:build-set 夏天黃昏的 chill house，90分鐘，輕鬆起步
```

方針是 AI **專注於候選池的篩選**，**曲序由人類用 GUI 細修**。
詳情請參閱 [dj-curator 的 README](https://github.com/tainakanchu/crateforge/tree/main/plugins/dj-curator)。

## 投放用媒體 URL

為了 [Google Cast 投放播放](../playback/)，有一個供投放裝置取得音源的端點 `GET /api/cast/media/{ticket}`（支援 `HEAD` 與 `Range`）。

- **僅供 Cast 使用**，不使用 LAN 權杖，而是以 **短效的 Media Ticket**（綁定單一曲目、有期限、可撤銷）驗證。
  票證無效 / 過期 / 已撤銷時會回傳 `404`。
- 票證會在切換曲目、中斷連線、結束應用程式時失效。LAN 權杖不會交給投放裝置。
- 此路徑上 `GET` / `HEAD` 以外的請求，仍需要一般的權杖。

## iPad 等的遙控 Web UI

啟用 LAN 公開後，可在瀏覽器開啟 **同源的遙控 Web UI**（`http://PC-IP:PORT/`）。
可從 iPad 等切換「在 PC 播放（遙控）」與「在此裝置播放」。
iOS 可用 **「加入主畫面」全螢幕應用程式化（PWA）**。

遙控具備 **播放 / 暫停、前後、搜尋、音量滑桿、隨機播放 / 重複播放的切換**，
狀態以 `GET /api/remote/state`（含 音量 / 隨機播放 / 重複播放）取得，操作以 `POST /api/remote/*`
（`play` / `pause` / `resume` / `next` / `prev` / `seek` / `volume` / `shuffle` / `repeat` 等）進行。
停止後的 `resume` 會從佇列目前位置的曲目重新播放。若要從佇列的任意位置播放，請使用
`POST /api/remote/play-at`（`{index}`，即 `GET /api/remote/queue` 的 `trackIds` 中的位置）；
若要替換佇列並立即播放，請在 `POST /api/remote/set-queue` 加上 `play: true`。

Web UI 也具備接近桌面本體的 **鍵盤快捷鍵**，按 `?` 可開啟一覽
（`Space` 播放 / 暫停、`J` / `K` 上一首 / 下一首、`Shift + ←` / `Shift + →` 5 秒搜尋、`S` 隨機播放、`R` 重複播放、
`Ctrl + ↑` / `Ctrl + ↓` 音量、`/` 與 `Ctrl + F` 搜尋、`Ctrl + L` 返回音樂庫、`↑` / `↓` 移動清單選取）。
即使在「在此裝置播放」時，也能從 Web UI 操作隨機播放 / 重複播放 / 音量。
