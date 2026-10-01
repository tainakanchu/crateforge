---
title: DJ analysis
description: Analyzing BPM / Key (Camelot) / Energy / loudness / similarity with a pure-Rust DSP, and how to use it.
---

Crateforge performs DJ-oriented audio analysis with a **pure-Rust DSP**.
Without depending on external tools, it estimates **BPM / Key (Camelot) / Energy / loudness** and a similarity vector.

> Screenshots to be added

## What gets analyzed

| Metric | Description |
|---|---|
| **BPM** | Detects tempo automatically. Lets you find tracks that are easy to mix. |
| **Key (Camelot)** | For harmonic mixing, shows the key in Camelot notation (e.g. `8A`). |
| **Energy** | Quantifies a track's drive. Lets you design the flow of a set. |
| **Loudness** | The volume level. Used for rendering the real waveform and for normalization. |
| **Similarity vector** | An internal representation for pulling in tracks with a similar vibe. |

Of the analysis results, **Key / Energy** can be shown as columns in the track table and are also shown in Now Playing.

## When analysis runs

Analysis runs in the background only for "the tracks you use often." It is triggered by either of the following.

- When you **play** a track
- When you run **"Analyze"** via right-click

Analyzed BPM / Key are also **written to the actual file tags** when you edit a track
(BPM and InitialKey — see [Library import](../import/) for details).

Progress is shown in the toolbar. Rather than analyzing your entire library at once,
it focuses on the tracks you actually use, so it works without waste.

## Similarity-based curation (Similar Digging)

The **Similar** tab in the right rail suggests "next moves" based on analysis values.

- Right-click a track and choose **"Find similar"** (or press `Ctrl/Cmd + Shift + S`) to show candidates that are
  **Camelot-key compatible + close in tempo**.
- The base track can be the selected track or the playing track; unpin it and it follows whatever is playing.

### Digging further (history)

Choosing **"Set as base"** on a candidate row makes that track the new base so you can keep digging.

- **Back / Forward** and the **breadcrumb** move through the base-track history of the session.
  Clicking a breadcrumb jumps back to that point (Clear resets the history).

### Why it is similar (reason chips)

Each candidate carries chips describing its relation to the base track.

- **Key** — the candidate's Camelot key (shown as `8A → 9A` when it differs from the base)
- **BPM** — the difference from the base (`BPM +1.5` / `BPM -2.0%`, etc.)
- **Energy** — the difference from the base (`Energy +0.08`, etc.)
- **Harmonic** — the key is harmonically compatible
- **d=** — the distance in the similarity vector space

### Filters

- **Harmonic** — Camelot-compatible keys only (independent of the BPM filter)
- **BPM tolerance** — the allowed difference relative to the base
- **Energy close** — only an Energy difference of 0.15 or less
- **Exclude tracks in the Crate** / **exclude the same artist** / **★★★ and above only**

These filters are saved and carried over to the next launch.

### Row actions

Each row offers **Preview / set as the dig base / play next / add to the Crate**.
Candidates can also be dragged and dropped into the Crate, and double-clicking previews them.
When everything has been added, "Add all" is disabled ("All added").

## Search filter syntax

You can also filter by analysis values in search (AND-combined with text search and other field filters).

```text
bpm:120-128
key:8A
key:compat:8A
energy:60-100
analyzed:no
```

- A single `bpm:` value matches ±2 and prefers the analyzed value (falling back to the track's BPM tag).
- `key:compat:8A` narrows to **every key that mixes harmonically with 8A** (8A / 8B / 7A / 9A).
  It uses the same logic as the Similar tab, so the two never disagree.
- `energy:` accepts either 0–1 or 0–100.
- `analyzed:yes` / `analyzed:no` separates analyzed from not-yet-analyzed tracks.

For the full syntax, including filters on artist, year, and rating, see [search syntax](../customize/).

## Integration with Smart Playlists and AI curation

- You can use BPM / Key / Energy in [Smart Playlist](../smart-playlists/) rules.
- The [built-in API server](../api-server/) also returns analysis results and similar tracks, so AI curation such as dj-curator can leverage analysis values as a bonus.

:::note
The basic policy is to curate **primarily by metadata** (rating / genre / era),
and to treat BPM / Key / Energy as a "use-it-if-you-have-it bonus."
:::
