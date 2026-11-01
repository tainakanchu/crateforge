---
title: Mobile
description: Connecting the mobile client (QR / manual), browsing, on-device and background playback, remote, offline download / browsing / playback, and the Android APK with Android Auto.
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

## Android and Android Auto

The Android build is distributed as a **signed APK on GitHub Releases** (not on Google Play).
Android Auto support is in the same single APK as the regular phone app. In Android Auto you can browse, search, and play
**downloaded tracks / playlists / artists / albums** from the car screen (voice control via Google Assistant / Gemini in the Google app is supported; not yet verified on a real device),
and play the desktop library too when it is reachable over the LAN.
The phone, the notification, and the car all control **one shared player and queue**, so actions on the phone show up in the car and vice versa.

### Installing

1. Get `crateforge-android-<version>.apk` (and `.apk.sha256`) from [GitHub Releases](https://github.com/tainakanchu/crateforge/releases).
2. Verify the SHA-256 (`sha256sum -c crateforge-android-<version>.apk.sha256`). Check the signing certificate with
   `apksigner verify --print-certs`; it must match the signing-certificate SHA-256 in the release notes.
3. Open the APK to install it. If Android asks you to **allow installs from this source (Android OS setting)**, allow it.
4. Open Crateforge once on the phone, connect to the desktop, and download the tracks you want.

### Android Auto settings (separate from the OS permission)

**The OS permission in step 3 and Android Auto's "Unknown sources" are two different settings.** The former alone may not make the app appear in the car launcher.

1. Open Android Auto settings on the phone (or search for "Android Auto" in Settings).
2. Tap **"Version" at the bottom 10 times** to enable developer mode.
3. Open **Developer settings** from the menu at the top right and turn **Unknown sources** ON.
4. Reconnect to the head unit (or DHU) and check for "Crateforge" in the launcher or in "Customize launcher".

### When updating

- A new APK installs **over** the old one (downloaded tracks and settings are kept). It cannot overwrite an install signed with a different certificate.
- **Open the app once on the phone right after updating.** Until you do, LAN streaming from the car does not work (**downloaded tracks play from the car even without opening the app**).
- Android no longer uses EAS builds. You can update from an older EAS build to the GitHub build, but not the other way round.

### Troubleshooting

- **Not shown in the launcher**: check that Android Auto's Unknown sources is ON and developer mode is enabled, reconnect or restart Android Auto, and check that the app is not hidden in "Customize launcher".
- **Desktop tracks do not show up / play in the car**: did you open the app once after updating, are you on the same network, and did you reconnect after reissuing the token?
- **A specific track will not play** (e.g. an AIFF / CAF original): use "Re-download as AAC" on the Downloads screen.
- **Cannot install over the existing app**: the signing certificate differs (uninstalling removes downloads and settings).

### Known limitations

- This is not a zero-effort Google Play install: **Android Auto developer settings are required**, and it may not work on every head unit, OEM, or Android / Android Auto version.
- **Verification on real devices, DHU, and cars has not been done yet** (only automated tests so far). Results are recorded in the [verification checklist](https://github.com/tainakanchu/crateforge/blob/main/docs/android-auto/verification-checklist.md).
- Only system-signed apps, known Google hosts, and Crateforge itself may control playback; third-party car launchers and Wear OS apps cannot connect.
- Converted AAC streams cannot be seeked.

For detailed steps, verification, and the maintainer-side signing-key operations, see the [mobile README](https://github.com/tainakanchu/crateforge/blob/main/clients/apps/mobile/README.md).

:::note
The Android build is distributed as the GitHub Releases APK described above. The iOS build is distributed separately via EAS internal distribution.
JS-only updates are delivered OTA (EAS Update); updates that change the native configuration require replacing the APK.
:::
