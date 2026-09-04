---
title: Mobile
description: Connecting the mobile client (QR / manual), browsing, on-device and background playback, remote, and offline download / browsing / playback.
---

The Crateforge mobile client lets you browse and play your desktop library through the [built-in API server](../api-server/).
Even when not connected to the server, you can browse and play downloaded content.

> Screenshots to be added

## Connecting

On the desktop side, enable **"Expose on LAN"** for the built-in API server.
From mobile, connect in one of the following ways.

- **QR code** — scan the QR of the connection URL shown in settings to connect.
- **Manual entry** — type in the connection URL and token.

(Pairing is a feature for the Android TV client; the mobile app connects via QR / manual entry.)

## Browsing

While connected, you can browse the desktop library in the following units.

- **Tracks / playlists / albums / artists**
- Search and filtering by genre
- **Artwork** display
- When opening an album, the track order is **disc number → track number**
- Opening an artist lists their albums, sorted by album artist
- How artists are grouped can be switched in settings (**album artist / artist**)

## On-device and background playback

- Choosing "Play on this device" plays on the mobile device (**background playback** supported).
- **Shuffle now decides a play order (a permutation) up front.** No track repeats within a pass, and the
  **Up Next** list on the player screen shows exactly what will play next.
  Pressing "previous" right after skipping forward returns to the same track.
- Turning shuffle on shuffles **only what comes after the current position**; turning it off restores the natural order
  (in both cases the currently playing track keeps playing).
- **Shuffle and repeat are stored on the device and carried over to the next launch.**
- Streaming supports client-oriented parameters.
  - `?native=1` — formats the device can play are served without conversion (ALAC / FLAC, etc. stay lossless)
  - `?original=1` — always the original
  - `?fmt=aac&br=N` — re-encode to AAC-LC (to save space for offline storage)

## Remote

Switching to "Play on PC (remote)" lets you control desktop playback from mobile.
You can do play / pause, previous/next, seek, volume, and shuffle / repeat, and the playing state stays in sync.
Tapping the playing artist (and album) navigates to that page.

## Offline download / browsing / playback

Once you download tracks, you can browse and play them **even when not connected to the server**.

- Browse and play downloaded **tracks / playlists / albums** offline.
- On download, **album art is saved locally as webp** (deduplicated per album), so jackets show even when not connected.
- In the offline collection too, album rows show the artwork and album artist (mixed artists show as "Various Artists").
- The artist page is also reconstructed from downloads as an album view.

:::note
The mobile client is distributed separately via EAS internal distribution.
Updates on the mobile app side are delivered OTA (EAS Update).
:::
