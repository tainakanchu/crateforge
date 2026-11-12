---
title: Library import
description: Importing iTunes / Music Library.xml, importing folders and files, and auto-exporting iTunes-compatible XML.
---

You can import a library into Crateforge from either the **iTunes / Music `Library.xml`** or your **own music files**.

> Screenshots to be added

## Importing the iTunes / Music Library.xml

From **"iTunes XML を取り込む" (Import iTunes XML)** in the toolbar, select an `iTunes Library.xml` (Apple plist format).

- It is read with a streaming SAX parser, so even large libraries import fast.
- The import uses streaming parsing and reproduces tracks, playlists, and the **folder hierarchy** (Persistent ID / Parent Persistent ID).
- The import is performed as a **full replacement of the library** (merging diffs into an existing XML is not supported).

:::note
iTunes Smart Playlists are imported by converting their criteria (`Smart Criteria` / `Smart Info`) into
Crateforge [Smart Playlist](../smart-playlists/) rules (including "Playlist is", nested rule groups and item limits).
Rules that cannot be converted, such as relative dates ("in the last N days"), are dropped; if no rule remains,
the playlist is kept as a static snapshot instead. Exported XML contains the evaluated track list (the criteria themselves are not exported).

For a library you have already imported, **"iTunes XML からスマートプレイリストを復元…" (restore smart playlists from iTunes XML)** in the toolbar sets the criteria again
without re-importing the XML (also select an older library XML to resolve references to old IDs by name).
:::

### Where the Library.xml is

- **macOS** — Enabling "Share XML" in the Music app's preferences exports it (on older iTunes, `~/Music/iTunes/iTunes Library.xml`).
- **Windows** — Usually `%USERPROFILE%\Music\iTunes\iTunes Library.xml`.

## Importing music files

With **"ファイルを追加" (Add Files)** in the toolbar, you can import your own music files directly (multiple selection supported).

- Supported formats: **FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF** and more.
- Tags (title / artist / album / genre / year, etc.) are read with `lofty`.
- The **BPM tag** (TBPM / tmpo / Vorbis BPM) is also read on import.

## Importing whole folders ("フォルダを追加" (Add Folder) / drag and drop)

Pick a folder with **"フォルダを追加" (Add Folder)** in the toolbar (inside the ⋯ menu when the window is narrow) and it
**walks subfolders recursively**, importing every supported file it finds. **Dragging and dropping** onto the window
goes through the same path, so you can drop a mix of files and folders.

- Only files with a supported extension are imported (everything else is ignored).
- **Hidden files and folders (starting with `.`) are skipped** (`.DS_Store` and friends).
  Files you point at explicitly are imported even if they are hidden.
- The **`_replaced` folder** (where replaced files are moved) **is skipped too**, so backed-up files never show up as candidates.
- If a track is already in the library under another path, or **the file being imported looks corrupted (e.g. its tail is zero-filled)**,
  a confirmation dialog opens before importing. You can choose import / skip / replace per track, or use bulk actions such as "すべて取り込む" (import all).
  Suspected-corrupt files are skipped by default. The dialog does not close on a background click (use "取り込みをキャンセル" (cancel import) to abort). Pressing Esc asks "取り込みをキャンセルしますか？" (cancel the import?) first.
- **Files already in the library (same path) are skipped**, so dropping the same folder again never creates duplicates. The same file reached through a different spelling of the path (e.g. via a symlink) counts as the same file, even with "すべて取り込む" (import all).
- Symlink loops are detected and cut off, and unreadable folders are skipped so the rest still imports.
- The result is shown as a toast: how many were imported, how many were skipped as already imported, and how many failed.
- Imported tracks land in the **Inbox** in the sidebar, where you can [rate them and add them to the Crate](../playback/).

### Organize folder (auto-organize)

If you set an "organize folder (library root)" in settings, files are placed under
`<organize folder>/<album artist>/<album>/` with iTunes-style renaming on import and edit.

Using **"Auto-detect"** in settings infers the organize folder from the paths of existing tracks and sets it.

## Writing tags back to files

When you edit a track ("情報を見る / 編集" (Get Info / Edit) / `Ctrl + I`), Crateforge updates the database **and writes the tags back to the
actual file (ID3 / Vorbis / MP4)**. No organize folder is required — **tags are written back even when it is not set**
(when it is set, the file is also moved and renamed into place).

The write-back includes the following as well.

- **BPM** — written as an integer to TBPM (ID3v2) / tmpo (MP4) / `BPM` (Vorbis Comments).
  The track's own BPM takes priority, falling back to the [analysis](../dj-analysis/) result.
- **Key** — written to **InitialKey** (ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY) in musical notation
  (`Am` / `F#m` / `C`), not Camelot, because that is what rekordbox / Serato / Traktor read.
  A [manually overridden](../dj-analysis/) key takes precedence; otherwise the analyzed key is used.

:::note
Key is not written to the iTunes-compatible XML (Apple's plist schema has no standard element for it).
It reaches other software through the InitialKey file tag instead. BPM is included in the XML as well.
:::

## Deleting tracks / revealing files

Right-click a track for the following actions.

- **"Finder で表示" / "エクスプローラーで表示" / "ファイルマネージャで表示" (Reveal in file manager; the label follows your OS)** — opens the track's file in your OS file manager
  (selected in Finder on macOS, selected in Explorer on Windows, and the parent folder on Linux).
- **"ライブラリから削除…" (Delete from library…)** — removes the selected tracks from the library (the database).
  In the confirmation dialog you can also check **"delete the files too"** to remove the actual files.
  If a deleted track was playing or queued, playback stops and it is removed from the queue.

:::caution
Deleting actual files is **limited to files inside the organize folder (library root)**. Files are removed directly, not sent to the trash.

- When no organize folder is set, "delete the files too" cannot be selected (only the database entries are removed).
- If even one selected track lives outside the organize folder, the operation fails **without deleting any file**.
  Uncheck the box in that case and remove the tracks from the library (database) only.
:::

## Fixing missing files (broken links)

Tracks whose files can no longer be found — because an external drive or NAS was disconnected, or the files were
moved in Finder — are shown as missing ("見つかりません").

- **"リンク切れを再チェック" (Re-check missing files)** (on the right of the toolbar, or inside the **⋯** menu
  when the window is narrow) — checks again whether every track's file still exists. Tracks whose files have
  disappeared become missing, and tracks whose files are back (for example after reconnecting the drive) return
  to normal. Progress and the result ("N 曲のファイルが見つかりません" — N files not found) are shown below the toolbar.
- Type **`missing:yes`** in the search box to list only the missing tracks (`missing:no` lists tracks whose files exist).
- Right-click a track → **"ファイルの場所を指定…" (Locate file…)** (single selection) — pick the file at its new
  location in the file dialog and the track is repointed to it. Play counts, ratings, playlists and analysis
  results are kept. You can repoint tracks that are not missing, too.

## Exporting iTunes-compatible XML

With **"iTunes XML に書き出し" (Export iTunes XML)** in the toolbar, you can export an `iTunes Library.xml` (Apple plist format).
You can hand it to DJ software that reads iTunes XML, such as rekordbox / Serato / Traktor.

The exported XML includes the following.

- `Major/Minor Version` / `Date` / `Application Version` / `Library Persistent ID` headers
- A `Tracks` dictionary (Track ID keys, all fields)
- A `Playlists` array (folder hierarchy via Persistent ID / Parent Persistent ID, with `Playlist Items` referencing trackId)
- Strings escape `&` `<` `>` as numeric character references, and file paths are percent-encoded into `file://` URLs

### Auto-export

Turning on the **🕐 toggle** in the toolbar automatically exports the Library XML **only when there have been changes, roughly every 30 minutes plus on exit**.
This is handy when you always want to keep your DJ software fed with the latest library.

When an auto-export succeeds, `library.db` is backed up along with it
(toggle it under [library backups](../install/) in settings).

## Importing from a CD (ripping)

From **"CD を取り込む" (Rip CD)** in the toolbar, you can import a physical CD (track info is fetched automatically from MusicBrainz, and cover art from the Cover Art Archive).

1. Choose the **Drive** and click "🔍 Detect Disc". Connected CD drives (e.g. `E:` on Windows, `/dev/sr0` / `/dev/cdrom` on Linux) are listed automatically, and the drive that was last read successfully is remembered as the next default. If yours isn't listed, pick "その他…" (Other) to type it manually (fallback defaults when nothing is detected: Linux: `/dev/cdrom`, macOS: `disk1`, Windows: `D:`)

   While the app is running, CD drives are watched automatically: inserting a disc shows a "CD を検出しました" (CD detected) dialog, and clicking "取り込む" (Import) opens Rip CD with that drive selected.
2. The TOC is read and candidate albums from MusicBrainz are displayed automatically
3. Re-pick the release if needed, and select the tracks
4. Specify the **Format** (FLAC / ALAC / MP3 / WAV) and the **Output** folder, then click "▶ Start Ripping"
5. While ripping, a progress card appears at the bottom right (above the player bar), showing an overall progress bar, "track n / total", the current track, and the stage (reading / encoding). Click it (or press Enter) to open the log
6. When done, it is added to the library automatically (when the option is on). A short chime plays on completion (a lower tone on failure); you can turn it off in **Settings → General → "CD rip completion sound"** (labeled 「CD 取り込みの完了音」 in the UI)

:::caution
Under WSL2, a physical CD isn't visible directly, so you need to attach the drive to WSL2 with `usbipd-win`.
The Windows build does not bundle `discid` (libdiscid), but "Detect Disc" still works because it reads the TOC directly via the OS IOCTL and computes the MusicBrainz Disc ID in-house. Entering the TOC manually is a fallback for environments where neither libdiscid nor IOCTL is available.
:::

## Using your tracks on a CDJ

Playlists of the tracks you imported can be exported to a USB stick for CDJ / XDJ players, optionally with your Traktor cues and grids. See [USB export (CDJ / rekordbox-compatible)](../usb-export/).
