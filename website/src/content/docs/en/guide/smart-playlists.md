---
title: Smart Playlists
description: How to create Smart Playlists whose contents are determined automatically by rules, and folder hierarchy.
---

A **Smart Playlist** is a playlist whose contents are determined automatically by rules (conditions).
Because it evaluates the entire library every time you open it, it is always kept up to date.

> Screenshots to be added

## Creating and editing

- Create a new one with the **＋ button → "新規スマートプレイリスト" (New smart playlist)** in the sidebar playlist header (right-clicking the blank area of the playlist list shows the same menu). To define one in Rules (YAML) instead, open the Rules panel from the same menu's **"Rules でスマートプレイリストを定義…" (Define smart playlists with Rules…)**.
- For an existing Smart Playlist, edit its rules with **right-click → "条件を編集" (Edit rules)**.

## Rules

In the editor, you define rules with the following combination.

- **Field / operator / value** — one condition per row.
- **Match all / any** — combine multiple conditions with AND / OR.
- **Groups** — "Add group" creates nested rules (e.g. A and (B or C)), up to 3 levels deep.
- **Sort** — the order of the results.
- **Limit (item cap)** — limit to the first N items.

The fields available for rules include **analysis values** in addition to basic metadata.

- **BPM** / **Key (Camelot)** / **Energy**
- **Play count** / **skip count** / **rating** (stars 0–5, in 0.5 steps; counted the same way as `rating:` in search — "is 3" matches 3 and 3.5 stars, "is 3.5" matches only 3.5 stars. To match exactly 3 stars, combine "is at least 3" with "is less than 3.5") / **last played**
- name / artist / album / album artist / genre / grouping / year, etc.
- **Playlist** — is / is not in another playlist (a smart target uses its evaluated result, a folder covers all playlists inside it).
  Changing the referenced playlist's rules propagates to the smart playlists that reference it.

String conditions support contains / doesn't contain / is / is not / starts with / ends with.

### Date conditions (in the last N days)

For **date added** / **date modified** / **last played**, "**が過去…以内**" (is in the last) and
"**が過去…以内でない**" (is not in the last) specify a period relative to today
(e.g. date added is in the last 30 days, last played is not in the last 3 months).
Enter the period as a number and a unit (**日 days / 週 weeks / か月 months**; up to 36500 days / 5200 weeks / 1200 months).

- The period is counted from the moment of evaluation. A playlist is re-evaluated when you open it and when the library or playlists change
  (a result less than a minute old is reused). The track counts in the sidebar are also recounted when you return to the app
  (when the window comes to the front). A list left open is not refreshed just because the date changed; reopen it to bring it up to date.
- Days and weeks mean "24 hours × N" before now; months are calendar months in your computer's local time (on March 31, "the last 1 month" starts at the end of February).
  A date exactly on the boundary counts as "in the last".
- Tracks without the date (e.g. last played of a never-played track) do not match "in the last" but do match "not in the last"
  (the same as "doesn't contain" / "is not"). For example, "last played is not in the last 3 months" includes unplayed tracks.
- Date added is the "Date Added" imported from iTunes as-is.

### Input assistance

- **Date conditions** can be specified with the native date input.
- String conditions such as genre use a plain text input, and benefit from [CJK variant normalization](../customize/) (normalizing Traditional / Simplified Chinese and Japanese kanji / kana).

## Folder hierarchy

Like regular playlists, Smart Playlists can be placed in the **folder hierarchy** in the sidebar.
Folders can be collapsed / expanded by clicking, and that state is saved and kept across restarts.

When you delete a folder (right-click → "削除…" (Delete…)), the confirmation dialog lets you choose between
**"フォルダだけ削除し、中身は残す" (delete only the folder; its playlists move up one level)** and **"中身ごと削除" (delete it with everything inside)**.
Tracks themselves stay in the library either way.

:::note
Smart Playlists in an iTunes XML have their criteria converted on import (see [Library import](../import/)).
For a library you have already imported, **"取り込み ▾" → "スマートプレイリストを復元…" (restore smart playlists)** in the toolbar sets just the criteria again.
:::
