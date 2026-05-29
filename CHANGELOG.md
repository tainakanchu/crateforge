# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.0.2] - 2026-05-29

### Changed
- Redesigned the UI to the **Cratebox** art-forward / DJ theme:
  - Teal palette and a Lucide-style line-icon set (all emoji icons removed).
  - Three-pane shell: sidebar / center / **right rail** + full-width player bar.
  - **List** and **Covers** view modes (toolbar segment).
  - List rows: album-art placeholders (generated gradient + leading glyph), BPM color coding, genre pill chips, inline ★ rating.
  - **Column picker** popover: drag-reorder columns, toggle fields, row-height slider (32–64 px), artwork size (none / 豆 / 小) — persisted.
  - **Staging Crate** side rail (Now Playing / Up Next / Crate) for building a selection and saving it as a playlist; waveform seek bar in the player.

### Fixed
- Track sorting is now applied in the backend (SQLite `ORDER BY`) so the entire result set orders correctly. Previously only the rows already paged into memory were sorted, so sorting appeared to drop tracks until you scrolled to the bottom and back.
- Removing a track from a playlist now targets it by track id instead of display index, fixing wrong removals when the list was sorted.

## [v0.0.1] - 2026-05-29

Initial public release. A self-contained iTunes-style music manager that imports / edits / plays / exports your library, rips CDs with MusicBrainz lookup, and builds playlists declaratively from a YAML rules file.

### Library I/O
- Import and export iTunes `Library.xml` (Apple plist format) — interoperable with rekordbox / Serato / Traktor.
- Add audio files (FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF) by drag-pick; tags are read with `lofty`.
- SQLite (WAL) backing store with indices for fast search and big libraries (10,000+ tracks tested).

### CD ripping
- Detect TOC + MusicBrainz disc-id via libdiscid (Linux / macOS).
- Look the disc up on MusicBrainz; pick a release candidate (with Cover Art Archive preview).
- Rip with cdparanoia → encode to FLAC / ALAC / MP3 320 / WAV via flac / ffmpeg / lame.
- Live per-track progress; ripped files are auto-added to the library.

### Library views
- All Tracks (virtualized, 10k+ rows smooth).
- Albums view: card grid grouped by `album + albumArtist`, ▶ Play Album, inline tracklist on expand.
- Artists view: same but grouped by artist, with Album column.
- Recently Played view.
- Playlist tree with folder hierarchy.

### Track editing
- Sortable columns (12 columns including Album Artist, Year, Date Added) with persistent ▲ / ▼.
- Column picker (⚙︎ icon) with `localStorage`-persisted visibility.
- Inline ★ rating; click to set 1–5 / 0.
- Genre column shows space-separated tags as clickable chips; chip click drops the tag into the search bar.
- Get Info / Cmd+I dialog: edit every track metadata field.
- Bulk genre tag add / remove via the row context menu.

### Playback
- ⏮ ⏯ ⏹ ⏭ + 🔀 shuffle + 🔁 / 🔂 repeat (off / all / one) + 🔊 volume.
- Playback queue with auto-advance (500 ms polling).
- Windows SMTC integration: Now Playing widget + media keys (Play / Pause / Toggle / Next / Prev / Stop).
- Local file playback via rodio + symphonia (FLAC / MP3 / AAC / Vorbis / WAV / etc.).

### Declarative playlists
- YAML rules: per-playlist conditions (`all` / `any` / `not` + field operators + `inPlaylist` references).
- Generators: `bpmRange`, `ranges`, `tags`; reusable `templates`; namespace + folder hierarchy.
- In-app CodeMirror YAML editor with Validate / Preview (tree + counts) / Apply.
- Apply writes generated folders and playlists into the SQLite store so they show up in the sidebar and export with the next `Library.xml`.

### Updates
- Update banner on app launch if a newer GitHub Release is published.
- Close-time dialog: "閉じる前にアップデート？" — first close intercept opens the release page or "Later".

### Keyboard shortcuts
| Key | Action |
| --- | --- |
| Space | Play / Pause |
| Enter | Play first selected |
| J / K | Previous / Next |
| S | Shuffle toggle |
| R | Cycle repeat mode |
| ↑ / ↓ | Volume ±5% |
| `/` or Cmd/Ctrl+F | Focus search |
| Cmd/Ctrl+L | Library home |
| Cmd/Ctrl+I | Get Info on selection |
| Esc | Blur input |

### Build & dev
- Nix flake providing the full toolchain: Rust + Node + GTK / WebKit / ALSA / dbus + cdparanoia / libdiscid / libclang + flac / lame / ffmpeg.
- GitHub Actions workflow building `.exe` + MSI + NSIS installer on `windows-latest`; tag-triggered releases attach the installer set automatically.
- Persistent UI settings (sort, columns, volume, shuffle, repeat) via zustand `persist` → `localStorage`.

[Unreleased]: https://github.com/tainakanchu/itunes-playlist-viewer/compare/v0.0.2...HEAD
[v0.0.2]: https://github.com/tainakanchu/itunes-playlist-viewer/compare/v0.0.1...v0.0.2
[v0.0.1]: https://github.com/tainakanchu/itunes-playlist-viewer/releases/tag/v0.0.1
