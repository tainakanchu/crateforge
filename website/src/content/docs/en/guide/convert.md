---
title: Format conversion
description: Converting to mp3 / aac / opus / flac / alac / wav with ffmpeg, bitrate, output destination, and adding to the library.
---

You can convert tracks to a different audio format (using ffmpeg). Tags and embedded cover art carry over, and progress is shown.

> Screenshots to be added

## Converting

1. **Right-click** a track (multiple selection supported) and choose **"形式を変換…" (Convert to…)**.
2. Choose the **format, bitrate, and output destination**.
3. If needed, enable "Add to library after conversion."
4. Start the conversion and progress is displayed.

The dialog can be closed with `Esc`, and it supports initial focus and confirming with `Enter`.

## Supported formats

| Format | Type | Notes |
|---|---|---|
| **MP3** | Lossy | Bitrate selectable |
| **AAC** | Lossy | Bitrate selectable |
| **Opus** | Lossy | Bitrate selectable |
| **FLAC** | Lossless | |
| **ALAC** | Lossless | |
| **WAV** | Uncompressed | |

For lossy formats (MP3 / AAC / Opus), you can choose the **bitrate**.

## Output destination and adding to the library

- You can specify an **output folder**.
- If you enable "Add to library," the converted files are imported into the library as-is
  (the converted files stay in the output folder you specified, and the placement rules of the [organize folder](../import/) are not applied).

During conversion, the library's tags and embedded cover art carry over to the new file.

## Convert and replace

**Right-click → "変換して置き換え…" (Convert and replace)** (or pick "置き換え" as the method in the convert dialog) converts next to the original file with the same name and swaps **the same track** (rating, play count, playlists and edited tags stay) to the new file.

- Tags and embedded cover art are carried over from the original file.
- Before swapping, the new file is decoded to the end and its length is checked against the original. A failed track keeps its original file.
- The original file goes to **the trash** (default) or is **kept in the `_replaced` folder** (the last choice is remembered). It is never moved when another track references the same file.
- Tracks already in the target format at the same or a lower bitrate (e.g. MP3 320 → MP3 320) are skipped.
- Lossy to lossy (e.g. AAC → MP3) is allowed, but loses quality, so the count is flagged with ⚠.
- The result shows counts (done / skipped / failed); "詳細" (details) lists the reason per track.

It can also be run from the local API (`POST /api/convert-replace`; see [API server](../api-server/)).

## About ffmpeg

Conversion **uses ffmpeg as an external process**.

- **Windows** — ffmpeg is not bundled; it is **fetched and cached automatically on first use**.
  The resolution order is: cache in `%LOCALAPPDATA%` → (legacy bundled resource) → PATH → if none, download from upstream (BtbN). ffmpeg is retained even when you update the app.
- **macOS / Linux** — uses the **ffmpeg on your PATH** (please install it separately).

:::note
Because ffmpeg is GPL-licensed, we avoid bundling it and use it as a CLI in an external process.
:::
