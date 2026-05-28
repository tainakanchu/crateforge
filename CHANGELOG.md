# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- iTunes Library.xml import / export (Apple plist 互換).
- CD ripping with MusicBrainz lookup + Cover Art Archive.
- Audio file import (FLAC / MP3 / M4A / WAV / etc.) with lofty tag reader.
- Playlist editing (CRUD + folder hierarchy + multi-select + reorder).
- Declarative playlist rules (YAML → SQLite) with in-app CodeMirror editor.
- Inline ★ rating, sortable + configurable columns, genre chips.
- TrackEditor (Get Info) dialog for all per-track metadata.
- Player transport (prev/next/shuffle/repeat/volume) + playback queue with auto-advance.
- Keyboard shortcuts (Space / Enter / J K S R ↑↓ / Cmd+F Cmd+L Cmd+I).
- GitHub Releases update banner + close-time update dialog.
- Windows SMTC integration (media keys + Now Playing on Win10/11).
- Album / Artist library views in addition to Songs.
- GitHub Actions workflow that produces `.exe` + MSI + NSIS installer for Windows.
- Nix flake providing the full dev/build toolchain (incl. cdparanoia, libdiscid, flac, lame, ffmpeg).

[Unreleased]: https://github.com/tainakanchu/itunes-playlist-viewer/compare/v0.1.0...HEAD
