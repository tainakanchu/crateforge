---
title: 播放、佇列、Crate
description: 本機播放、Up Next 佇列、DJ 選曲用的 Crate、Audition / Preview、Inbox / Triage、Set Workspace 與 Gig Readiness。
---

Crateforge 支援本機播放（rodio + symphonia），可直接解碼各種格式。
在右側欄（選曲工作台）的 **Now Playing / Up Next / Crate / Similar** 組建播放與選曲。

> 截圖稍後補上

## 進行播放

- **雙擊** 曲目即可播放。
- `Space` 為 **播放 / 暫停**，`Enter` 播放焦點/選取列。
- `J` / `K` 為上一首 / 下一首，`Shift + ←` / `Shift + →` 為 5 秒搜尋。
- `S` 為隨機播放，`R` 為重複播放（關閉 / 全部 / 單曲）。`Ctrl + ↑` / `Ctrl + ↓` 為音量。

在播放器列中，可拖曳搜尋列進行 scrub，點選時間顯示可切換「已經過 ⇄ 剩餘」，
音量列有滑塊與 % 顯示。波形以解析峰值的實際波形繪製。

曲目的自動接續由 **Rust 端的工作執行緒** 驅動。即使將視窗最小化播放仍會持續，
若找不到下一首的檔案，會自動跳過並繼續播放。
播放失敗的曲目會以 toast 通知，並將失敗內容（檔案不存在 / 解碼失敗 / 解碼器當機）
記錄到 `crateforge.log`。

隨機播放 / 重複播放的切換，會在播放引擎套用完成後才反映到畫面上
（避免 Up Next 顯示過期的順序）。切換失敗時不會變更狀態，並以錯誤通知。
從[行動裝置 / 遙控器](../mobile/)變更 `shuffle` / `repeat` / `volume` 時，桌面端的顯示也會同步。

### ReplayGain

可在設定中切換 ReplayGain（逐曲音量正規化，以 −18 LUFS 為基準）。

## Audition / Preview（試聽）

按 `A` 進入 **Audition 模式** 後，波形會變高並顯示 25 / 50 / 75% 的標記，可快速在曲目內來回移動。

- `1` / `2` / `3` 跳至 **25% / 50% / 75%** 位置，`Home` 跳至開頭，`End` 跳至尾段（結尾 −3 秒）。
- `Alt + ←` / `Alt + →` 為 ±15 秒。
- 從右側欄 Crate / Similar 的列，可在不破壞佇列的情況下就地開始 **Preview**。
- `Esc` 會結束 Preview，並 **回到原本的曲目與播放位置**。即使 Preview 播到曲目結尾，
  也不會前往下一首，而是回到原本的位置。

**以 Preview 聽過的部分不會計入播放次數、略過次數與最近播放**，可以在不弄髒統計的情況下試聽。

播放器列的 **AUDITION / PREVIEW 徽章可點選解除**（與 `A` / `Esc` 相同）。
Audition 模式僅限本次工作階段，不會延續到下次啟動。

## Up Next（播放佇列）

右側欄的 **Up Next** 即接下來會播放的佇列。

- 透過內容選單的 **「Play Next（接著播放）」**，可將選取的曲目（可多選、保持選取順序）
  插入正在播放曲目的緊接之後。
- 用列懸停時出現的 **「×」** 可從佇列移除，**拖放** 可重新排序。
- 標頭會顯示 **件數、總時間、隨機播放徽章**。
- 隨機播放會事先計算實際的播放順序（排列），因此 Up Next 會直接反映接下來實際播放的順序。
  切換隨機播放後，Up Next 也會立即更新為新的順序。

## 右側欄（選曲工作台）

右側欄由 **Now / Up Next** 與 **Crate / Similar** 兩組分頁構成。

- 拖曳左緣可 **調整寬度**（280〜560px），雙擊可還原為預設（348px）。寬度會被保存。
- **Split** 按鈕可將 Crate 與 Similar 上下同時顯示。Split **只在 Crate / Similar 分頁有效**，
  在 Now / Up Next 分頁會顯示為停用。
- **分頁不會擅自切換**。把曲目加入 Crate 或執行「Find similar」時，你正在看的分頁會保持不變。
  取而代之的是 **Crate 分頁會顯示件數徽章**，**Similar 分頁會以圓點** 表示已釘選基準曲。
  （內容選單的「Find similar」與 `Ctrl/Cmd + Shift + S` 屬於明確操作，因此仍會移動到 Similar 分頁。）
- `Ctrl + ]` 可顯示右側欄，`Ctrl + 1`〜`4` 可切換到 Now / Up Next / Crate / Similar 分頁。

## Crate（DJ 選曲）

右側欄的 **Crate** 是用來組建選曲初稿的暫存區。

- 把曲目逐一加入 Crate，湊齊後可 **「儲存為播放清單」**。
  `Ctrl + Shift + C` 可整批加入選取曲目，也可以把清單的列拖曳到 Crate。
- 以 **smooth（平滑排序）** 按鈕，可根據解析值以貪婪最近鄰自動排序成順暢的流動。
- 每一列都可執行 Preview / Find Similar / Play next / 從這裡播放 / 從 Crate 移除。

### Set Workspace（Anchor / Section / Arc / Lint）

Crate 同時也是 **一整套演出的設計台**（不會變更資料庫，內容會在下次啟動時還原）。

- 可為這一套設定 **名稱、目標長度（分鐘）、備註**，並顯示實際總長度與目標的差距。
- **Anchor** — 點選列上的徽章可設定 `Lock` / `Opening` / `Peak` / `Closing`。
  設有 Anchor 的曲目在 smooth 排序時位置也會固定。
- **Section** — 可插入 `Opening` / `Build` / `Peak` / `Reset` / `Closing` 等區段界線。
  smooth 排序不會跨越 Section 的界線。
- **Set tools（Arc / Lint）** — Arc 會以圖表顯示 BPM / Energy 的起伏。
  Lint 則在不做任何破壞性變更的前提下列出結構上的提醒（同一演出者過於接近、重複、BPM 大幅跳動、
  Energy 落差、和聲不相容、檔案不存在 / 未解析、評分過低、目標長度過長或不足、
  Opening / Closing 的矛盾）。個別警告可以隱藏。

### Gig Readiness（演出前檢查）與 Snapshot

從 Crate 標頭的 **「Ready?」**，可在一個畫面確認 Crate 或目前顯示之播放清單的準備狀況。

- **阻斷項目**：沒有曲目 / 找不到檔案的曲目
- **警告**：未解析的曲目 / 重複 / 目標長度過長或不足 / Set Lint 的提醒 / 自動匯出的狀態
- **Snapshot** — 可保存當下的內容與判定結果，之後再回顧（最多 20 筆）。
- 從 **Prepare** 可開啟[同步對話框](../api-server/)，繼續進行帶出用的準備。

:::tip
預期的流程是：用[相似度選曲](../dj-analysis/)（Similar 分頁）或 [AI 選曲](../api-server/)（dj-curator）蒐集候選，
在 Crate 做成初稿，最終的曲序再用 GUI 細修。
:::

## Inbox / Triage（整理剛匯入的曲目）

側邊欄的 **Inbox** 會集中剛匯入的曲目與未評分的曲目（件數以徽章顯示）。

- 會列入 Inbox 的是 **最近 14 天內加入的曲目**、**未評分（無★）的曲目**，以及標記為 **「稍後」** 的曲目
  （候選取自最近加入的 500 筆視窗加上「稍後」的曲目，因此音樂庫很大時也能輕快開啟）。
- 在 Inbox 按 `T` 即可進入 **Triage 模式**，只用鍵盤逐曲處理。

| 按鍵 | 操作 |
|---|---|
| `Space` | 預覽播放 / 暫停 |
| `J` / `↓` | 下一首 |
| `K` / `↑` | 上一首 |
| `1`〜`5` | 評分 |
| `C` | 加入 Crate |
| `D` / `Enter` | 標記為已處理並前往下一首 |
| `S` | 稍後（保留在 Inbox） |
| `Esc` | 結束 Triage 並回到 Inbox 清單 |

Triage 的試聽屬於 Preview，因此不會弄髒播放次數。
「已處理 / 稍後」的狀態保存在應用程式內，不會變更資料庫的結構。

## Now Playing（BPM / Key / Energy）

右側欄的 **Now Playing** 會與正在播放曲目的封面圖一起顯示 **Album / Artist / Genre / BPM / Key / Energy**。
BPM、Key (Camelot)、Energy 會在已[解析](../dj-analysis/)的曲目上顯示，可用於判斷銜接。

在 **Similar** 分頁中，會針對正在播放（或右鍵 →「Find similar」）的曲目，
提示 Camelot 鍵相容 + 節奏相近的「下一手」。
關於如何繼續深掘，請參閱[相似度選曲（Similar Digging）](../dj-analysis/)。
