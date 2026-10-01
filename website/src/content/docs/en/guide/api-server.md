---
title: Built-in API server
description: The local HTTP API server (tokens / pairing), AI integration, and a remote web UI for iPad and others.
---

Crateforge has a **built-in local HTTP API server**.
Enabling it lets you integrate with AI agents (such as dj-curator) and play and control from a phone / TV / iPad.

> Screenshots to be added

## Enabling and listen address

Enable the API server under **"AI integration / API"** in settings.

- It is **OFF** by default. The default port is **8787**.
- By default it listens on **`127.0.0.1` (loopback only)**.
- Enabling **"Expose on LAN"** lets you access it from a phone / TV / PC browser on the same Wi-Fi.
  The connection URL and a **QR code** are shown in settings.

It has been hardened to restart only after the server has reliably stopped (`SO_REUSEADDR` / `SO_REUSEPORT`),
resolving the "can't start because the previous server hasn't fully shut down (address in use)" problem.

## Authentication, tokens, and pairing

- Access **requires a token** (the token shown in settings). The token can be regenerated.
- For devices without a camera (such as Android TV), **device pairing** is provided.
  Start with `POST /api/pair/start` → `GET /api/pair/poll` (neither needs a token), and
  approving it in the **"Approve device"** UI in settings lets you connect without typing a long token by hand.

:::caution
Write operations are assumed to come **only from the local machine (the same PC)**. Browsing when exposed on LAN is read-centric.
:::

## AI integration (read/write API)

It exposes a REST API for reading and writing the library, analysis data, and playlists. The main endpoints:

### Read

- `GET /api/health` — server identity + current track count
- `GET /api/tracks` (`?q` search, `?album` / `?genre` partial match, offset/limit)
- `GET /api/tracks/{id}` / `POST /api/tracks/by-ids`
- `GET /api/tracks/{id}/analysis` — analysis results (null if not analyzed)
- `GET /api/tracks/{id}/similar` — similar tracks
- `GET /api/stats` / `GET /api/genres` / `GET /api/albums`
- `GET /api/playlists` / `GET /api/playlists/{id}` (includes the smart criteria `smartCriteria`) / `GET /api/playlists/{id}/tracks`

### Write (metadata)

- `PATCH /api/tracks/{id}` — partially update name / artist / album / genre / year / bpm / rating / composer / comments, etc.
  name / artist / album / genre / year / composer / comments are also reflected in the actual file's tags, while `rating` / `disabled` / `playCount` / `skipCount` are DB-only.
- `PATCH /api/tracks` (`{trackIds, edit}`) — bulk-update multiple tracks.
- `POST /api/tracks/genre-tags/add` / `/remove` — add or remove genre tags at the end in bulk.

Metadata writes, in addition to updating the DB, are **written back to the actual file's ID3 / Vorbis / MP4 tags** (tags only, without moving folders),
and are reflected in the GUI immediately. The write-back path is shared with editing in the desktop GUI.

**BPM** and **Key** are part of the write-back too (exactly as when editing on the desktop).

- **BPM** — written as an integer to TBPM (ID3v2) / tmpo (MP4) / `BPM` (Vorbis Comments).
  The track's own BPM takes priority, falling back to the analysis result.
- **Key** — the analyzed key is written to **InitialKey** (ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY)
  in musical notation (`Am`, etc.) rather than Camelot.

### Playlists

- `POST /api/playlists` — create a new one
- `POST /api/playlists/{id}/tracks` — add tracks
- `DELETE /api/playlists/{id}/tracks/{trackId}` — remove a single track

Changes made via the API are reflected immediately in the running app's UI through the `library-changed` event.

### AI curation (dj-curator)

This repository is also a Claude Code **plugin marketplace**.

```text
/plugin marketplace add tainakanchu/crateforge
/plugin install dj-curator@crateforge

# Generate a starting point for a set from a concept
/dj-curator:build-set summer-dusk chill house, 90 min, mellow start
```

The policy is that the AI **focuses on selecting the candidate pool**, while **a human finalizes the track order in the GUI**.
For details, see the [dj-curator README](https://github.com/tainakanchu/crateforge/tree/main/plugins/dj-curator).

## Remote web UI for iPad and others

When you enable LAN exposure, you can open a **same-origin remote web UI** (`http://PC-IP:PORT/`) in a browser.
From an iPad and the like, you can switch between "Play on PC (remote)" and "Play on this device."
On iOS, you can make it a full-screen app (**PWA**) with **"Add to Home Screen."**

The remote has **play / pause, previous/next, seek, a volume slider, and shuffle / repeat toggles**,
with state via `GET /api/remote/state` (including volume / shuffle / repeat) and operations via `POST /api/remote/*`
(`play` / `pause` / `resume` / `next` / `prev` / `seek` / `volume` / `shuffle` / `repeat`, etc.).

The web UI has **keyboard shortcuts** close to the desktop app, and `?` opens the list
(`Space` play / pause, `J` / `K` previous / next, `Shift + ←` / `Shift + →` seek 5 seconds, `S` shuffle, `R` repeat,
`Ctrl + ↑` / `Ctrl + ↓` volume, `/` and `Ctrl + F` search, `Ctrl + L` back to the library, `↑` / `↓` to move the list selection).
Shuffle / repeat / volume can be controlled from the web UI while "Play on this device" is active as well.
