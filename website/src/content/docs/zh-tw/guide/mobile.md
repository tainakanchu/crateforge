---
title: 行動裝置
description: 行動用戶端的連線（QR / 手動）、瀏覽、裝置播放與背景播放、遙控、離線下載 / 瀏覽 / 播放，以及 Android APK 與 Android Auto。
---

Crateforge 的行動用戶端可透過[內建 API 伺服器](../api-server/)，
瀏覽與播放桌面端的音樂庫。即使未連接伺服器，也能瀏覽與播放已下載的內容。

> 截圖稍後補上

## 連線

請先在桌面端啟用內建 API 伺服器的 **「LAN 公開」**。
行動端可用以下任一方式連線。

- **QR 碼** — 讀取設定中顯示的連線 URL 之 QR 即可連線。
- **手動輸入** — 手動輸入連線 URL 與權杖。

> 配對（`POST /api/pair/start` → `GET /api/pair/poll`）是為沒有相機的 Android TV 用戶端準備的功能，並非行動用戶端的連線方式。

## 瀏覽

連線中時，可依下列單位瀏覽桌面的音樂庫。

- **曲目 / 播放清單 / 專輯 / 演出者**
- 依類型篩選與文字搜尋
- 顯示 **封面圖**
- 開啟專輯時的曲序為 **光碟編號 → 曲目編號** 順
- 開啟演出者後會列出專輯，並依專輯演出者順序排序
- 演出者的歸併方式可在設定（**專輯演出者 / 演出者**）中切換

## 裝置播放與背景播放

- 選擇「在此裝置播放」後，會在行動裝置上播放（支援 **背景播放**）。
- **隨機播放改為先決定播放順序（排列）再播放的方式。** 一輪之中不會重複同一首曲目，
  播放畫面的 **Up Next** 也會直接顯示接下來的順序。
  往下一首之後立刻按「上一首」，會回到同一首曲目。
- 開啟隨機播放時只會打亂 **目前位置之後的部分**，關閉時則回到自然順序
  （兩種情況下正在播放的曲目都會繼續播放）。
- **隨機播放 / 重複播放的設定會保存在裝置上，並延續到下次啟動。**
- 串流支援用戶端取向的參數。
  - `?native=1` — 裝置能播放的格式以無轉換配送（ALAC / FLAC 等維持無損）
  - `?original=1` — 一律提供原本
  - `?fmt=aac&br=N` — 重新編碼為 AAC-LC（用於節省離線保存的容量）

## 遙控

切換為「在 PC 播放（遙控）」後，可從行動端操作桌面端的播放。
可操作 播放 / 暫停、前後、搜尋、音量、隨機播放 / 重複播放，並同步播放中的狀態。
點按播放中的演出者（與專輯）即可前往該頁面。

## 離線下載 / 瀏覽 / 播放

只要先下載曲目，**即使未連接伺服器** 也能瀏覽與播放。

- 已下載的 **曲目 / 播放清單 / 專輯** 可離線瀏覽與播放。
- 下載時會 **將專輯封面以 webp 在本機保存**（以專輯為單位去重），因此未連線時也能顯示封面。
- 即使在離線的收藏中，專輯列也會顯示封面圖與專輯演出者（多位混合時顯示 "Various Artists"）。
- 演出者頁面也會從已下載的內容以專輯顯示重現。

## Android 與 Android Auto

Android 版以 **GitHub Releases 上的已簽署 APK** 發佈（不在 Google Play 發佈）。
Android Auto 支援與一般手機版包含在同一個 APK 中。在 Android Auto 上，可從車載螢幕瀏覽、搜尋並播放
**已下載的曲目 / 播放清單 / 演出者 / 專輯**（支援透過 Google App 的 Google Assistant / Gemini 語音操作，尚未在實機驗證），
LAN 可連線時也能播放桌面端的音樂庫。
手機、通知與車載共用**同一個播放器與佇列**，因此手機上的操作會反映到車載，車載上的操作也會反映到手機。

### 安裝

1. 從 [GitHub Releases](https://github.com/tainakanchu/crateforge/releases) 取得 `crateforge-android-<version>.apk`（以及 `.apk.sha256`）。
2. 確認 SHA-256（`sha256sum -c crateforge-android-<version>.apk.sha256`）。簽署憑證可用
   `apksigner verify --print-certs` 確認，必須與 Release 說明中的簽署憑證 SHA-256 一致。
3. 開啟 APK 進行安裝。若 Android 要求**允許從此來源安裝（Android 系統設定）**，請允許。
4. 在手機上先開啟 Crateforge 一次，連線到桌面端，並下載需要的曲目。

### Android Auto 端的設定（與系統權限是不同的設定）

**步驟 3 的系統權限與 Android Auto 的「Unknown sources（未知來源）」是兩個不同的設定。** 只開啟前者，應用程式不一定會出現在車載啟動器中。

1. 開啟手機的 Android Auto 設定（找不到時，請在設定中搜尋「Android Auto」）。
2. 點按最下方的 **「版本」10 次**以啟用開發人員模式。
3. 從右上角的選單開啟 **「開發人員設定（Developer settings）」**，將 **「未知來源（Unknown sources）」** 設為 ON。
4. 重新連接車機（或 DHU），在啟動器或「自訂啟動器」中確認「Crateforge」。

### 更新時的注意事項

- 新的 APK 可直接**覆蓋安裝**（已下載的曲目與設定會保留）。若簽署憑證與先前不同則無法覆蓋。
- **更新後請先在手機上開啟應用程式一次。** 在此之前，車載無法使用 LAN 串流（**已下載的曲目即使不開啟應用程式也能在車載播放**）。
- Android 不再使用 EAS 建置。可從舊的 EAS 版更新到 GitHub 版，但無法反向更新。

### 疑難排解

- **啟動器中沒有出現**：確認 Android Auto 的 Unknown sources 為 ON 且已啟用開發人員模式、重新連線或重啟 Android Auto，以及「自訂啟動器」中是否被隱藏。
- **桌面端的曲目在車載上不顯示 / 無法播放**：更新後是否已開啟應用程式一次、是否在同一個網路、重新發行權杖後是否已重新連線。
- **特定曲目無法播放**（例如 AIFF / CAF 原檔）：請使用 Downloads 畫面的「以 AAC 重新下載」。
- **無法覆蓋安裝**：簽署憑證不同（解除安裝會清除已下載的內容與設定）。

### 已知限制

- 並非像 Google Play 版那樣免手動設定：**需要開啟 Android Auto 的開發人員設定**，且可能因車機、OEM、Android / Android Auto 版本而無法運作。
- **尚未在實機、DHU、實車上驗證**（目前僅完成自動化測試）。結果將記錄於[驗證檢查清單](https://github.com/tainakanchu/crateforge/blob/main/docs/android-auto/verification-checklist.md)。
- 僅允許系統簽署的應用程式、已知的 Google 主機以及 Crateforge 本身控制播放；第三方車載啟動器與 Wear OS 應用程式無法連線。
- 轉換後的 AAC 串流無法搜尋（拖曳進度）。

詳細步驟、驗證方法與維護者的簽署金鑰管理，請參閱[行動端 README](https://github.com/tainakanchu/crateforge/blob/main/clients/apps/mobile/README.md)。

:::note
Android 版如上所述以 GitHub Releases 的 APK 發佈。iOS 版透過 EAS 的 internal distribution 另行配送。
僅 JS 的更新以 OTA（EAS Update）發佈（變更原生設定的更新需要替換 APK）。
:::
