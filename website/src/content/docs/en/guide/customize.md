---
title: Customizing the display
description: Adding / reordering / resizing columns, adjusting row height, covers, and the right rail, plus search syntax and a keyboard shortcut list.
---

You can fine-tune the track table and the right rail to match how you work. Settings are persisted.

> Screenshots to be added

## Customizing columns

- **Resizing columns** — drag the right edge of a header to change the column width (you can widen Genre / tag columns enough to see everything).
- **Reordering columns** — reorder by dragging the header directly, or with the pointer in the column picker (customize menu).
- **Toggling visible columns** — show / hide columns in the column picker.
- **Track number columns** — you can show two kinds: "Track #" (the track number within the album) and "No." (the sequential number in the current display order).

## Row height, covers, and the right rail

- **Row height** — adjust within 32–64px with a slider.
- **Artwork (cover) size** — choose from none / small (20px) / medium (28px).
- **List / Albums / Tracks view** — switch with the segment in the toolbar. Albums groups the same album into a single card, and clicking it expands the in-album track list in place. Tracks is an art wall with one card per track.
- **Show / hide the right rail** — hide it with a toggle (drag its left edge to resize, double-click to reset to the default).

Truncated cells (track name / album / album artist) show the full text as a tooltip on hover.

### Albums / Artists views

- **Albums** — cards are sorted by the toolbar's Sort in every scope: the whole library, search results, and inside a playlist.
  Below each card, the value of the current sort key (Year / Date Added / Rating / Plays) is shown as a secondary line.
- **Artists** — the artist list is aggregated on the server side (SQLite) and rendered virtualized.
  Compilations roll up into **Various Artists**; tracks with an empty album artist fall back to the artist name,
  and to "Unknown Artist" when neither is present. Track and album counts match the Albums view.
  Sort in the Artists view offers **Artist / Tracks / Albums**.

## Toolbar

- When the window is narrow, the actions on the right (Import XML / Add Files / Add Folder / Rip CD / Rules /
  organize folder / Export XML / auto-export / fetch from server) collapse into a **⋯ menu**.
  They behave exactly the same when collapsed, and the search box keeps a minimum width.
- The **`?` button** at the far right opens the keyboard shortcut list (same as the `?` key).

## Sorting

- Sort is **remembered per view (per scope)**. The library, Inbox, recently played, Albums, Artists —
  and **each playlist** — keep their own sort, so reopening one shows the same order as before.
- Opening a regular playlist in List view defaults to **"Playlist Order"** (the manual order stored in the playlist).
  Only in that order can you drag rows to reorder tracks, and `Alt` + `↑` / `↓` moves them one step at a time
  (a multiple selection moves as a block). "Playlist Order" appears in the Sort menu only in that situation.
- You can also **drag and drop rows onto a playlist in the sidebar** to add them (dropping onto the Crate works the same way).

## CJK variant-normalizing search

In the search box, the built-in API, and Smart Playlists, **Traditional / Simplified Chinese, Japanese kanji and kana (hiragana ↔ katakana), full-width / half-width, and upper / lowercase** are normalized,
so whichever variant you type matches across the board. The strength can be set to **off / light / standard** in settings.

## Search syntax

Focus the search with `/` (or `Ctrl + F`). The query is split on spaces and each token is combined with **AND**.
`key:value` is a field filter; anything else is a partial match against name / artist / album / album artist / genre / comments.
To include spaces in a value, wrap it in double quotes, as in `artist:"daft punk"`.

| Syntax | Meaning |
|---|---|
| `daft punk` | Free text (contains both) |
| `artist:daft` / `artist:"daft punk"` | Partial match on the artist name |
| `album:discovery` | Partial match on the album |
| `albumartist:aphex` (`album_artist:` also works) | Partial match on the album artist |
| `genre:house` | Partial match on the genre |
| `comment:classic` | Partial match on the comments |
| `year:2018` / `year:2015-2020` | Release year (single / range) |
| `rating:5` / `rating:4-5` / `rating:0` | Stars 0–5 (`rating:0` is unrated) |
| `bpm:128` / `bpm:120-128` | BPM (a single value means ±2; analysis values take priority) |
| `key:8A` | Exact match on the Camelot key |
| `key:compat:8A` | Keys that mix harmonically with 8A (8A / 8B / 7A / 9A) |
| `energy:60-100` | Energy (0–1 or 0–100 both accepted) |
| `analyzed:yes` / `analyzed:no` | Analyzed / not analyzed |

Example: `artist:"daft punk" year:2001 key:compat:8A analyzed:yes`

Text field filters get the same variant normalization as free-text search.
Values that can't be parsed (such as `key:compat:99Z`) simply fall back to free text.
`bpm:` / `key:` / `energy:` / `analyzed:` refer to [analysis](../dj-analysis/) data.

### Searching inside a playlist

While a playlist is open, a scope toggle appears next to the search box:
**"This playlist" / "Whole library"** (the default is this playlist). Typing a search no longer throws you back
to the library view, and the syntax above works exactly the same inside a playlist (including Smart Playlists).

## Restoring the window and view state

- The window's **size / position / maximized state** are saved on exit and restored on the next launch.
  The minimum window width is **1024px**.
- The **previous view state** is restored too: the view (library / playlist / Inbox and so on), the selected playlist,
  filter tags, whether the right rail's Set tools are open, and the per-scope sort.
  If a restored playlist can no longer be found, it falls back to the library view.
- Triage / Preview / Audition are session-only modes and are not carried over to the next launch.

## Keyboard shortcuts

Press `?` (or the `?` button in the toolbar) to show the shortcut list overlay.

### Playback

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `Enter` | Play the selected track |
| `J` | Previous track |
| `K` | Next track |
| `Shift` + `←` | Seek back 5 seconds |
| `Shift` + `→` | Seek forward 5 seconds |
| `S` | Toggle shuffle |
| `R` | Toggle repeat |
| `Ctrl` + `↑` | Volume up |
| `Ctrl` + `↓` | Volume down |

### Audition / Preview

| Key | Action |
|---|---|
| `A` | Toggle Audition mode |
| `1` | Jump to 25% (in Audition) |
| `2` | Jump to 50% (in Audition) |
| `3` | Jump to 75% (in Audition) |
| `Home` | Jump to the start of the track (in Audition) |
| `End` | Jump to the outro (end − 3s) (in Audition) |
| `Alt` + `←` | Back 15 seconds (in Audition) |
| `Alt` + `→` | Forward 15 seconds (in Audition) |
| `Esc` | End Preview and return to the original track |

### Navigation & search

| Key | Action |
|---|---|
| `/` | Focus search |
| `Ctrl` + `F` | Focus search |
| `Ctrl` + `L` | Return to library (clear search) |
| `Esc` | Exit search / input, close dialog |

### List operations

| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection up / down |
| `Shift` + `↑` / `↓` | Extend the selection |
| `Ctrl` + `A` | Select all |
| `Ctrl` + `I` | Edit the selected track (Get Info) |
| `Alt` + `↑` | Move the selected tracks up one (while a playlist is shown in Playlist Order) |
| `Alt` + `↓` | Move the selected tracks down one (while a playlist is shown in Playlist Order) |
| Drag and drop | Drag rows: reorder within a playlist / add to a sidebar playlist or the Crate |
| `≣` (application key) | Context menu (shown relative to the focused row) |

### Curation workbench (right rail)

| Key | Action |
|---|---|
| `Ctrl` + `]` | Show the right rail |
| `Ctrl` + `1` | Now Playing tab |
| `Ctrl` + `2` | Up Next tab |
| `Ctrl` + `3` | Crate tab |
| `Ctrl` + `4` | Similar tab |
| `Ctrl` + `Shift` + `S` | Use the selected track as the Similar base |
| `Ctrl` + `Shift` + `C` | Add the selected tracks to the Crate |

### Inbox / Triage

| Key | Action |
|---|---|
| `T` | Start Triage from the Inbox |
| `Space` | Preview play / pause (in Triage) |
| `J` / `↓` | Next track (in Triage) |
| `K` / `↑` | Previous track (in Triage) |
| `1`–`5` | Rating (in Triage) |
| `C` | Add to the Crate (in Triage) |
| `D` / `Enter` | Mark done and go to the next (in Triage) |
| `S` | Later (skip) (in Triage) |
| `Esc` | Exit Triage → Inbox list |

### Help

| Key | Action |
|---|---|
| `?` | Show this shortcut list |
