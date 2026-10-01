---
title: 內建 API 伺服器
description: 本機 HTTP API 伺服器（權杖 / 配對）、AI 整合、iPad 等的遙控 Web UI。
---

Crateforge 內建 **本機 HTTP API 伺服器**。
啟用後，即可與 AI 代理（如 dj-curator）整合，或從手機 / TV / iPad 進行播放與遙控操作。

> 截圖稍後補上

## 啟用與監聽位置

在設定的 **「AI 整合 / API」** 啟用 API 伺服器。

- 預設為 **OFF**。預設連接埠為 **8787**。
- 預設以 **`127.0.0.1`（僅 loopback）** 監聽。
- 啟用 **「LAN 公開」** 後，可從同一 Wi-Fi 的手機 / TV / PC 瀏覽器存取。
  連線 URL 與 **QR 碼** 會顯示在設定中。

伺服器已強化為在確實完成停止後才重新啟動（`SO_REUSEADDR` / `SO_REUSEPORT`），
解決了「前一個伺服器尚未完全關閉而無法啟動（address in use）」的問題。

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
- `GET /api/tracks`（`?q` 搜尋、`?album` / `?genre` 部分比對、offset/limit）
- `GET /api/tracks/{id}` / `POST /api/tracks/by-ids`
- `GET /api/tracks/{id}/analysis` — 解析結果（未解析時為 null）
- `GET /api/tracks/{id}/similar` — 相似曲
- `GET /api/stats` / `GET /api/genres` / `GET /api/albums`
- `GET /api/playlists` / `GET /api/playlists/{id}`（含智慧型條件 `smartCriteria`） / `GET /api/playlists/{id}/tracks`

### 寫入（中繼資料）

- `PATCH /api/tracks/{id}` — 部分更新 name / artist / album / genre / year / bpm / rating / composer / comments 等。
  name / artist / album / genre / year / composer / comments 會寫回實際檔案的標籤，`rating` / `disabled` / `playCount` / `skipCount` 僅寫入 DB。
- `PATCH /api/tracks`（`{trackIds, edit}`） — 多曲一次更新。
- `POST /api/tracks/genre-tags/add` / `/remove` — 對類型標籤在尾端批次增減。

中繼資料的寫入除了更新 DB 之外，還會 **寫回實際檔案的 ID3 / Vorbis / MP4 標籤**（不移動資料夾，僅更新標籤），
並即時反映到 GUI。寫回的處理與桌面 GUI 的編輯共用同一條路徑。

寫回的內容也包含 **BPM** 與 **Key**（與桌面端的編輯相同）。

- **BPM** — 以整數寫入 TBPM（ID3v2）/ tmpo（MP4）/ `BPM`（Vorbis Comments）。
  優先採用曲目自身的 BPM，未設定時則採用解析結果。
- **Key** — 將解析結果的調性寫入 **InitialKey**（ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY），
  使用音樂記法（例如 `Am`）而非 Camelot。

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

## iPad 等的遙控 Web UI

啟用 LAN 公開後，可在瀏覽器開啟 **同源的遙控 Web UI**（`http://PC-IP:PORT/`）。
可從 iPad 等切換「在 PC 播放（遙控）」與「在此裝置播放」。
iOS 可用 **「加入主畫面」全螢幕應用程式化（PWA）**。

遙控具備 **播放 / 暫停、前後、搜尋、音量滑桿、隨機播放 / 重複播放的切換**，
狀態以 `GET /api/remote/state`（含 音量 / 隨機播放 / 重複播放）取得，操作以 `POST /api/remote/*`
（`play` / `pause` / `resume` / `next` / `prev` / `seek` / `volume` / `shuffle` / `repeat` 等）進行。

Web UI 也具備接近桌面本體的 **鍵盤快捷鍵**，按 `?` 可開啟一覽
（`Space` 播放 / 暫停、`J` / `K` 上一首 / 下一首、`Shift + ←` / `Shift + →` 5 秒搜尋、`S` 隨機播放、`R` 重複播放、
`Ctrl + ↑` / `Ctrl + ↓` 音量、`/` 與 `Ctrl + F` 搜尋、`Ctrl + L` 返回音樂庫、`↑` / `↓` 移動清單選取）。
即使在「在此裝置播放」時，也能從 Web UI 操作隨機播放 / 重複播放 / 音量。
