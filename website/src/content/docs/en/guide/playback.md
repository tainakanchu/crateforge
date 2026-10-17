---
title: Playback, queue & Crate
description: Local playback, the Up Next queue, the Crate for DJ curation, Audition / Preview, Inbox / Triage, the Set Workspace, and Gig Readiness.
---

Crateforge supports local playback (rodio + symphonia) and decodes a wide range of formats directly.
You build up playback and curation in the right rail (the curation workbench): **Now Playing / Up Next / Crate / Similar**.

> Screenshots to be added

## Playing

- **Double-click** a track to play it.
- `Space` to **play / pause**, `Enter` to play the focused/selected row.
- `J` / `K` for previous / next track, `Shift + ←` / `Shift + →` to seek 5 seconds.
- `S` for shuffle, `R` for repeat (off / all / one). `Ctrl + ↑` / `Ctrl + ↓` for volume.

In the player bar, drag the seek bar to scrub, click the time display to toggle "elapsed ⇄ remaining,"
and the volume bar has a knob and a % display. The waveform is rendered as a real waveform from analysis peaks.

Automatic track advance is driven by a **worker thread on the Rust side**. Playback continues even when the window is minimized,
and if the next track's file can't be found, it skips automatically and keeps playing.
Tracks that fail to play are notified via a toast, and the failure details (file missing / decode failure / decoder crash) are
logged to `crateforge.log`.

Toggling shuffle / repeat is reflected in the UI only after the playback engine has applied it,
so Up Next never shows a stale order. If the toggle fails, the state is left unchanged and an error is shown.
Changes to `shuffle` / `repeat` / `volume` made from [mobile or the remote](../mobile/) are synced back to the desktop UI as well.

### ReplayGain

You can toggle ReplayGain (per-track volume normalization, −18 LUFS reference) in settings.

### Output device

Under **Settings → General → Output device** you can choose the audio output used for playback (booth output, laptop speakers, a USB audio interface, and so on).

- **System default** follows the OS default output (when you change the default in the OS, Crateforge follows within a few seconds).
- Switching while playing keeps **the current track, position, play / pause state, queue, volume and ReplayGain** as they are.
- After plugging or unplugging a device, press **Refresh** to re-read the list.
- The chosen device is **saved by name** and selected automatically on the next launch (before the queue is restored).
  If it is not found, playback uses the **system default** and a toast tells you so (the choice is kept, so reconnecting the device and restarting brings it back).
- If the chosen device is disconnected during playback, Crateforge switches to the system default automatically and notifies you.

## Cast playback (Google Cast)

Crateforge can send music to **Google Cast devices** on the same LAN (Chromecast, Google TV, and Cast-enabled speakers).
The device uses Google's standard Default Media Receiver; the PC serves the audio and handles the controls.

### How to use

1. Click the **"再生先" (Playback target) button** (the cast icon) in the player bar.
2. Pick a device from the list. **"このコンピューター" (This computer)** at the top of the list is normal local playback.
3. Once connected, the current track **continues on the cast device from the same position** (playing stays playing, paused stays paused).
4. To go back to local playback, choose **"このコンピューター"** in the list or press **"切断してローカルへ戻す" (Disconnect and return to local)**.
   Casting stops and the track is loaded on the PC from the same position, **paused**.

If a device does not show up, press **"再検索" (Search again)**.
While casting, the button is highlighted, and states such as connecting / reconnecting / disconnected are shown in the list header and under the device name.

### Supported devices

- Google Cast built-in TVs and speakers, Chromecast, Google TV
- **Not supported**: AirPlay devices such as HomePod (they cannot be reached through Cast; on macOS see "AirPlay (macOS)" below), Miracast / screen mirroring

### Requirements

- The PC and the cast device must be on the **same LAN**.
- Crateforge's **built-in API server must be running with "LAN exposure" enabled**, so the cast device can fetch the audio from the PC.
  If it is off when you pick a device, a **confirmation dialog** appears and LAN exposure is turned on only if you agree (it is never exposed without asking).
  You can turn it off again at any time in [Settings → AI integration / API](../api-server/).
- mDNS (multicast) must get through. In the following cases the device may not be found or may fail to connect:
  - The router has **AP isolation** on, or the PC is on a different network such as a guest Wi-Fi
  - A firewall blocks **UDP 5353 (mDNS)** or **inbound connections on the API port (default 8787)**
  - With a VPN or multiple network adapters, an interface different from the device's network may be chosen and the connection can fail.
    In that case, turn the VPN off or use only the network the device is on.

### Supported formats

The following formats can be cast for now:

- **MP3**
- **AAC** (in an M4A / MP4 container)

Anything else, such as FLAC / ALAC / WAV / AIFF / Opus, shows the error "this track's format is not supported for casting" and the playback target does not change
(if a track is already playing locally, it keeps playing).

### While casting

- **Queue, shuffle, repeat and auto-advance** continue just like local playback. When a track ends, the next one starts on the cast device.
- Play history such as play counts is recorded from the time actually played on the cast device.
- **Preview / Audition are disabled** (they cannot be started while casting; conversely, you cannot change the playback target during a Preview, so end it with `Esc` and choose again).
- If communication with the cast device is lost, Crateforge tries to reconnect a few times automatically. If that fails, it shows **"切断" (Disconnected)**.
  It **never switches to the PC speakers automatically** (so sound never suddenly comes out of the wrong speakers).
  Pick the device again to reconnect, or return to local. Returning to local loads the track from the last position, paused.
- The app **always starts on local output**. Even if you were casting last time, it does not reconnect automatically.
- Play / pause, seek and volume in the player bar keep working while casting (volume is the cast device's volume).

### Security

The cast device is never given your LAN API token. Instead, it gets a **dedicated URL that is valid for a single track, only for a short time, and can be revoked at any moment**.
The URL is revoked when you change track, disconnect, or quit the app.

Casting still **requires LAN exposure**, and is **intended for trusted LANs such as your home or studio**.
It is not designed for use over the internet or on public Wi-Fi shared with strangers.

### AirPlay (macOS)

> Behavior depends on your environment. This procedure is based on the design analysis; it has not yet been verified on real hardware.

Crateforge does not implement AirPlay itself. On macOS you play to an AirPlay speaker by making it the OS sound output.

1. In **System Settings → Sound → Output** (or Control Center), choose the AirPlay speaker.
2. Keep Crateforge's **Settings → General → Output device** on **System default**.
   When the OS default output changes, Crateforge follows within a few seconds.
3. If the AirPlay device is listed there, you can also select it directly.

:::note
AirPlay devices do not appear in the playback target list. AirPlay can add latency on the OS side, and depending on your setup you may hear dropouts or delay.
:::

## Audition / Preview

Press `A` to enter **Audition mode**: the waveform gets taller, 25 / 50 / 75% markers appear, and you can move around inside a track quickly.

- `1` / `2` / `3` jump to **25% / 50% / 75%**, `Home` to the start, `End` to the outro (end − 3s).
- `Alt + ←` / `Alt + →` seek ±15 seconds.
- From rows in the Crate / Similar panels you can start a **Preview** on the spot without disturbing the queue.
- `Esc` ends the Preview and **returns to the original track and playback position**. Even if a Preview reaches the
  end of a track, it does not advance to the next one — it returns to where you were.

**Anything you hear in Preview is not counted** toward play counts, skip counts, or recently played, so you can audition without polluting your stats.

The **AUDITION / PREVIEW badges in the player bar can be clicked to exit** (same as `A` / `Esc`).
Audition mode is session-only and is not carried over to the next launch.

## Up Next (playback queue)

The **Up Next** in the right rail is the queue of what will be played next.

- **"Play Next"** in the context menu inserts the selected tracks (multiple supported, selection order preserved)
  right after the currently playing track.
- The **"×"** that appears on row hover removes from the queue, and you can reorder with **drag and drop**.
- The header shows the **count, total time, and a shuffle badge**.
- Shuffle precomputes the actual play order (a permutation), so Up Next reflects exactly what will play next.
  Toggling shuffle updates Up Next to the new order immediately.
- The queue (including the shuffle order), the current track and position, and shuffle / repeat / volume are saved
  automatically and restored **paused** on the next launch (nothing starts playing on its own). Tracks deleted from
  the library are dropped from the queue. Tracks auditioned with Audition / Preview are never saved as the current track.

## The right rail (curation workbench)

The right rail has two tab groups: **Now / Up Next** and **Crate / Similar**.

- Drag its left edge to **resize** (280–560px); double-click resets it to the default (348px). The width is persisted.
- The **Split** button shows Crate and Similar stacked at the same time. Split is **only available on the Crate / Similar tabs**
  and is shown disabled on the Now / Up Next tabs.
- **Tabs never switch on their own.** Adding tracks to the Crate or running "Find similar" keeps you on the tab you were looking at.
  Instead, the **Crate tab gets a count badge** and the **Similar tab gets a dot** showing that a base track is pinned.
  (The context menu's "Find similar" and `Ctrl/Cmd + Shift + S` are explicit actions, so they do move to the Similar tab.)
- `Ctrl + ]` shows the right rail, and `Ctrl + 1`–`4` switch to the Now / Up Next / Crate / Similar tabs.

## Crate (DJ curation)

The **Crate** in the right rail is a staging area for building a starting point for your set.

- Add tracks to the Crate, and once you have a batch you can **"Save as playlist."**
  `Ctrl + Shift + C` adds the selection in one go, and you can also drag rows from the list into the Crate.
- The **smooth** button auto-sorts into a smooth flow using greedy nearest-neighbor based on analysis values.
- Each row offers Preview / Find Similar / Play next / play from here / remove from the Crate.

### Set Workspace (Anchor / Section / Arc / Lint)

The Crate doubles as a **design surface for a set** (nothing is written to the database, and the contents are restored on the next launch).

- Give the set a **name, a target duration (minutes), and notes**. The difference between the actual and target duration is shown.
- **Anchor** — click the badge on a row to set `Lock` / `Opening` / `Peak` / `Closing`.
  Anchored tracks keep their position even through a smooth re-sort.
- **Section** — insert boundaries such as `Opening` / `Build` / `Peak` / `Reset` / `Closing`.
  The smooth re-sort never moves tracks across a section boundary.
- **Set tools (Arc / Lint)** — Arc graphs the BPM / Energy shape of the set.
  Lint lists composition warnings without changing anything (same artist too close together, duplicates, big BPM jumps,
  Energy drops, harmonically incompatible transitions, missing files / unanalyzed tracks, low ratings,
  over / under the target duration, and contradictory Opening / Closing anchors). Individual warnings can be dismissed.

### Gig Readiness and Snapshots

**"Ready?"** in the Crate header checks the readiness of the Crate or the currently shown playlist on one screen.

- **Blockers**: no tracks / tracks whose files are missing
- **Warnings**: unanalyzed tracks / duplicates / low bitrate (lossy files under 256 kbps; lossless files are excluded) / over or under the target duration / Set Lint findings / auto-export status
- **Snapshot** — save the set contents and the verdict at that moment and review them later (up to 20 kept).
- **Prepare** opens the [sync dialog](../api-server/) to continue preparing tracks to take with you.

:::tip
The intended flow is: gather candidates with [similarity-based curation](../dj-analysis/) (the Similar tab) or [AI curation](../api-server/) (dj-curator),
use the Crate as a starting point, and finalize the track order in the GUI.
:::

## Inbox / Triage (sorting out newly imported tracks)

The **Inbox** in the sidebar collects freshly imported and unrated tracks (the count is shown as a badge).

- The Inbox holds tracks **added within the last 14 days**, **unrated tracks (no stars)**, and tracks you marked **"later"**
  (candidates come from a window of the 500 most recently added tracks plus your "later" tracks, so it stays fast on large libraries).
- Press `T` in the Inbox to enter **Triage mode** and work through tracks one at a time from the keyboard.

| Key | Action |
|---|---|
| `Space` | Preview play / pause |
| `J` / `↓` | Next track |
| `K` / `↑` | Previous track |
| `1`–`5` | Rating |
| `Shift`+`1`–`5` | Half-star rating (0.5–4.5) |
| `C` | Add to the Crate |
| `D` / `Enter` | Mark done and go to the next |
| `S` | Later (keep in the Inbox) |
| `Esc` | Exit Triage and return to the Inbox list |

Auditioning in Triage counts as Preview, so it does not pollute play counts.

Ratings use **half-star steps**. In the track list, the track editor, the context menu, and Triage, clicking the **left half of a star sets a half star** (e.g. the left half of the 4th star → 3.5) and the right half sets a whole star; clicking the current value clears it. Values are stored on the iTunes-compatible 0–100 scale (★1 = 20, half stars in steps of 10). Mobile / TV show the nearest whole star.
The done / later state is stored inside the app and requires no database schema changes.

## Now Playing (BPM / Key / Energy)

The **Now Playing** in the right rail shows **Album / Artist / Genre / BPM / Key / Energy** along with the artwork of the playing track.
BPM, Key (Camelot), and Energy are shown for [analyzed](../dj-analysis/) tracks and help you decide on transitions.

The **Similar** tab presents "next moves" — Camelot-key compatible + close in tempo — for the playing track
(or via right-click → "Find similar").
See [similarity-based curation (Similar Digging)](../dj-analysis/) for how to dig further.
