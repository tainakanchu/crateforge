# iTunes Playlist Viewer — アプリ仕様書 (UI 再設計用リファレンス)

このドキュメントは UI を再設計するための **機能仕様と現状 UI の構造** をまとめたリファレンスです。
デザインを変更する際の入力情報として利用することを想定しています。

---

## 1. アプリ概要

### 1.1 一行サマリ
ローカルで動く、爆速の iTunes 風音楽管理デスクトップアプリ。`iTunes Library.xml` の入出力、CD リッピング、音声ファイル取り込み、プレイリスト編集、ローカル再生までを **このアプリ単体で完結** させる。

### 1.2 技術スタック
- **フロントエンド**: React 19 + Vite 6 + TypeScript / Zustand (状態管理) / `@tanstack/react-virtual` (仮想スクロール)
- **デスクトップ**: Tauri 2 (Rust)
- **バックエンド**: Rust + SQLite (WAL) / `rodio` (再生) / `lofty` (タグ解析) / `cdparanoia` + `flac` / `lame` / `ffmpeg` (リッピング/エンコード) / MusicBrainz + Cover Art Archive (CD メタデータ)
- **対応 OS**: Linux / macOS / Windows (Windows は物理 CD リッピング不可)

### 1.3 ターゲットユーザー像
- 数千〜数万曲の音楽ライブラリを iTunes 形式で保有しているユーザー
- DJ ソフト (rekordbox / Serato / Traktor) との XML 互換性を必要とするユーザー
- 物理 CD を継続的に取り込んでいるユーザー
- レーティング・BPM・ジャンルタグでプレイリストを **宣言的 (YAML)** に組み立てたい上級者

### 1.4 設計上の重要原則
- **状態の真実は SQLite**: フロントは表示と編集 UI のみを担う。
- **大量データへの耐性**: 10,000+ トラックでも快適に動く必要があり、テーブルは仮想化必須、グループビュー (Albums/Artists) は全件をメモリにロードする想定。
- **キーボード駆動**: 検索 (`/`) / 再生 (`Space`) / ナビゲーション (`J K`) / 設定 (`S R`) / 音量 (`↑↓`) を完全にキーで操作できる。
- **iTunes 風メンタルモデル**: 左サイドバー (ライブラリ + プレイリスト)、中央テーブル、下部プレーヤー、という古典的 3 ペイン構造。

---

## 2. 画面レイアウト構造

### 2.1 トップレベルのグリッド
```
┌──────────┬─────────────────────────────────────────┐
│          │  Toolbar (Import / Add / Rip / Rules / Export + Stats + Status)
│          ├─────────────────────────────────────────┤
│ Sidebar  │  SearchBar (debounced 120ms / "/" focus)
│ 240px    ├─────────────────────────────────────────┤
│          │
│          │  Main Content (TrackTable | AlbumView)
│          │
├──────────┴─────────────────────────────────────────┤
│            PlayerBar (64px fixed)                  │
└────────────────────────────────────────────────────┘
```
- `display: grid`、サイドバー固定幅 240px、下部プレーヤー固定 64px。
- フッターのプレーヤーは常時表示。ダイアログはオーバーレイで上に重なる。

### 2.2 Sidebar (左ペイン)
**セクション**:
1. **Library**
   - 🎶 All Tracks (viewMode = `library`)
   - 💿 Albums (viewMode = `albums`)
   - 🎤 Artists (viewMode = `artists`)
   - 🕐 Recently Played (viewMode = `recent`, 200 件まで)
2. **Playlists** (折り畳みなしのツリー、フォルダ階層対応)
   - 通常プレイリスト: 🎵
   - フォルダ: 📁
   - スマートプレイリスト: ⚙️ (現状は読み取り専用扱い)
   - 各行の右端: `trackCount` バッジ
   - セクションタイトル右に `＋` (新規プレイリスト) と `📁＋` (新規フォルダ)
   - ダブルクリックでインライン名前変更、右クリックで `[r] Rename / [d] Delete` プロンプト
3. **空状態**: 「No playlists yet. Import a library XML or create one.」

### 2.3 Toolbar (上部)
- **アクション (横並びボタン)**:
  - 📥 Import XML (primary、ファイル選択ダイアログ)
  - 🎵 Add Files (複数選択可、対応拡張子: flac/mp3/m4a/wav/aac/ogg/opus/aiff/wma)
  - 💿 Rip CD (RipDialog を開く)
  - ⚙️ Rules (RulesPanel を開く)
  - 📤 Export XML (トラック 0 件のとき disabled)
- **Library Stats**: `XX,XXX tracks · XX playlists · XXh XXm`
- **Status**: 直近の操作結果 (例: `Imported 1234 tracks, 56 playlists`)

### 2.4 SearchBar
- プレースホルダ: `Search tracks, artists, albums... (press / to focus)`
- 120ms デバウンス。検索開始時に自動で `viewMode` を `library` に戻す。
- `Esc` でクリア + blur。

### 2.5 メインコンテンツ
viewMode により切替:

| viewMode      | 表示                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `library`     | TrackTable (全トラック、ページング 500 件ずつ)                          |
| `playlist`    | TrackTable (選択中プレイリストのトラック)                               |
| `recent`      | TrackTable (再生履歴順、最大 200 件)                                    |
| `albums`      | AlbumView (アルバム単位のグリッド + 展開可能なトラックリスト)           |
| `artists`     | AlbumView (アーティスト単位、`mode = "artist"`)                         |

検索クエリが入力されている場合は viewMode に関わらず TrackTable に検索結果を表示する。

### 2.6 PlayerBar (下部固定)
4 つの領域:
1. **再生コントロール**: ⏮ ⏸/▶ ⏹ ⏭ 🔀 (Shuffle toggle) 🔁/🔂 (Repeat: off / all / one)
2. **トラック情報**: トラック名 / アーティスト — アルバム (再生中なし時は `No track playing`)
3. **シーク**: `position` / range スライダー / `duration` (`M:SS` 表記)
4. **音量**: 🔊 + range スライダー (0〜1、step 0.02)

---

## 3. 主要コンポーネント仕様

### 3.1 TrackTable (中心ビュー)
**特性**:
- 仮想化済みテーブル (1 行 28px、overscan 20 行)。
- カラムは `visibleColumns` で表示/非表示を切り替え、設定は localStorage に永続化。
- ヘッダ右端に ⚙︎ カラムピッカーアイコン。

**カラム定義** (`COLUMNS`):
| key            | label        | デフォルト表示 | ソート対象 | width    | 数値 |
| -------------- | ------------ | -------------- | ---------- | -------- | ---- |
| `name`         | Track        | ✅             | ✅         | 3fr      |      |
| `artist`       | Artist       | ✅             | ✅         | 2fr      |      |
| `albumArtist`  | Album Artist | ❌             | ✅         | 2fr      |      |
| `album`        | Album        | ✅             | ✅         | 2fr      |      |
| `genre`        | Genre        | ✅             | ✅         | 1.5fr    |      |
| `year`         | Year         | ❌             | ✅         | 60px     | ✅   |
| `rating`       | Rating       | ✅             | ✅         | 80px     |      |
| `playCount`    | Plays        | ✅             | ✅         | 50px     | ✅   |
| `bpm`          | BPM          | ✅             | ✅         | 50px     | ✅   |
| `totalTimeMs`  | Time         | ✅             | ✅         | 55px     | ✅   |
| `trackNumber`  | #            | ❌             | ✅         | 40px     | ✅   |
| `dateAdded`    | Date Added   | ❌             | ✅         | 110px    |      |

**行の見た目バリエーション**:
- `playing` — 現在再生中 (緑系強調 + 行頭 `▶`)
- `selected` — 選択中 (青背景)
- `missing` — ファイル不在 (薄文字 + 行頭 `⚠`)

**インタラクション**:
- クリック: 選択 (Ctrl/Cmd: 追加選択、Shift: 範囲選択)
- ダブルクリック: 現在のリストをキューに入れて再生開始
- 右クリック: コンテキストメニュー (後述)
- カラムヘッダクリック: ソート切替 (asc → desc)
- ★ (rating セル): クリックでインライン編集、同じ星をクリックでクリア (0)
- ジャンルチップクリック: そのタグで検索を実行

**コンテキストメニュー項目**:
- ヘッダ: 選択トラック数 or トラック名
- ▶ Play / ➕ Add to Queue / ℹ Get Info / Edit
- (プレイリスト表示中のみ) − Remove from this playlist
- 区切り → **Add to playlist...** プレイリスト一覧
- 区切り → **Genre tags**: ＋ Add tag… / 現タグごとに「− Remove "xxx"」

### 3.2 AlbumView (Albums / Artists)
**ビュー構造**:
- グループ単位のカードグリッド。
- カードヘッダ: `💿`/`🎤` プレースホルダ + タイトル + サブラベル (Album のみ Album Artist 表示) + `N tracks · MM:SS`
- カード右端: ▶ Play album ボタン (全件をキューに入れて即再生)
- カードクリック: トラックリストを展開
- 展開時のトラック行: `#` / トラック名 / (Artist mode のみ) アルバム名 / Time。ダブルクリックで再生。

**現状の不足**: アルバムアートは表示せず常にプレースホルダ絵文字のみ。再設計時はアートワーク埋め込み (Cover Art Archive キャッシュ) を想定可能。

### 3.3 PlayerBar の状態
- `playback.isPlaying` で ▶/⏸ アイコン切替
- `shuffle` / `repeat !== off` のときトグルボタンが「on」スタイル (`.toggle.on`)
- `repeat === "one"` のときアイコンに小さな `1` バッジ
- `seek-slider` は `duration === 0` で disabled

### 3.4 TrackEditor (モーダル — "Get Info")
**フィールド** (`TrackEdit`):
- Name / Artist / Album Artist / Album / Composer
- Genre (空白区切りタグ、プレースホルダ: `e.g. House Techno Electronic`)
- Year (number) / BPM (number) — 横並び
- Track # / Of / Disc # / Of — 横並び
- Rating (★×5 + ✕ クリア)
- Comments (textarea, rows=4)
- Location (read-only パス表示)
- 保存中はボタン disabled。失敗時はエラーメッセージ。

### 3.5 ColumnPicker (モーダル)
- 単純なチェックボックスリスト (12 カラム)。閉じる以外の操作はチェック ON/OFF のみ。

### 3.6 RipDialog (モーダル — 💿 Rip CD)
**ステート機械**: `idle → detecting → looking-up → ready → ripping → done`、エラー時 `error`。

**ステップ**:
1. **Drive 入力**: OS 別デフォルト (`D:` / `disk1` / `/dev/cdrom`) + `🔍 Detect Disc`。
2. **TOC 検出 + MusicBrainz lookup**:
   - 検出後、MB 候補があれば select で選択 (アーティスト — タイトル (年) [国])。
   - 候補なし時は「No matching release. Files will be named "Track NN"...」と Disc ID を表示。
   - 候補にカバーアートがあれば直下に表示。
3. **トラック選択**: チェックボックスリスト (全選択/全解除リンクあり)。各行: `#` / Title (Artist) / 長さ。
4. **Format**: FLAC (推奨) / ALAC / MP3 320kbps / WAV。
5. **Output**: 入力欄 + `📁 Browse` ボタン。
6. **Add ripped tracks to library** チェック (デフォルト ON)。
7. **▶ Start Ripping (N)** で実行。

**進捗表示**:
- 専用 `<pre>` 領域にイベントを行追加 (現状は等幅テキストログ)。イベント種別: `start / trackStart / trackProgress / trackDone / done / error`。
- 完了後は ✅ メッセージと `Close` ボタンのみ表示。

### 3.7 RulesPanel (モーダル — ⚙️ Playlist Rules)
**目的**: YAML で書いた宣言的ルールから、レーティング/BPM/ジャンル/含有プレイリストなどの条件でプレイリスト群を自動生成・更新する。

**レイアウト**: 横並び 2 ペイン
- 左: CodeMirror (YAML、ダークテーマ、行番号 / ハイライト / 折りたたみ / 自動補完)
- 右: プレビュー結果 (ツリー表示)

**ツールバー** (上部):
- 📂 Open / 💾 Save / 💾 Save As… (YAML ファイル入出力)
- ✓ Validate (構文チェックのみ)
- 👁 Preview (primary、ライブラリに対して評価しツリー生成)
- ▶ Apply to Library (preview 後のみ有効、確認ダイアログあり)

**プレビュー**:
- 統計: `N playlists · M folders · K tracks`
- ASCII ツリー (├ └ │) でフォルダ階層を表示、各プレイリスト行末に `(track count)`。
- 適用結果: `✅ Applied: X playlists, Y folders (replaced existing namespace)`。

**永続化**:
- YAML 編集中はセッションストレージに自動保存 (`rules-yaml-draft`)。
- ファイルパスを覚えるので `Save` は上書き、`Save As…` で別名保存。

---

## 4. 操作モデル / ユーザーフロー

### 4.1 主要フロー

**初回利用**:
1. `📥 Import XML` で iTunes Library.xml を読み込む、または `🎵 Add Files`、または `💿 Rip CD`。
2. ライブラリにトラックが現れる。
3. 左サイドバーから「All Tracks」「Albums」「Artists」「Recently Played」と各プレイリストを切替。

**プレイリスト作成と編集**:
1. サイドバーの `＋` をクリック → 名前入力。
2. TrackTable でトラック選択 → 右クリック → 「Add to playlist」→ 対象を選択。
3. プレイリストを表示中に右クリックで「Remove from this playlist」。

**再生**:
1. トラックをダブルクリックで現在のリストをキュー化して再生。
2. PlayerBar / キーボードショートカット (Space / J / K / S / R / ↑↓) で制御。

**メタデータ編集**:
1. トラックを選択 → `Cmd/Ctrl+I` または右クリック「Get Info / Edit」。
2. TrackEditor で全フィールドを編集。
3. ★ レーティングは TrackTable / TrackEditor 両方からインライン編集可。
4. ジャンルタグは「タグの集合」として `Add / Remove tag` を選択行群に対して一括適用可。

**CD リッピング**:
- Drive 入力 → Detect → MB 候補選択 → トラック選択 → Format/Output 指定 → Start。
- 進捗ログをライブで確認 → 完了後ライブラリに自動追加。

**宣言的プレイリスト**:
- Rules を開く → YAML 編集 → Validate → Preview → Apply。
- `namespace` 配下のフォルダ階層を毎回置換するモデル (`removeExistingNamespace`)。

### 4.2 キーボードショートカット (グローバル)
- `/` — 検索フォーカス
- `Cmd/Ctrl + F` — 検索フォーカス (input 内でも有効)
- `Cmd/Ctrl + L` — All Tracks へ
- `Cmd/Ctrl + I` — 選択中先頭トラックを TrackEditor で開く
- `Space` — Play / Pause
- `Enter` — 選択中先頭トラックを再生
- `J` — 前のトラック / `K` — 次のトラック
- `S` — シャッフルトグル / `R` — リピートサイクル (off → all → one)
- `↑ / ↓` — 音量 ±0.05
- `Esc` — input から blur、検索クリア

### 4.3 マウスインタラクション規約
- 単クリック: 選択 / ナビゲーション
- ダブルクリック: 再生 (TrackTable / AlbumView) または名前変更 (Sidebar)
- 右クリック: コンテキストメニューまたは prompt (Sidebar)
- `Ctrl/Cmd + クリック`: 追加選択
- `Shift + クリック`: 範囲選択

---

## 5. 状態モデル (UI 側)

### 5.1 Zustand store (`useStore`)
**ビュー状態**:
- `viewMode`: `"library" | "playlist" | "recent" | "albums" | "artists"`
- `selectedPlaylistId: number | null`
- `searchQuery: string`

**データ**:
- `tracks: Track[]` (現在ビューに対応)
- `playlists: Playlist[]` (全件)
- `selectedTrackIds: Set<number>`
- `isLoading`, `hasMore` (ページング制御)

**再生状態**:
- `playback: { isPlaying, currentTrackId, positionMs, durationMs }` — Rust 側から 250ms ポーリング
- `volume`, `shuffle`, `repeat` (永続化対象)

**永続化対象 (`localStorage`)**:
- `visibleColumns`, `sortField`, `sortOrder`, `volume`, `shuffle`, `repeat`

### 5.2 主要データ型 (UI 関連)
- `Track`: id / trackId / persistentId / name / artist / albumArtist / composer / album / genre / year / rating (0〜100) / playCount / skipCount / totalTimeMs / dateAdded / dateModified / bpm / comments / locationRaw / locationPath / trackType / disabled / compilation / discNumber / discCount / trackNumber / trackCount / fileExists
- `Playlist`: id / playlistId / persistentId / parentPersistentId / name / isFolder / isSmart / isUserCreated / trackCount
- `PlaybackState`: isPlaying / currentTrackId / positionMs / durationMs
- `QueueState`: trackIds / currentIndex / shuffle / repeat / volume
- `Rating`: 0〜100 の整数 (UI 上では 0〜5 ★、`stars = round(rating / 20)`)

---

## 6. 現状の見た目 / 視覚スタイル

### 6.1 カラーパレット (現行 — ダーク)
| トークン               | 値                             | 用途                      |
| ---------------------- | ------------------------------ | ------------------------- |
| `--bg-primary`         | `#1e1e1e`                      | アプリ背景                |
| `--bg-secondary`       | `#2a2a2a`                      | サイドバー、ツールバー    |
| `--bg-tertiary`        | `#383838`                      | ボタン / 入力背景         |
| `--bg-hover`           | `#353535`                      | ホバー                    |
| `--bg-selected`        | `#0a4d8c`                      | 選択行 (青)               |
| `--bg-row-stripe`      | `rgba(255,255,255,0.02)`       | 偶数行                    |
| `--text-primary`       | `#e8e8e8`                      | 本文                      |
| `--text-secondary`     | `#a8a8a8`                      | サブ / メタ               |
| `--text-muted`         | `#6c6c6c`                      | プレースホルダ・カウント  |
| `--accent`             | `#ff3b5c`                      | プライマリ (Import など)  |
| `--accent-hover`       | `#ff5a78`                      | プライマリ hover          |
| `--accent-blue`        | `#4ea8de`                      | 二次アクセント            |
| `--border`             | `#3a3a3a`                      | 区切り線                  |
| `--border-strong`      | `#4a4a4a`                      | 強調枠                    |
| `--playing`            | `#2ecc71`                      | 再生中表示 (緑)           |
| `--warning`            | `#f39c12`                      | 警告 (missing など)       |

### 6.2 タイポグラフィ
- ベース 13px、System UI スタック (`-apple-system, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans CJK JP"`)。
- `user-select: none` がアプリ全体にかかっている (テキスト選択不可、ネイティブアプリ風)。

### 6.3 行高 / 密度
- TrackTable 行: 28px (高密度を優先)
- Sidebar アイテム: 約 24px

### 6.4 アイコン
- 絵文字を多用 (📥 🎵 💿 ⚙️ 📤 🎶 🎤 🕐 ▶ ⏸ ⏹ ⏮ ⏭ 🔀 🔁 🔂 🔊 ★ ☆)。
- カスタム SVG は使っていない (置換余地あり)。

---

## 7. UI 再設計時の論点 / 既知の弱点

再デザインに際して特に考慮してほしいポイントです。

### 7.1 視覚デザイン
- **絵文字アイコンの代替**: トーン / 解像度が OS によりバラつく。SVG アイコンセット (Lucide / Phosphor 系) への置き換えを検討。
- **アクセントカラー (`#ff3b5c`) の用途過多**: プライマリ・現在再生・通知の区別が弱い。
- **アルバムアート未表示**: AlbumView / PlayerBar / TrackTable いずれもアートワークの表示余地がある。
- **コンテキストメニュー右クリックがネイティブ `prompt()` の場面 (Sidebar の右クリック)** が残っている。

### 7.2 情報密度と可読性
- TrackTable は密度優先 (28px) のため、タッチ操作・視認性で不利。密度トグル (Comfortable / Compact) があると望ましい。
- ジャンルチップが空白区切りでカラム内に並ぶため、長いタグの折り返しが煩雑。
- 行ストライプ + 選択色 + 再生色 + missing 色が同時発生する場合の優先順位ルールが暗黙。

### 7.3 ナビゲーション
- 「現在の viewMode」と「現在のプレイリスト」が両方ハイライトされる場面があり混乱しやすい。
- プレイリスト数が増えるとサイドバーが縦長になる (折りたたみフォルダ・検索フィルタなし)。
- Recently Played が単一固定ビュー (件数調整不可)。

### 7.4 モーダルとレイアウト
- RipDialog / RulesPanel / TrackEditor がすべて同じ「画面中央モーダル」で重ね順がフラット。
- RulesPanel は CodeMirror + ツリーの 2 ペインだが画面領域を最大化する手段がない (フルスクリーン化、フローティング、リサイズ未対応)。
- 進捗ログがプレーンテキスト `<pre>` のままで、ステータス可視化 (進捗バー、トラックごとの状態カード等) の余地が大きい。

### 7.5 操作性
- 右クリック「Add to playlist…」はプレイリスト全件がそのまま縦に並ぶ (検索 / 階層なし) ためスケールしない。
- ドラッグ&ドロップでのプレイリスト追加・並び替えが未実装。
- スマートプレイリスト (`isSmart`) の編集 UI がない。

### 7.6 アクセシビリティ
- 配色のコントラスト未検証。
- フォーカスリングがほぼ表示されない。
- スクリーンリーダー向けの ARIA ロール / ラベルがほぼ未付与。

---

## 8. 画面別ワイヤー (現状の論理構造)

### 8.1 メイン画面 (TrackTable)
```
┌─Sidebar───────────────┬─Toolbar (アクション + Stats + Status)──┐
│ LIBRARY               ├──Search──────────────────────────────────┤
│  🎶 All Tracks   *    │                                          │
│  💿 Albums            │ ┌─Header (sortable cols + ⚙︎)──────────┐ │
│  🎤 Artists           │ │ Track | Artist | Album | ★ | … | Time│ │
│  🕐 Recently Played   │ ├──────────────────────────────────────┤ │
├────────────────────── │ │ row (selected)                       │ │
│ PLAYLISTS    + 📁＋  │ │ row                                  │ │
│  📁 Folder            │ │ row (playing) ▶                      │ │
│   🎵 Sub PL  (12)    │ │ row (missing) ⚠                      │ │
│  🎵 Top Hits  (87)   │ │ …                                    │ │
│  ⚙️ Smart PL  (—)    │ └──────────────────────────────────────┘ │
├───────────────────────┴──PlayerBar (ctrl|info|seek|vol)──────────┤
└──────────────────────────────────────────────────────────────────┘
```

### 8.2 Albums / Artists ビュー
```
[Album card]   [Album card]   [Album card]
 💿 Title       💿 Title       💿 Title
 Album Artist   Album Artist   Album Artist
 12 tracks ·    8 tracks ·     14 tracks ·
 1:02:30        45:11          1:18:09     [▶]

(展開時)
 ┌─Tracklist────────────────────┐
 │ 01  Song name          3:22 │
 │ 02  Song name (playing)2:58 │  ← currentTrack の場合
 │ 03  Song name          4:11 │
 └──────────────────────────────┘
```

### 8.3 RipDialog
```
┌─💿 Rip CD──────────────────────────────────────×─┐
│ Drive: [/dev/cdrom    ] [🔍 Detect Disc]         │
│                                                  │
│ MusicBrainz (3 candidates)                       │
│ [▾ Artist — Album (2003) [JP]                ]   │
│ [cover art image]                                │
│                                                  │
│ Tracks                       [Select all]        │
│ ☑ 01  Title — Artist                3:22         │
│ ☑ 02  Title — Artist                4:11         │
│ …                                                │
│                                                  │
│ Format: [▾ FLAC — 可逆圧縮 (推奨)              ] │
│ Output: [/path/to/dir      ] [📁 Browse]         │
│ ☑ Add ripped tracks to library                   │
│                                                  │
│                          [Cancel] [▶ Start (10)] │
└──────────────────────────────────────────────────┘
```

### 8.4 RulesPanel
```
┌─⚙️ Playlist Rules — /path/to/rules.yml──────────×─┐
│ [📂Open][💾Save][💾SaveAs…]│[✓Validate][👁Preview][▶Apply]│
│ ───────────────────────────────────────────────────────── │
│  ✓ Syntactically valid.                                   │
│ ┌─CodeMirror (YAML)───────┬─Preview───────────────────┐  │
│ │ 1  namespace: "..."     │ N playlists · M folders   │  │
│ │ 2  options:             │                           │  │
│ │ 3    removeExisting…    │ _Generated                │  │
│ │ 4  playlists:           │  ├ Base/Favorites          │  │
│ │ 5    - name: "..."      │  │  └ 4stars+ (245)        │  │
│ │ …                       │  └ BPM/Favorites           │  │
│ │                         │     ├ 080-085 (12)         │  │
│ └─────────────────────────┴────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

### 8.5 TrackEditor
```
┌─ℹ Track Info────────────────────────────────×─┐
│ Name        [____________________________]    │
│ Artist      [____________________________]    │
│ Album Artist[____________________________]    │
│ Album       [____________________________]    │
│ Composer    [____________________________]    │
│ Genre       [House Techno Electronic______]   │
│ Year [2024]   BPM [128]                       │
│ Track #[03] Of [12] Disc #[1] Of [1]          │
│ Rating  ✕ ☆ ★ ★ ★ ☆                          │
│ Comments [textarea]                           │
│ Location: /path/to/file.flac                  │
│                       [Cancel] [Save]         │
└───────────────────────────────────────────────┘
```

---

## 9. 再設計の方向性として議論したい論点 (任意)

設計上の決定が必要な観点を箇条書きで列挙しています。

- **テーマ**: ダーク固定で良いか、ライト / システム連動を導入するか。
- **アクセント**: 赤 (`#ff3b5c`) を維持するか、より中性なブランドカラーに置換するか。
- **アートワーク戦略**: 一覧 / カード / プレーヤー / フルスクリーンプレーヤーへの段階的な拡大表示。
- **密度モード**: Comfortable / Compact / Dense の 3 段階トグル。
- **ナビゲーションの再構成**:
  - Sidebar をフォルダ折り畳み + プレイリスト検索付きに。
  - Recently Played を期間フィルタ化、Most Played / Top Rated などスマートビューを追加。
- **モーダルの位置付け**: RulesPanel・RipDialog を「フルスクリーンに展開可能なパネル」に。
- **再生キューの可視化**: 現状は内部状態のみ、Now Playing パネル (上または右) でキュー / Up Next を表示。
- **アクション集約**: Toolbar / Sidebar / 右クリックメニューに散らばる「プレイリストへ追加」を統一。
- **キーボードショートカット一覧の表示**: `?` で開くチートシートモーダル等。
- **国際化**: 現状英語 + 日本語混在 (RipDialog の Format 説明など)。多言語前提に整理。

---

## 10. 参考: ファイル構成 (UI 関連)

```
src/
├── App.tsx                       # ルート (グリッド配置 + ショートカット)
├── main.tsx
├── styles.css                    # 単一 CSS (1300+ 行)
├── components/
│   ├── Toolbar.tsx               # 上部
│   ├── Sidebar.tsx               # 左
│   ├── SearchBar.tsx
│   ├── TrackTable.tsx            # 中央 (リスト)
│   ├── AlbumView.tsx             # 中央 (アルバム/アーティスト)
│   ├── PlayerBar.tsx             # 下部
│   ├── TrackEditor.tsx           # モーダル: メタデータ編集
│   ├── ColumnPicker.tsx          # モーダル: カラム選択
│   ├── ripper/RipDialog.tsx      # モーダル: CD リッピング
│   └── rules/RulesPanel.tsx      # モーダル: YAML ルール
├── store/useStore.ts             # Zustand store (永続化付き)
├── types/                        # TS 型定義 (track / playlist / playback / ...)
└── api/                          # Tauri command の薄ラッパ
```

---

このドキュメントを元に、現状の機能を保ちながら **視覚的洗練度・情報設計・操作性** を再構築するデザインを起こしてほしい、というのが想定する利用ケースです。
