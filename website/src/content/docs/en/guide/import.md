---
title: Library import
description: Importing iTunes / Music Library.xml, importing folders and files, and auto-exporting iTunes-compatible XML.
---

You can import a library into Crateforge from either the **iTunes / Music `Library.xml`** or your **own music files**.

> Screenshots to be added

## Importing the iTunes / Music Library.xml

From **"📥 Import XML"** in the toolbar, select an `iTunes Library.xml` (Apple plist format).

- It is read with a streaming SAX parser, so even large libraries import fast.
- The import uses streaming parsing and reproduces tracks, playlists, and the **folder hierarchy** (Persistent ID / Parent Persistent ID).
- The import is performed as a **full replacement of the library** (merging diffs into an existing XML is not supported).

:::note
Smart Playlist criteria (`Smart Info`) are **not preserved** on either import or export.
You can recreate imported Smart Playlists with Crateforge's [Smart Playlist](../smart-playlists/) feature.
:::

### Where the Library.xml is

- **macOS** — Enabling "Share XML" in the Music app's preferences exports it (on older iTunes, `~/Music/iTunes/iTunes Library.xml`).
- **Windows** — Usually `%USERPROFILE%\Music\iTunes\iTunes Library.xml`.

## Importing music files

With **"🎵 Add Files"** in the toolbar, you can import your own music files directly (multiple selection supported).

- Supported formats: **FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF** and more.
- Tags (title / artist / album / genre / year, etc.) are read with `lofty`.
- The **BPM tag** (TBPM / tmpo / Vorbis BPM) is also read on import.

## Importing whole folders (Add Folder / drag and drop)

Pick a folder with **"Add Folder"** in the toolbar (inside the ⋯ menu when the window is narrow) and it
**walks subfolders recursively**, importing every supported file it finds. **Dragging and dropping** onto the window
goes through the same path, so you can drop a mix of files and folders.

- Only files with a supported extension are imported (everything else is ignored).
- **Hidden files and folders (starting with `.`) are skipped** (`.DS_Store` and friends).
  Files you point at explicitly are imported even if they are hidden.
- **Files already in the library (same path) are skipped**, so dropping the same folder again never creates duplicates.
- Symlink loops are detected and cut off, and unreadable folders are skipped so the rest still imports.
- The result is shown as a toast: how many were imported, how many were skipped as already imported, and how many failed.
- Imported tracks land in the **Inbox** in the sidebar, where you can [rate them and add them to the Crate](../playback/).

### Organize folder (auto-organize)

If you set an "organize folder (library root)" in settings, files are placed under
`<organize folder>/<album artist>/<album>/` with iTunes-style renaming on import and edit.

Using **"Auto-detect"** in settings infers the organize folder from the paths of existing tracks and sets it.

## Writing tags back to files

When you edit a track (Get Info / `Ctrl + I`), Crateforge updates the database **and writes the tags back to the
actual file (ID3 / Vorbis / MP4)**. No organize folder is required — **tags are written back even when it is not set**
(when it is set, the file is also moved and renamed into place).

The write-back includes the following as well.

- **BPM** — written as an integer to TBPM (ID3v2) / tmpo (MP4) / `BPM` (Vorbis Comments).
  The track's own BPM takes priority, falling back to the [analysis](../dj-analysis/) result.
- **Key** — written to **InitialKey** (ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY) in musical notation
  (`Am` / `F#m` / `C`), not Camelot, because that is what rekordbox / Serato / Traktor read.

:::note
Key is not written to the iTunes-compatible XML (Apple's plist schema has no standard element for it).
It reaches other software through the InitialKey file tag instead. BPM is included in the XML as well.
:::

## Deleting tracks / revealing files

Right-click a track for the following actions.

- **"Finder / エクスプローラで表示" (Reveal in file manager)** — opens the track's file in your OS file manager
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

## Exporting iTunes-compatible XML

With **"📤 Export XML"** in the toolbar, you can export an `iTunes Library.xml` (Apple plist format).
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

From **"💿 Rip CD"** in the toolbar, you can import a physical CD (track info is fetched automatically from MusicBrainz, and cover art from the Cover Art Archive).

1. Enter the **Drive** and click "🔍 Detect Disc" (defaults are Linux: `/dev/cdrom`, macOS: `disk1`, Windows: `D:`; on Linux you can also type `/dev/sr0` and the like manually)
2. The TOC is read and candidate albums from MusicBrainz are displayed automatically
3. Re-pick the release if needed, and select the tracks
4. Specify the **Format** (FLAC / ALAC / MP3 / WAV) and the **Output** folder, then click "▶ Start Ripping"
5. When done, it is added to the library automatically (when the option is on)

:::caution
Under WSL2, a physical CD isn't visible directly, so you need to attach the drive to WSL2 with `usbipd-win`.
The Windows build does not bundle `discid` (libdiscid), but "Detect Disc" still works because it reads the TOC directly via the OS IOCTL and computes the MusicBrainz Disc ID in-house. Entering the TOC manually is a fallback for environments where neither libdiscid nor IOCTL is available.
:::
