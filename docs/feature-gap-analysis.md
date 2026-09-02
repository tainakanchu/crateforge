# Crateforge 機能ギャップ分析（2026-09-02 時点）

デスクトップ v0.11.1 のソースを精読した結果。行番号は当時点のもの。
「音楽アプリとして何が足りないか」を、(1) 構造的な問題 (2) 機能の欠落 (3) 既存 issue との対応、の順で整理する。

---

## 0. 結論（優先順）

| # | 問題 | 種別 | 規模 | 既存 issue |
|---|---|---|---|---|
| 1 | ツールバーが折返し・オーバーフロー無しで **1280×720 でも Settings が消える** | バグ | S | なし |
| 2 | ツールバー 16 ボタンがフラット。うち 3 つは一生に一回の設定 | IA | M | #130 (Command Palette) が受け皿 |
| 3 | 再生キュー・再生位置がプロセス内メモリのみ。**再起動で Up Next が消える** | 欠落 | S | #132 (Handoff) の前提 |
| 4 | モバイル/TV は shuffle/repeat を永続化していない。デスクトップは保存するがリモート操作と同期しない | 欠落 | S | なし |
| 5 | **フォルダ再帰取り込みがない**。ライブラリ投入経路が iTunes XML しか実質ない | 欠落 | S | なし |
| 6 | **プレイリスト内ドラッグ並替**: バックエンド API はあるが呼び出し元ゼロ（README は「対応」と記載） | 欠落 | S | なし |
| 7 | Artists ナビは 50,000 曲を一括フェッチしてクライアント集約・非仮想化・ソート無視 | 性能/IA | M | backlog に一部 |
| 8 | Albums 表示で検索/プレイリスト時はカードが **ソートされない**（初出順）。Year/Rating でソートしてもカードに値が出ない | UX | S〜M | なし |
| 9 | Sort Album / Sort Artist（読み）を保持していない。日本語ライブラリは codepoint 順 | 欠落 | M | なし |
| 10 | Audition モードは `A` キー以外に入口も出口もなく、しかも永続化される | IA/バグ | S | なし |
| 11 | タグのファイル書き戻しが「整理先フォルダ設定済み」の時だけ動く。HTTP API 経由は無条件 | 挙動不整合 | S | なし |
| 12 | Key を file tag にも XML にも書かない。rekordbox に持ち出すと BPM 以外の解析が消える | 欠落 | S | なし |
| 13 | クレート/トリアージ/ギグスナップショットが localStorage。バックアップ・同期対象外 | データ安全 | M | #93 |
| 14 | Gapless が意図的に無効（rodio panic 回避）。曲間に 100ms ポーリング分のギャップ | 欠落 | L | なし |

---

## 1. ホーム画面の IA（「全機能フラット」の実態）

### 1.1 棚卸し
起動時デフォルト: `viewMode:"library"`, `displayMode:"list"`, 右レール表示・Crate タブ（`useStore.ts:332-391`）。
グリッドは `202px | 1fr | 348px` + 下部 78px（`styles.css:101-108`）。

- **Toolbar 16 要素**（`Toolbar.tsx:295-506`）: 検索 / List・Albums・Tracks / Sort / Columns / サーバーから取り寄せ / Import XML / Add Files / Rip CD / Rules / 整理先フォルダ / Export XML / 自動エクスポート / 右ペイン / 設定。
  - 9 個がアイコンのみ。`Import XML` と `サーバーから取り寄せ` が **同じ download アイコンで隣接**（`:423`, `:431`）。
  - `整理先フォルダ`（一生に1回）→ `Export XML`（稀）→ `自動エクスポート`（一生に1回）→ `右ペイン`（毎日）→ `設定` の並び。頻度が混在。
  - `Columns` が `displayMode` で出没するため右側ボタンの位置が動く（`:399`）。
- **Sub-bar**（`:508-539`）: タイトル / 選択数 / 解析中 / `status` 文字列（**消えない**。`setStatus("")` の経路が存在しない）/ 統計。
- **Sidebar**（`Sidebar.tsx:402-544`）: Library 4 項目 + 新規作成アイコン 3 個（空白右クリックメニューと完全重複 `:515-538`）。
- **RightRail**（2,075 行）: Now / Up Next / Crate / Similar / Split / 戻る。348px に 40+ の操作要素。Similar のフィルタ 6 個は local state で **毎回リセット**（`RightRail.tsx:1601-1660`）。
- **PlayerBar 14 要素**（`PlayerBar.tsx:188-369`）。`RG` は設定であって再生操作ではない（Settings にも同じ項目あり）。
- **ステータス表示 10 面**: Sub-bar の status / 統計 / 解析中、filter chips、UpdateBanner、Inbox バナー、DiscDetectedBanner、RipStatusBar、Toaster、PlayerBar バッジ。

### 1.2 モードの出入り
| モード | 入口 | 出口 | 問題 |
|---|---|---|---|
| Triage | Inbox バナー / `T` | Esc / 終了ボタン / ナビ | **唯一まともに設計されている**。他の手本 |
| Audition | `A` のみ（`App.tsx:878`） | `A` のみ | UI に入口ゼロ。バッジはクリック不可。**persist される**（`useStore.ts:712`） |
| Preview | Crate/Similar 行の波形アイコン | Esc のみ | バッジがクリックで抜けられない |
| Set Workspace | Crate タブ内 `set` トグル | 同 | `setToolsOpen` は非永続。セット名・目標尺は常時表示で分断 |
| Gig Readiness | Crate タブ内 `Ready?` のみ | — | Crate タブを開かないと存在に気づけない |
| Sync 系 | 「サーバーから取り寄せ」1 ボタン | 各 onBack | 2,619 行の機能が 1 ボタンの裏 |
| ShortcutHelp | `?` のみ | — | 「キーボード専用機能の一覧が、キーボード専用」 |

副作用によるタブ強制切替: `addToCrate` → crate（`useStore.ts:434,447`）、`setSimilarBase` → similar（`:651-654`）。Split ボタンの点灯条件が `railSplit` そのもので、Now タブでは分割されないのに点灯したまま（`RightRail.tsx:1903` vs `:251-252`）。

### 1.3 死にコード
`viewMode:"albums"` は `setViewMode("albums")` の呼び出しが存在しない（`types/playback.ts:12`, `Toolbar.tsx:45`, `App.tsx:945` に残骸）。サイドバーに Albums がなく、ツールバーの表示切替にだけ Albums がある状態。

### 1.4 重複経路
- Crate へ追加: 7 経路。Similar 基準設定: 5 経路。取り込み: 5 経路。
- 同一設定が 2 箇所: 自動エクスポート / 整理先ルート / ReplayGain（ツールバー or PlayerBar と SettingsDialog）。

### 1.5 提案するグルーピング
- **一次ナビ（サイドバー）**: All / Inbox / Recent / Artists / Playlists + **`Sets` を昇格**（Crate・Similar・Set tools・Gig Readiness を中央ペインへ）。設定はサイドバー最下部へ。
- **コンテキストツールバー ≤6**: 検索（スコープ明示）/ 表示切替 / Sort（inbox・recent では disabled）/ Columns / 右ペイン / `⋯`。
- **Library メニュー or Command Palette（#130）**: Import XML / Add Files / Rip CD / 取り寄せ / Export / Rules / Audition 切替 / ショートカット一覧 / Gig Readiness。
- **Settings に一本化**: 整理先フォルダ / 自動エクスポート / ReplayGain。
- **右レール**: Now / Up Next の 2 タブに縮小。`railSplit`・`compact`・`showRichMeta>=420` の 3 分岐と compact 二重実装（`RightRail.tsx:1352-1470`）が消える。
- **必須修正**: AUDITION / PREVIEW バッジをクリックで解除可能に。`auditionMode` を partialize から外す。副作用タブ切替を廃止しバッジ表示に。`status` に自動消滅。

---

## 2. ウィンドウサイズ（実測済み）

`pnpm dev` + headless Chromium で 1280×720 / 1024×640 / 900×600 / 800×500 を撮影。`styles.css` 5,617 行に `@media` は **1 つ**（`:5201`、Triage 専用）。`tauri.conf.json` の minWidth 900 / minHeight 600 はこの時点で既に破綻している。

| 順 | 症状 | 原因 | 修正 |
|---|---|---|---|
| 1 | **1280×720 で「取り寄せ」以降（Settings 含む）が消える**。900×600 では表示切替しか残らない | `.cb-tb` に `flex-wrap` も `overflow-x` もなく、`.cb-main` の `overflow:hidden` で無音クリップ（`styles.css:282-300`, `358-411`） | actions を `overflow-x:auto` or 閾値でオーバーフローメニュー化 or `flex-wrap` |
| 2 | 検索欄がアイコンのみになる | `.cb-sbox` に `min-width` なし（`:302-313`） | `min-width:140px` |
| 3 | 右レール幅（280-560px、persist）がウィンドウ幅でクランプされない。900px で中央が 138px になる | `useStore.ts:96-102`、resize リスナー無し | `innerWidth` でクランプ |
| 4 | PlayerBar のミュート・音量が右レールに食い込む | `.cb-seek` が `width:460px` 固定、`.cb-pr` に `min-width:0` なし（`:2449-2454`, `:2532-2537`） | `min-width:0` + seek の下限縮小 |
| 5 | ダイアログの Save/Cancel が `.modal-body` 内スクロール領域にある（GigReadiness 以外全部） | `.modal-footer` 相当が存在しない | footer を `flex-shrink:0` で分離 |

現状で全ボタンが見えるのは **≈1500px 以上**（右レール既定幅時）。#1 と #3 を直した上で minWidth 1100-1200 / minHeight 640 程度が妥当。

---

## 3. アルバム表示

### 3.1 2 実装の併存
- `AlbumView.tsx`: サイドバー `artists`（と死にモード `albums`）用。**常時アルファベット順でソート無視**（`:66-68`）、非仮想化 `.map()`（`:111-182`）、`getTracks(50000, 0)` 一括取得（`App.tsx:198-202`）。ツールバーの Sort は表示されたまま効かない。
- `AlbumsView.tsx`: 表示切替 `displayMode:"albums"` 用。ライブラリスコープではサーバ集約 + 仮想化 + ページング。**検索/プレイリスト/Recent スコープでは `groupAlbums()` がソートせず、トラック順の初出順でカードが並ぶ**（`:91-147`、末尾に `.sort()` なし）。BPM 昇順で「最初に該当した曲の BPM 順」にカードが並ぶ = ランダムに見える。

### 3.2 グルーピングの不整合
- サーバ `ALBUM_KEY_EXPR`（`db/tracks.rs:60-64`）: 空 album → `tr:`、compilation → `cmp:`、それ以外 `al:albumArtist|artist + album`。albumArtist 未設定で feat. 曲があると **1 枚が複数カードに分裂**。一部だけ compilation=1 なら 2 枚に分裂。
- クライアント `groupAlbums`（`AlbumsView.tsx:96-101`）は compilation 判定を空 album 判定より **先** にやるので、無題 compilation 曲が全部 `cmp:` に合流。サーバと逆順。
- `AlbumView.tsx:43` のキーが `${album} ${aa}` のスペース連結で衝突しうる。compilation 処理なし → Artists ビューではコンピが曲ごとのアーティストに散る。
- 検索用の CJK fold（`text_fold`）はグルーピング・ソートには未適用。

### 3.3 ソートの問題
- `album_order_by`（`db/tracks.rs:122-149`）に最終 tie-break がない（`build_order_by` は `track_id ASC` を付けている）。year/rating が同値の時 `LIMIT/OFFSET` ページ間で **重複・欠落** が起きうる。
- `rating` は `MAX`、`date_added` は `MAX` で集約。1 曲 5★ でアルバム全体が上位、1 曲再インポートで古いアルバムが「最近追加」に。
- カードは title / artist / 件数しか出さない。**Year / Date Added / Rating / Plays でソートしても根拠が見えない**（`AlbumsView.tsx:536-600`）。`bpmMin/Max` は計算されるが未表示。
- `COLLATE NOCASE` は ASCII のみ。Sort Album / Sort Artist を保持していない（全コード grep ヒットなし）。
- `get_artists`（`db/tracks.rs:1209-1233`）は HTTP API 専用でデスクトップ未使用。

### 3.4 修正順
1. `AlbumView.tsx` の Sort 無視を直すか、`artists` 時は Sort/表示切替を disabled に。
2. `groupAlbums()` の末尾で `ALBUM_SORT_FIELDS` によるソート。
3. カードにソートキーの値を表示（`AlbumVM` に year 等を通す）。
4. `album_order_by` に `album_key ASC` を付与。
5. クライアントとサーバのキー優先順位を統一。
6. Artists を `get_artists` 経由 + 仮想化に。
7. Sort フィールド（読み）の保持と照合順序。

---

## 4. 「覚えてくれない」状態

### 4.1 デスクトップ
- `shuffle` / `repeat` / `volume` / `replayGain` は **persist 済み**（`useStore.ts:701-704`）で、起動時に Rust へ push（`App.tsx:349-357`）。
- ただし `PlaybackState` は `isPlaying/currentTrackId/positionMs/durationMs` のみ（`types/playback.ts:1-6`）。Rust 側の shuffle/repeat/volume を **読み戻す経路がない**。モバイルや Web プレーヤーから `POST /api/remote/shuffle` で切り替えると、デスクトップの UI は古いまま、次回起動で古い値を再 push して上書きする。
- 非永続: 再生キュー（Rust メモリのみ、DB テーブルなし）、再生中トラックと位置、`viewMode` / `selectedPlaylistId`、`filterTags`、Similar フィルタ 6 個、`setToolsOpen`、ウィンドウサイズ・位置（window-state plugin 未導入）。

### 4.2 モバイル / TV
- 共通ストア `clients/packages/core/src/store/player.ts` に persist なし。`shuffle:false` / `repeat:"off"` で毎回起動（`:147-148`）。`useSettings` は SecureStore で hydrate しているのでパターンは既にある（`settings.ts:131`）。
- Web プレーヤー（`api/webplayer.html:946-948`）だけは localStorage で覚えている。

### 4.3 シャッフルのアルゴリズム
- **デスクトップ（Rust）は決定的**。`order` は `queue` の順列で、`set_shuffle(true)` 時は現在位置より後だけを一回シャッフルし、以降 `advance_next` はその順列を辿るだけ（`audio/mod.rs:496-525`, `557-590`）。再抽選が起きるのは (a) `set_queue`（テーブルのダブルクリック等、全 8 箇所）、(b) repeat=All で末尾から先頭へ戻る時、の 2 つのみ。
- ただし **Up Next の更新に競合**がある。`handleShuffleToggle` はストアを先に更新してから backend を await する（`PlayerBar.tsx:160-164`、`App.tsx:908-910` も同様）。RightRail は `shuffle` の変化で即 `loadQueue()` するため（`RightRail.tsx:309-325`）、backend が並び替える前の旧順を取得し、1 秒後の interval で新順に差し替わる。「Next リストが変なタイミングで変わる」の正体はこれ。
- **モバイル / TV（`@crateforge/core`）は非決定的**。`next()` が shuffle 時に `randomOtherIndex` で毎回ランダム抽選（`clients/packages/core/src/store/player.ts:114-119`, `212-214`）。順列を持たないので同じ曲が繰り返し当たり、`prev` はシャッフル履歴ではなく `index-1` に戻り、Up Next も定義できない。デスクトップと挙動が食い違っている。

### 4.4 対応
- モバイル `usePlayer` を Rust と同じ「順列 + 位置」モデルに揃える（shuffle ON で order を生成、next/prev は order を辿る）。
- デスクトップは backend の `set_shuffle` 完了後にストアを更新する（または `loadQueue` を await 後に呼ぶ）。
- `PlaybackState` に shuffle/repeat/volume を含め、ポーリングでストアを同期（真実を Rust 側に一本化）。
- キューと再生位置を SQLite に保存し起動時に復元（#132 Handoff の土台にもなる）。
- モバイル `usePlayer` に persist を追加。
- `tauri-plugin-window-state` 導入。

---

## 5. 機能インベントリ（Present / Partial / Absent）

Tauri command 96 個、HTTP route 42 本を起点に確認。

### 5.1 テーブルステークス（音楽アプリとして無いとまずい）
| # | ギャップ | 状態 | 規模 | 着手点 |
|---|---|---|---|---|
| 1 | フォルダ再帰取り込み | Absent。Add Files は `directory:false`、D&D はフォルダを捨てる | S | `importer/mod.rs`, `Toolbar.tsx:191`, `useFileDropImport.ts:41` |
| 2 | プレイリスト内ドラッグ並替 | Absent。`reorder_playlist_tracks` は実装・API ラッパあり・**呼び出し元ゼロ** | S | `src/api/playlists.ts:62` → `TrackTable.tsx` |
| 3 | キュー永続化 | Absent | S | `db/schema.rs` + `lib.rs` |
| 4 | タグ書き戻しの整理先ゲート | `commands/library.rs:124-127` で organize root 未設定なら DB のみ。HTTP API は無条件で書く | S | 書き戻しと移動を分離 |
| 5 | 再スキャン・欠損ファイルの再リンク | Absent。`file_exists` は XML import 時に固定 | M | #129 Library Health |
| 6 | ライブラリからトラック削除 | Absent（sync eviction 以外に削除経路なし） | S | `TrackContextMenu.tsx` |
| 7 | Finder/Explorer で表示 | Absent（`tauri-plugin-shell` は依存済み） | S | 同上 |
| 8 | `library.db` のバックアップ / integrity / VACUUM | Absent。XML 自動エクスポートはメタデータのみ | S | `db/mod.rs` |
| 9 | localStorage → SQLite | Crate / Triage / Gig snapshot | M | #93 |
| 10 | fielded search（`artist:` `album:` `genre:` `year:` `rating:`） | `bpm:` `key:` `energy:` のみ。HTTP API には `ratingMin`/`yearFrom` 等があるがデスクトップ UI なし | S | `db/tracks.rs:153-186`, #127 |
| 11 | プレイリスト内検索 | Absent（backlog 記載済み） | S | `App.tsx:203` |
| 12 | Sort 名（読み） | Absent | M | schema + order_by + editor |
| 13 | 技術メタ（bitrate / sample rate / size / codec） | Absent | M | importer（lofty properties） |
| 14 | Gapless | 意図的に無効（`audio/mod.rs:149-159`）、曲ごとに `Player` 生成、100ms ポーリングで advance | L | `audio/mod.rs` |
| 15 | Undo | Absent | M | #126 |
| 16 | 重複検出 | Absent（Set Lint 内のみ） | M | #128 |
| 17 | 出力デバイス選択 | Absent（`open_default_sink` のみ） | M | `audio/mod.rs:80` |
| 18 | i18n | Absent。UI が日英混在（Settings 日本語、ナビ・メニュー英語） | M | 全コンポーネント |
| 19 | a11y | TrackTable に `aria-` 1 個 | M | `TrackTable.tsx` |
| 20 | Artists のサーバ集約 | 50k 曲一括 | M | §3 |

### 5.2 DJ 向け
| # | ギャップ | 状態 | 規模 |
|---|---|---|---|
| 21 | BPM / Key の file tag 書き込み | `TagWrite` に BPM・Key・rating・grouping が無い（`organizer/mod.rs:266-280`） | S |
| 22 | Key の XML 出力 | `itunes_xml/writer.rs:125-146` に tonality なし | S |
| 23 | USB へ書き出し（ファイル + 構造 + XML/M3U） | Absent。`convert_tracks` はフラット出力のみ。Gig Readiness の「最後の 1 マイル」が無い | M |
| 24 | Key の手動上書き・表記切替（Camelot / Open Key / 古典） | Absent | S |
| 25 | M3U/M3U8 | Absent | S |
| 26 | Cue / Hot cue（+ export） | Absent | L |
| 27 | ズーム波形 | peaks は保存済み、表示は PlayerBar の 1 本のみ | M |
| 28 | Crossfade | Absent | M |
| 29 | 半星 | rating は 0-100 保存済み、UI は 5 段 | S |
| 30 | Color / flag タグ | Genre のスペース区切りが唯一の分類軸。多語ジャンルが割れる | M（#124） |
| 31 | 再生統計チャート | play/skip は丁寧に集計されるが表示先ゼロ。最安の高価値機能 | S |
| 32 | Scrobble（Last.fm / ListenBrainz） | PlayReport のロジックは既に scrobble 品質 | M |
| 33 | ライブラリ全体の harmonic フィルタ（`key:compat:8A`） | Similar パネルに閉じ込められている | S |
| 34 | 計画 vs 実演の突き合わせ | snapshot と `recent_tracks` を結合するものがない | M（#123） |
| 35 | Tray / global hotkey / 曲変更通知 | Absent | M |
| 36 | Sleep timer / 再生速度をデスクトップにも | モバイルには既にある | S |

### 5.3 存在するが到達できない
1. `reorder_playlist_tracks`（呼び出し元ゼロ）
2. HTTP API 専用フィルタ（`ratingMin/Max`, `genre`, `album`, `artist`, `yearFrom/To`, `analyzed`）
3. Audition（`A` のみ）、Triage（Inbox で `T` のみ）、Gig Readiness（Crate タブ内のみ）
4. Set Workspace の Anchor / Section / Arc / Lint はショートカット一覧で `{ keys: ["UI"] }` 表記
5. モバイル限定: sleep timer / 再生速度 / offline pin / ジャンルチップ / アーティスト画面。デスクトップ限定: Crate / Gig / Rules / Rip / Convert / XML

---

## 6. 既存 open issue との対応

| issue | 本分析での位置づけ |
|---|---|
| #130 Command Palette | §1.5 のツールバー退避先。**先に IA 整理をしないとパレットに全部詰めるだけになる** |
| #129 Library Health | §5.1 #5（再スキャン・再リンク）+ #13（技術メタ）を吸収可能 |
| #128 Duplicate / Version Family | §5.1 #16 |
| #127 検索 DSL → Smart PL | §5.1 #10 の fielded search が前提 |
| #126 Activity History + Undo | §5.1 #15 |
| #124 first-class Tags | §5.2 #30 |
| #123 Set History | §5.2 #34 |
| #132 Playback Handoff | §4 のキュー永続化・PlaybackState 拡張が前提 |
| #93 Crate 永続化 | §5.1 #9 |

**issue 化されていない主要ギャップ**: ツールバーのオーバーフロー（§2）、IA 再編（§1）、アルバム表示のソート（§3）、shuffle 永続化とデスクトップ⇄リモートの状態同期（§4）、フォルダ取り込み、プレイリスト並替の配線、キュー永続化、タグ書き戻しゲート、Key の tag/XML 出力、USB 書き出し、Sort 名、gapless、出力デバイス、DB バックアップ。

---

## 7. ドキュメントの乖離
- `docs/ui-spec.md` §2-3 は現物と一致しない（Albums ナビは存在しない、ツールバーは 5 → 16、PlayerBar は 6 → 14、RightRail/Inbox/Triage/Crate/Similar/Sync/Gig の節がない）。
- README の制約節は「スマプレ条件は編集不可」（既にエディタあり）と「並び替え対応」（未配線）が逆。
