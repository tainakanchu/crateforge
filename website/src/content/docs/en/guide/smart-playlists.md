---
title: Smart Playlists
description: How to create Smart Playlists whose contents are determined automatically by rules, and folder hierarchy.
---

A **Smart Playlist** is a playlist whose contents are determined automatically by rules (conditions).
Because it evaluates the entire library every time you open it, it is always kept up to date.

> Screenshots to be added

## Creating and editing

- Create a new one with the **🎛 button** in the sidebar.
- For an existing Smart Playlist, edit its rules with **right-click → Edit rules**.

## Rules

In the editor, you define rules with the following combination.

- **Field / operator / value** — one condition per row.
- **Match all / any** — combine multiple conditions with AND / OR.
- **Groups** — "Add group" creates nested rules (e.g. A and (B or C)), up to 3 levels deep.
- **Sort** — the order of the results.
- **Limit (item cap)** — limit to the first N items.

The fields available for rules include **analysis values** in addition to basic metadata.

- **BPM** / **Key (Camelot)** / **Energy**
- **Play count** / **skip count** / **rating** (stars 0–5, in 0.5 steps) / **last played**
- name / artist / album / album artist / genre / grouping / year, etc.
- **Playlist** — is / is not in another playlist (a smart target uses its evaluated result, a folder covers all playlists inside it).
  Changing the referenced playlist's rules propagates to the smart playlists that reference it.

String conditions support contains / doesn't contain / is / is not / starts with / ends with.

### Input assistance

- **Date conditions** can be specified with the native date input.
- String conditions such as genre use a plain text input, and benefit from [CJK variant normalization](../customize/) (normalizing Traditional / Simplified Chinese and Japanese kanji / kana).

## Folder hierarchy

Like regular playlists, Smart Playlists can be placed in the **folder hierarchy** in the sidebar.
Folders can be collapsed / expanded by clicking, and that state is saved and kept across restarts.

:::note
Smart Playlists in an iTunes XML have their criteria converted on import (see [Library import](../import/)).
For a library you have already imported, **"iTunes XML からスマートプレイリストを復元…" (restore smart playlists from iTunes XML)** in the toolbar sets just the criteria again.
:::
