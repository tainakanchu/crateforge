---
title: 安裝
description: 關於 Crateforge 的下載、首次啟動、應用程式內自動更新與捷徑建立。
---

Crateforge 支援 Windows / macOS / Linux。最新版可從 GitHub 的
[Releases](https://github.com/tainakanchu/crateforge/releases/latest) 取得。

> 截圖稍後補上

## 下載與發佈形式

| OS | 發佈形式 | 備註 |
|---|---|---|
| **Windows** | 單一 `.exe` / 可攜式 `.zip` / `.msi` / 安裝程式 `.exe` | 支援應用程式內自動更新 |
| **macOS** | `.dmg`（Apple Silicon 原生） | **未簽署**。首次需繞過 Gatekeeper |
| **Linux** | `.AppImage`（單一檔案） / `.deb` | |

### Windows

- **安裝版（安裝程式 `.exe` / `.msi`）** — 一般安裝方式。
  從安裝程式 **建立桌面捷徑的選項預設為關閉**（如有需要，請於安裝時啟用）。
- **可攜版（`.zip`）** — 解壓縮後直接執行 `crateforge.exe` 即可，無需安裝。

無論哪一種版本，應用程式內更新通常都 **只需就地替換 exe 並重新啟動**，所以速度很快，
也不會跳出 SmartScreen 警告（v0.6.3 起）。

:::caution
**更新到 v0.12.0 會經由安裝程式進行。** 此版本變更了 exe 之外的部分（應用程式的權限設定 / capabilities），
僅就地替換並不足夠。應用程式內更新會自動下載並啟動安裝程式，請依畫面指示進行
（可攜版仍照舊以替換 zip 的方式更新）。
:::

### macOS

由於未簽署，首次啟動時會出現 Gatekeeper 警告。請以下列任一方式繞過。

- 在 Finder 中 **右鍵點選 `.app` →「開啟」**
- 或在終端機執行 `xattr -cr /Applications/Crateforge.app`

### Linux

- `.AppImage` 需賦予執行權限後啟動（`chmod +x ./Crateforge*.AppImage && ./Crateforge*.AppImage`）。
- `.deb` 以套件管理員安裝。

## 首次啟動

1. 啟動應用程式後會開啟一個空的音樂庫。
2. 若你已有既有的 `iTunes Library.xml`，請用工具列的 **「📥 Import XML」** 匯入（[音樂庫匯入](../import/)）。
3. 若沒有 XML，也可用 **「🎵 Add Files」** 直接匯入手邊的音樂檔案。

由於音樂庫的真實資料常駐於 SQLite (WAL)，首次匯入後，往後再開啟都會很快。

## 應用程式內自動更新

當有新的 GitHub Release 發佈時，會在視窗上方以 **非阻斷式橫幅** 通知你。
發行說明（日英對照）可用摺疊方式檢視。

套用更新時有以下選擇。

- **立即更新** — 下載後就地套用並重新啟動。
- **關閉時更新** — 現在繼續使用，並 **在關閉視窗時自動套用**（啟動時不會中斷你的工作）。

:::caution
應用程式內的自動更新 **僅限 Windows**。macOS / Linux 請從 [Releases](https://github.com/tainakanchu/crateforge/releases/latest)
手動下載並替換。
:::

## 音樂庫備份

解析結果、略過次數、智慧型播放清單的條件、同步狀態等，都不包含在 iTunes 相容 XML 之中。
包含這些資料的音樂庫本體（`library.db`），可在設定的
**「一般」→「ライブラリのバックアップ」（音樂庫備份）** 中操作。

- **今すぐバックアップ（立即備份）** — 保存整個 `library.db`（可指定保存位置）。
- **バックアップから復元…（從備份還原…）** — 以選取的備份檔取代目前的音樂庫。
  還原前會自動進行完整性檢查，損壞的檔案不會覆蓋現有音樂庫。
- **整合性チェック（完整性檢查）** — 檢查 `library.db` 是否損壞（`PRAGMA integrity_check`）。
- **最適化 (VACUUM)（最佳化）** — 回收已刪除資料佔用的磁碟空間並重新整理檔案。
  曲目數量很多時可能需要數秒到數十秒。
- **自動エクスポート時にあわせてバックアップ（自動匯出時一併備份）**（預設開啟）— 在 iTunes 相容 XML 的
  [自動匯出](../import/)成功時，一併備份 `library.db`。
  自動備份會保留 **最近 5 筆**，且距離上次未滿 30 分鐘時會略過。

:::caution
還原是取代音樂庫的操作，且無法復原（會顯示確認對話框）。
此外，權杖等部分狀態只在啟動時讀取，因此 **還原後必須重新啟動應用程式**。
:::

## 捷徑（桌面）

Windows 的安裝程式 **預設不會建立桌面捷徑**。
如有需要，請於安裝時的選項中啟用。
