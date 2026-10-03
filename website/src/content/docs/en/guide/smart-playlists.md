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
- **Sort** — the order of the results.
- **Limit (item cap)** — limit to the first N items.

The fields available for rules include **analysis values** in addition to basic metadata.

- **BPM** / **Key (Camelot)** / **Energy**
- **Play count** / **skip count** / **rating** (stars 0–5, in 0.5 steps) / **last played**
- name / artist / album / album artist / genre / year, etc.

### Input assistance

- **Date conditions** can be specified with the native date input.
- String conditions such as genre use a plain text input, and benefit from [CJK variant normalization](../customize/) (normalizing Traditional / Simplified Chinese and Japanese kanji / kana).

## Folder hierarchy

Like regular playlists, Smart Playlists can be placed in the **folder hierarchy** in the sidebar.
Folders can be collapsed / expanded by clicking, and that state is saved and kept across restarts.

:::note
The Smart Playlist criteria (`Smart Info`) of imported iTunes XML are not preserved.
Please recreate the rules on the Crateforge side.
:::
