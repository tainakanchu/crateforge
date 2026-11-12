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

## About ffmpeg

Conversion **uses ffmpeg as an external process**.

- **Windows** — ffmpeg is not bundled; it is **fetched and cached automatically on first use**.
  The resolution order is: cache in `%LOCALAPPDATA%` → (legacy bundled resource) → PATH → if none, download from upstream (BtbN). ffmpeg is retained even when you update the app.
- **macOS / Linux** — uses the **ffmpeg on your PATH** (please install it separately).

:::note
Because ffmpeg is GPL-licensed, we avoid bundling it and use it as a CLI in an external process.
:::
