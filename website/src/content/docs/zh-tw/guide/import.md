---
title: 音樂庫匯入
description: iTunes / Music 的 Library.xml 匯入、資料夾與檔案匯入、iTunes 相容 XML 的自動匯出。
---

要將音樂庫匯入 Crateforge，可從 **iTunes / Music 的 `Library.xml`** 或 **手邊的音樂檔案** 任一方式進行。

> 截圖稍後補上

## 匯入 iTunes / Music 的 Library.xml

從工具列的 **「📥 Import XML」** 選取 `iTunes Library.xml`（Apple plist 格式）。

- 採用串流 SAX 剖析器讀取，即使是大型音樂庫也很快。
- 匯入透過串流解析進行，重現曲目、播放清單、**資料夾階層**（Persistent ID / Parent Persistent ID）。
- 匯入會以 **整個音樂庫的取代** 方式進行（尚不支援對既有 XML 的差異合併）。

:::note
智慧型播放清單的判定條件（`Smart Info`）在讀取與匯出時 **皆不會保留**。
匯入的智慧型播放清單可用 Crateforge 的[智慧型播放清單](../smart-playlists/)功能重新建立。
:::

### Library.xml 的位置

- **macOS** — 在「音樂」應用程式的偏好設定中啟用「共享 XML」即可匯出（舊版 iTunes 為 `~/Music/iTunes/iTunes Library.xml`）。
- **Windows** — 通常位於 `%USERPROFILE%\Music\iTunes\iTunes Library.xml`。

## 匯入音樂檔案

從工具列的 **「🎵 Add Files」**，可直接匯入手邊的音樂檔案（可多選）。

- 支援格式：**FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF** 等。
- 以 `lofty` 讀取標籤（標題 / 演出者 / 專輯 / 類型 / 年份 等）。
- 匯入時也會讀取 **BPM 標籤**（TBPM / tmpo / Vorbis BPM）。

## 整個資料夾匯入（Add Folder / 拖放）

從工具列的 **「Add Folder」**（視窗較窄時會在 ⋯ 選單中）選擇資料夾後，會 **連子資料夾一併遞迴掃描**，
把支援格式的檔案整批匯入。往視窗 **拖放** 也是同一條路徑，可以把檔案與資料夾混在一起丟進來。

- 只會匯入支援副檔名的檔案（其餘會被忽略）。
- **隱藏檔案 / 隱藏資料夾（以 `.` 開頭）會被略過**（例如 `.DS_Store`）。
  但你自己明確指定的檔案，即使是隱藏檔也會匯入。
- **已經在音樂庫中的檔案（相同路徑）會被略過**，同一個資料夾丟幾次都不會重複登錄。
- 符號連結的迴圈會被偵測並中止；讀不到的資料夾會跳過並繼續。
- 結果會以 toast 顯示「匯入的件數 / 因已匯入而略過的件數 / 失敗的件數」。
- 匯入的曲目會累積在側邊欄的 **Inbox**，可以從那裡[評分與加入 Crate](../playback/)。

### 整理目標資料夾（音樂庫根目錄）（自動整理）

在設定中指定「整理目標（音樂庫根目錄）」後，匯入與編輯時會將檔案以 iTunes 慣例的命名方式
放置到 `<整理目標>/<專輯演出者>/<專輯>/`。

使用設定中的 **「自動偵測」**，可從既有曲目的路徑推測並設定整理目標。

## 標籤寫回檔案

編輯曲目（Get Info / `Ctrl + I`）時，除了更新資料庫，也會 **寫回實體檔案的標籤（ID3 / Vorbis / MP4）**。
不需要設定整理目標資料夾，**即使未設定也會寫回標籤**（只有在有設定時才會另外進行資料夾搬移與重新命名）。

寫回的內容還包含以下項目。

- **BPM** — 以整數寫入 TBPM（ID3v2）/ tmpo（MP4）/ `BPM`（Vorbis Comments）。
  優先採用曲目自身的 BPM，未設定時則採用[解析](../dj-analysis/)結果。
- **Key** — 寫入 **InitialKey**（ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY），
  使用的是音樂記法（`Am` / `F#m` / `C` 等）而非 Camelot，因為 rekordbox / Serato / Traktor 讀的正是這種記法。

:::note
iTunes 相容 XML 不會寫出 Key（Apple 的 plist schema 沒有代表調性的標準元素）。
Key 會透過檔案標籤的 InitialKey 傳遞給其他軟體。BPM 則同時也包含在 XML 中。
:::

## 從音樂庫刪除曲目 / 開啟檔案位置

在曲目上按右鍵，可進行以下操作。

- **「Finder / エクスプローラで表示」（在檔案管理員中顯示）** — 以作業系統的檔案管理員開啟該曲目的檔案
  （macOS 會在 Finder 中選取，Windows 會在檔案總管中選取，Linux 則開啟上層資料夾）。
- **「ライブラリから削除…」（從音樂庫刪除…）** — 將選取的曲目從音樂庫（資料庫）刪除。
  在確認對話框中勾選 **「連檔案一起刪除」**，也可以刪除實體檔案。
  正在播放或已排入佇列的曲目會停止播放並從佇列移除。

:::caution
刪除實體檔案 **僅限位於整理目標資料夾（音樂庫根目錄）之內的檔案**，而且不會送到垃圾桶，是直接刪除。

- 未設定整理目標資料夾時無法選擇「連檔案一起刪除」（只會從資料庫刪除）。
- 選取的曲目中只要有一個位於整理目標資料夾之外，就會 **一個檔案都不刪除** 並回報錯誤。
  此時請取消勾選，只從音樂庫（資料庫）刪除。
:::

## 匯出 iTunes 相容 XML

從工具列的 **「📤 Export XML」**，可匯出 `iTunes Library.xml`（Apple plist 格式）。
可交給 rekordbox / Serato / Traktor 等能讀取 iTunes XML 的 DJ 軟體。

匯出的 XML 包含以下內容。

- `Major/Minor Version` / `Date` / `Application Version` / `Library Persistent ID` 標頭
- `Tracks` 字典（Track ID 鍵，所有欄位）
- `Playlists` 陣列（依 Persistent ID / Parent Persistent ID 的資料夾階層，以 `Playlist Items` 參照 trackId）
- 字串會將 `&` `<` `>` 以數值字元參照跳脫，檔案路徑則 percent-encode 為 `file://` URL

### 自動匯出

將工具列的 **🕐 切換鈕** 開啟後，會在 **僅在有變更時、約每 30 分鐘一次＋結束時** 自動匯出
Library XML。想要隨時把最新的音樂庫交給 DJ 軟體時很方便。

自動匯出成功時，也會一併自動備份 `library.db`
（可在設定的[音樂庫備份](../install/)中切換）。

## 從 CD 匯入（擷取）

從工具列的 **「💿 Rip CD」**，可匯入實體 CD（以 MusicBrainz 取得曲目資訊、以 Cover Art Archive 自動取得封面）。

1. 輸入 **Drive** 並按「🔍 Detect Disc」（預設為 Linux：`/dev/cdrom`、macOS：`disk1`、Windows：`D:`。Linux 也可直接輸入 `/dev/sr0` 等）
2. 讀取 TOC 後，自動顯示 MusicBrainz 的候選專輯
3. 視需要重新選擇發行版本，並選取曲目
4. 指定 **Format**（FLAC / ALAC / MP3 / WAV）與 **Output** 資料夾後按「▶ Start Ripping」
5. 完成後自動加入音樂庫（選項開啟時）

:::caution
WSL2 無法直接看到實體 CD，因此需用 `usbipd-win` 將光碟機 attach 到 WSL2。
Windows 組建未隨附 `discid`（libdiscid），但會使用 OS 的 IOCTL 直接讀取 TOC、並在應用程式端算出 MusicBrainz Disc ID，因此「Detect Disc」在 Windows 上也能運作（手動輸入 TOC 為備援方式）。
:::
