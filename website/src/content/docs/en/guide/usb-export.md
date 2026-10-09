---
title: USB export (CDJ / rekordbox-compatible)
description: Export playlists to a USB stick that CDJ / XDJ players read. The external rbx-cli tool, importing Traktor cues/grids, syncing and ejecting, and caveats.
---

You can export playlists and folders to a **rekordbox-compatible USB stick that CDJ / XDJ players read**: audio files, analysis (beat grid / waveforms / key), cue points, playlists and artwork.
An export works as a **sync**: from the second time on, only the tracks that changed are rewritten.

> Screenshots to be added

:::caution
rekordbox, CDJ and XDJ are trademarks of AlphaTheta Corporation. Crateforge and rbx-cli are **not affiliated** with or endorsed by AlphaTheta.
This feature has **not yet been tested on real CDJ / XDJ hardware by the developers**. Before relying on it at a gig, check loading, cue positions and grids on your own players.
:::

## Exporting

1. In the sidebar, **right-click a playlist or folder → "USB に書き出し…"** (Export to USB), or use **"USB に書き出し"** in the toolbar (inside the ⋯ menu when the window is narrow).
2. Choose the **playlists to export**. Selecting a folder exports its playlists **with the hierarchy**. Smart playlists are exported with their contents at the time of the export.
3. Choose the **destination**: pick a USB stick from the list of mounted volumes, or any folder with "フォルダ…" (Folder…). The last destination is remembered.
4. Set the **options** (below).
5. **"計画を確認"** (Review plan) builds a plan without writing anything to the stick: tracks to copy / reuse, where analysis comes from (new / cache / reused from the stick), bytes to copy and free space, Traktor matching, missing files and warnings.
6. **"書き出す"** (Export) starts it. Progress is shown per stage (prepare → analysis & tags → change check → copy to USB → databases → verify → publish).
7. When it finishes, **"取り出し"** (Eject) safely ejects the stick (listed volumes only; never forced).

You can close the dialog while it runs. Progress is shown on a card at the bottom right (above the player bar); click it to return to the dialog.
**"中止"** (Cancel) stops at the next track boundary. Whether cancelled, failed or unplugged, **the stick keeps its previous contents** (the new contents are staged and switched over in one step).

### Options

| Option | Meaning |
|---|---|
| **Traktor のキュー/グリッドを使う** (Use Traktor cues/grids) | See "Traktor cues and grids" below. Off by default |
| **アートワークを書き出す** (Export artwork) | Exports the image embedded in each audio file, resized for the players |
| **USB から消す** (Remove from USB) | Removes tracks an earlier export wrote that this export no longer contains (playlists always match this export) |
| **デバイス名** (Device name) | The name players show. Leave empty to keep the current one |
| **詳細設定** (Advanced) | Location of Traktor's `collection.nml`, MP3 offset (ms) |

### What is written

- Title, artist, album, genre, comment, year, track number, disc number, play count, date added and rating (0–5 stars; half stars round up) come **from the Crateforge library**.
- The **key** is Crateforge's effective key (your manual override, else the analysed key), written in rekordbox notation (`Am`, `F#m`, …). Tracks without one use the key analysed during the export.
- **BPM, beat grid and waveforms** are analysed during the export (or taken from Traktor's grid when that option is on). The displayed BPM matches the grid's tempo.
- **Tracks whose file is missing** (an external drive or NAS not connected, for example) are listed in the plan with a count and examples. They are still handed to rbx-cli and stay in their playlists:
  - a track never exported to this stick before is skipped;
  - if the stick **already holds** such a track from an earlier export, the export **stops without changing the stick**, so its copy is not deleted. Connect the drive (or fix the track's location) and export again. Even with "USB から消す" (Remove from USB) on, a track whose file is merely missing is never deleted from the stick.

## Traktor cues and grids

Crateforge itself does not store cues or beat grids. With **"Traktor のキュー/グリッドを使う"** on, every export reads Traktor's **`collection.nml`**, matches tracks by **file path**, and writes Traktor's cues and grids to the stick (nothing is saved to the Crateforge library).

- `collection.nml` is **auto-detected** as the newest `Documents/Native Instruments/Traktor <version>/collection.nml`. If yours is elsewhere, set it under Advanced (or **Settings → USB 書き出し**).
- Tracks whose path differs are matched only when **file name and file size** match exactly one Traktor track. The plan shows matched / unmatched counts with examples.
- On macOS, a clone or backup volume holding **the same path** can make it unclear which Traktor track is meant. Then the one on the startup volume is used; if none is on the startup volume, **that track gets no Traktor cues or grid** (the plan lists it under "候補が複数" — several candidates).
- Mapping:
  - Grid markers → beat grid (constant tempo at Traktor's BPM; several markers become several anchors)
  - Cue / fade-in / fade-out / load → cue points; loops → loops
  - Hot cues 1–8 → hot cues A–H; cues not on a hot cue → memory cues
  - Cue names → cue comments
- For **tracks not found in Traktor**, or when the option is **off**, no cues or grids are sent: cues already on the stick are kept, and the grid comes from analysis.
- Tracks that match **follow Traktor**: if a track has no cues in Traktor, its cues on the stick are removed.

### MP3 offset

Traktor and rekordbox / CDJ treat the start of MP3 decoding differently, so **MP3 cues and grids can be off by tens of milliseconds**.
**"MP3 オフセット (ms)"** (MP3 offset) under Advanced shifts the cues/grids imported from Traktor for MP3 files (positive = later, negative = earlier). The default is **0 ms**.
Because the shift can depend on the file and encoder, **calibrate the value on real hardware**; Crateforge does not ship a guessed value.

### Conflicts with cues saved on a CDJ

When you save cues to the stick on a CDJ, the analysis files on the stick change. Sending Traktor's cues afterwards would lose them, so the export is **stopped without changing the stick**, with an explanation. Then:

- Retry with **"USB 上のキューを優先（Traktor のキューを送らない）"** (Prefer the cues on the USB): the same playlists, destination and options are exported again, but Traktor's cues are not sent and the stick's cues are kept (Traktor's grids are still sent).
- However, if the **beat grid was changed on the CDJ**, this version cannot keep that grid, so the retry may stop again for the same reason (the retry is not offered twice in a row). If you do not need the CDJ changes, export to another (empty) stick.
- To bring the CDJ cues into Traktor first, import them from the stick with rekordbox or similar, then export again.

With "Traktor のキュー/グリッドを使う" off, cues saved on a CDJ are always kept.

## Speed and caching

- **The first export is slow**: every track has to be analysed and written to the stick.
- Later exports reuse the **analysis cache** (on your computer; reused while a track's content and the analysis settings are unchanged) and the files already on the stick, and only copy / analyse what changed.
- To detect changes reliably, though, rbx-cli **still reads every audio file on both the source and the stick each time**. With many tracks this takes a while even when nothing changed.
- **You cannot export while rekordbox is running** (it may write the same stick).

## About rbx-cli

The export itself is done by the external tool **[rbx-cli](https://github.com/tainakanchu/rbx-cli)** (built on [rbxport](https://github.com/chrisle/rbxport)).

- Crateforge only **starts rbx-cli as a separate process and talks to it in JSON**. It is not built into Crateforge and not bundled with it.
- If rbx-cli is not installed yet, **download** it from the export dialog (or **Settings → USB 書き出し (rbx-cli)**). It is fetched from the upstream GitHub release, its SHA-256 checksum is verified, and it is saved in the app's data folder.
- rbx-cli is looked up as "path set in Settings → downloaded copy → `rbx-cli` on PATH", and only a version speaking a supported protocol is used. You can also use your own build via **"パスを指定…"** (Set path…) in Settings.
- Release binaries exist for Windows (x86-64), macOS (Apple silicon / Intel) and Linux (x86-64, glibc 2.39 or newer).

:::note
rbx-cli is GPL-2.0-or-later software (its release binaries include an LGPL-3.0 component, so they are effectively GPL-3.0). Crateforge (MIT) does not link it; it only runs it as an external command.
:::
