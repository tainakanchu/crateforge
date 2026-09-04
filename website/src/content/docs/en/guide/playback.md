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
- **Warnings**: unanalyzed tracks / duplicates / over or under the target duration / Set Lint findings / auto-export status
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
| `C` | Add to the Crate |
| `D` / `Enter` | Mark done and go to the next |
| `S` | Later (keep in the Inbox) |
| `Esc` | Exit Triage and return to the Inbox list |

Auditioning in Triage counts as Preview, so it does not pollute play counts.
The done / later state is stored inside the app and requires no database schema changes.

## Now Playing (BPM / Key / Energy)

The **Now Playing** in the right rail shows **Album / Artist / Genre / BPM / Key / Energy** along with the artwork of the playing track.
BPM, Key (Camelot), and Energy are shown for [analyzed](../dj-analysis/) tracks and help you decide on transitions.

The **Similar** tab presents "next moves" — Camelot-key compatible + close in tempo — for the playing track
(or via right-click → "Find similar").
See [similarity-based curation (Similar Digging)](../dj-analysis/) for how to dig further.
