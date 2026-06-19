# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

各バージョンは **日本語** と **English** の 2 ブロックを併記します。
Each release is documented in both Japanese and English.

## [Unreleased]

## [v0.6.4] - 2026-06-19

### 日本語

#### 修正
- **一覧の曲をダブルクリックした際にアプリがまれにクラッシュする問題を修正**。音声デコーダ（一部の壊れた / 特殊なファイル）で起きうる内部エラーを捕捉し、該当曲の再生だけを失敗扱いにしてアプリ全体が落ちないようにしました。(#49)

### English

#### Fixed
- **Fixed a rare crash when double-clicking a track in the list.** Internal errors from the audio decoder (on certain corrupt / edge-case files) are now caught so that only that track fails to play, instead of crashing the whole app. (#49)

## [v0.6.3] - 2026-06-19

### 日本語

#### 変更
- **アップデートをインストーラ無しで適用**：Windows のインストール版でも、更新時に exe をその場で差し替えて再起動するだけになりました（これまではインストーラの起動が必要でした）。ポータブル版と同じシームレスな更新体験です。SmartScreen の警告も出ません。※この挙動は本バージョン以降が行う更新チェックから有効です。(#47)

### English

#### Changed
- **Updates apply without the installer**: on Windows, the installed build now updates by swapping the exe in place and relaunching instead of launching the installer — the same seamless experience as the portable build (and no SmartScreen prompt). Effective for update checks performed by this version onward. (#47)

## [v0.6.2] - 2026-06-19

### 日本語

#### 追加
- **プレイリスト単体取得 API `GET /api/playlists/{playlistId}` を追加**：プレイリストのメタ情報に加えて、スマートプレイリストの条件 `smartCriteria` を返します。これにより dj-curator スキルが既存プレイリスト（過去のセット）を“お手本”として読み、選曲傾向（ジャンルの混ぜ方・並びの締まり具合・かっちり/アドリブ など）を分析に活かせるようになりました。(#43)
- **クラッシュ調査用のログ基盤を追加**：パニック発生時にメッセージと発生箇所（ファイル名・行番号）を `crateforge.log`（アプリデータフォルダ）に記録します。GUI 起動では標準エラー出力が残らないため、これまで原因を追えなかったクラッシュの発生箇所を特定できるようになります。(#45)

### English

#### Added
- **Single-playlist endpoint `GET /api/playlists/{playlistId}`**: returns the playlist's metadata plus its smart-playlist `smartCriteria`. This lets the dj-curator skill read existing playlists (past sets) as references and analyze curation tendencies (genre mixing, how tightly tracks are sequenced, rule-based vs. hand-picked, etc.). (#43)
- **Crash logging**: on panic, the message and location (file:line) are written to `crateforge.log` in the app data folder. Since stderr is not retained for a GUI launch, this makes it possible to pinpoint where previously-untraceable crashes occur. (#45)

## [v0.6.1] - 2026-06-19

### 日本語

#### 追加
- **内蔵 API に曲メタデータの書き込みを追加**：`POST /api/tracks/genre-tags/add` ・ `/remove` でジャンルタグを末尾に増減でき、`PATCH /api/tracks/{id}` で name / artist / album / genre / year / bpm / rating などの任意フィールドを部分更新できます。DB 更新に加えて**実ファイルの ID3 / Vorbis / MP4 タグへ書き戻し**（フォルダ移動はせずタグのみ更新）、書き込み後は GUI に即時反映します。dj-curator プラグインの選曲スキルもこの API に対応しました。(#39)

#### 変更
- アクセントカラーをアプリアイコンの色 **#6CA1B5** に統一しました。(#42)

### English

#### Added
- **Metadata writing in the built-in API**: `POST /api/tracks/genre-tags/add` / `/remove` append or remove a genre tag, and `PATCH /api/tracks/{id}` partially updates arbitrary fields (name / artist / album / genre / year / bpm / rating, etc.). Beyond the DB, changes are **written back to the actual file's ID3 / Vorbis / MP4 tags** (tags only, no folder move) and reflected in the GUI immediately. The dj-curator curation skill now uses this API too. (#39)

#### Changed
- Unified the accent color to the app icon color **#6CA1B5**. (#42)

## [v0.6.0] - 2026-06-19

### 日本語

#### 追加
- **CJK 字体ゆれ吸収検索**：繁体字 / 簡体字 / 日本語漢字・かな(ひら↔カタ)・全角半角・英大小を正規化し、どの字体で入力しても横断的にヒットする。強度はユーザー設定（オフ / 軽量 / 標準）。検索ボックス・内蔵 API・スマートプレイリストに適用。(#32)
- **dj-curator プラグインの強化**：選曲ワークスペースを対話で初期化する `/dj-curator:init-workspace` を追加。選曲ヒアリングを再設計し、非 ASCII（日本語・中国語など）クエリの URL エンコード不具合を修正。(#35)

#### 変更
- アプリアイコンを Crateforge ダイヤ（dark）に刷新。(#33)

#### その他
- ライセンスを **MIT** に設定（`LICENSE` 追加・各 manifest に明記）。(#38)
- CI を見直し：PR / push は軽量チェック（型チェック + テスト）のみとし、フル多 OS ビルドはタグ時に分離。(#37)

### English

#### Added
- **CJK variant-insensitive search**: folds Traditional / Simplified / Japanese kanji, kana (hiragana↔katakana), full/half-width, and letter case so any variant matches. Configurable strength (off / light / standard). Applies to the search box, the built-in API, and smart playlists. (#32)
- **dj-curator plugin improvements**: added `/dj-curator:init-workspace` to bootstrap a curation workspace interactively, redesigned the song-selection interview, and fixed URL-encoding of non-ASCII (Japanese / Chinese, etc.) queries. (#35)

#### Changed
- New app icon (Crateforge diamond, dark). (#33)

#### Misc
- Licensed under **MIT** (added `LICENSE`, declared in manifests). (#38)
- CI overhaul: PRs / pushes run lightweight checks (typecheck + tests) only; full multi-OS builds run on tags. (#37)

## [v0.5.1] - 2026-06-18

### 日本語

#### 修正
- **内蔵 API 経由で作成・変更したプレイリストが、起動中アプリの UI に即時反映されない問題を修正**しました。API がライブラリを変更した際に `library-changed` イベントを発火し、UI 側がプレイリスト一覧と表示中のトラックを再読み込みするようにしました。

### English

#### Fixed
- **Fixed playlists created/modified via the built-in API not appearing in the running app immediately.** The API now emits a `library-changed` event on writes, and the UI reloads the playlist list and the current track view in response.

## [v0.5.0] - 2026-06-18

### 日本語

#### 追加
- **AI エージェント連携用のローカル HTTP API サーバーを内蔵**しました。アプリの「設定 → AI 連携 / API」で有効化すると、`127.0.0.1`（既定ポート 8787）でライブラリ・解析データ・プレイリストを読み書きできる REST API を公開します。デフォルトは無効で、ループバックのみで待ち受けます。
- **DJ 選曲プラグイン `dj-curator`** を追加し、このリポジトリを Claude Code の plugin marketplace 化しました。イベントのフライヤー画像やテーマなどのインプットからコンセプトをヒアリングし、ライブラリから候補を選んで新規プレイリストの「叩き台」と選定根拠レポートを生成します（曲順は GUI で調整）。`/plugin marketplace add tainakanchu/itunes-playlist-viewer` → `/plugin install dj-curator@crateforge` で導入できます。

### English

#### Added
- **Built-in local HTTP API server for AI agents.** Enable it under Settings → "AI 連携 / API" to expose a REST API on `127.0.0.1` (default port 8787) for reading/writing the library, analysis data, and playlists. Disabled by default; loopback-only.
- **`dj-curator` DJ curation plugin**, turning this repository into a Claude Code plugin marketplace. From an input (event flyer, theme, reference track) it interviews for the concept, picks candidates from the library, and creates a new playlist "draft" plus a per-track rationale report (ordering is left to the GUI). Install via `/plugin marketplace add tainakanchu/itunes-playlist-viewer` then `/plugin install dj-curator@crateforge`.

## [v0.4.1] - 2026-06-13

### 日本語

#### 修正
- **Windows 版のリリースビルドが失敗していた問題を修正**しました。v0.4.0 で追加した OS メディアコントロール連携用クレート `souvlaki` の依存定義が、誤って `cfg(unix)` 限定のセクション配下に置かれていたため、Windows ターゲットではリンクされず `error[E0432]: unresolved import souvlaki` でビルドが落ちていました。全 OS 共通の依存として宣言し直し、Windows の SMTC を含めて正しくビルドされるようにしました（アプリの挙動に変更はありません）。

### English

#### Fixed
- **Fixed the broken Windows release build.** The `souvlaki` crate (added in v0.4.0 for OS media controls) was accidentally declared under a `cfg(unix)`-only dependency section, so it was never linked for the Windows target and the build failed with `error[E0432]: unresolved import souvlaki`. It is now declared as an all-platform dependency, so Windows (SMTC) builds correctly again. No behavioral change.

## [v0.4.0] - 2026-06-11

### 日本語

#### 変更
- **曲の自動送りを Rust 側のワーカースレッドに移行**しました。従来はフロントエンドの 500ms ポーリングが曲送りを駆動していたため、ウィンドウの最小化などで WebView がスロットルされると次の曲へ進まないことがありました。今後は UI の状態に関係なく再生が継続し、曲間の待ち時間も短くなります。次の曲のファイルが見つからない場合は自動でスキップして再生を続けます。

#### 追加
- **「Play Next（次に再生）」**をコンテキストメニューに追加しました。選択した曲（複数可・選択順を保持）を再生中の曲の直後に割り込ませます。
- **Up Next（再生キュー）の編集**：行のホバーで表示される「×」でキューから削除、ドラッグ＆ドロップで並び替えができるようになりました。
- **Up Next がライブラリの全曲を表示できるように**なりました（従来は読み込み済みページ内の曲しかタイトル解決できませんでした）。
- **OS のメディアコントロール連携を macOS / Linux にも拡張**しました（Windows: SMTC / Linux: MPRIS / macOS: Now Playing）。メディアキーと「再生中」表示が全 OS で機能します。
- **音量のキーボードショートカット**（Ctrl/Cmd+↑/↓）を追加しました。
- 残っていた Unicode 文字アイコン（CD 取り込み進捗・ルール適用結果・再生中レーティングの ★ など）を SVG アイコンに置き換えました。

### English

#### Changed
- **Track auto-advance now runs in a Rust-side worker thread.** Previously a 500ms frontend poll drove advancement, so playback could stall at track end while the window was minimized (WebView throttling). Playback now continues regardless of UI state, with shorter gaps between tracks. Missing files are skipped automatically.

#### Added
- **"Play Next"** context menu action — inserts the selected tracks (multi-select keeps selection order) right after the current track.
- **Up Next queue editing**: remove rows via the hover "×" button, reorder via drag & drop.
- **Up Next now resolves any track in the library** (previously only tracks on the loaded page could be displayed).
- **OS media controls extended to macOS / Linux** (Windows: SMTC / Linux: MPRIS / macOS: Now Playing) — media keys and Now Playing work on all platforms.
- **Volume keyboard shortcut** (Ctrl/Cmd+↑/↓).
- Replaced the remaining Unicode glyph icons (rip progress, rules result, now-playing rating ★) with SVG icons.

## [v0.3.2] - 2026-06-07

### 日本語

#### 追加
- **macOS / Linux 版の配布を開始**しました。リリースに以下を追加します（手動ダウンロード用）。
  - macOS: **未署名**の `.dmg`（Apple Silicon / Intel の各ネイティブ版）。初回は Gatekeeper の警告が出るため、右クリック→「開く」または `xattr -cr` で回避してください。
  - Linux: `.AppImage`（単一ファイル）と `.deb`。
- ※ アプリ内の自動更新は引き続き **Windows 専用**です。macOS / Linux は手動更新になります。また ffmpeg の自動取得も Windows のみで、macOS / Linux は PATH 上の ffmpeg（および CD 取り込み用の cdparanoia / flac / lame）を利用します。

### English

#### Added
- **macOS / Linux builds are now distributed** (manual download) in releases:
  - macOS: **unsigned** `.dmg` for Apple Silicon and Intel (native per-arch). On first launch, bypass Gatekeeper via right-click → Open or `xattr -cr`.
  - Linux: `.AppImage` (single file) and `.deb`.
- Note: in-app auto-update remains **Windows-only**; macOS / Linux update manually. ffmpeg auto-download is also Windows-only — on macOS / Linux the app uses ffmpeg (and cdparanoia / flac / lame for ripping) from PATH.

## [v0.3.1] - 2026-06-07

### 日本語

#### 追加
- **Windows での CD 取り込みに対応**しました。TOC 検出と CDDA の読み取りを Windows の IOCTL で直接行い（外部ツール非依存）、エンコードは自動取得済みの ffmpeg を使います（FLAC / MP3 / ALAC / WAV）。MusicBrainz / freedb の disc id も自前計算します。
- **メタデータ編集モーダルの拡充**：ジャンルを **タグチップ＋既存タグ補完** で編集できるようにし、**Compilation**（コンピレーション）トグルと、**詳細情報パネル**（形式 / 長さ / 再生回数 / スキップ回数 / 追加日 / 更新日 / 最終再生 / ファイル有無）を追加しました。
- **一覧画面からジャンルを直接編集**できるようにしました（ジャンル列のえんぴつアイコン→チップ式エディタ）。
- **サードパーティ・ライセンスの全文表示**。設定の「情報・ライセンス」から、**推移的依存を含む全パッケージ（Rust / JS）**とライセンス本文を表示します。本文を同梱していない依存にも、SPDX に応じた正規ライセンス全文を補完します。

#### 変更
- Compilation 編集はファイルのタグ（`cpil` 等）にも書き戻します。

#### 修正
- カバー（タイル）表示でカードが重なる／高さが揃わない不具合を修正しました。
- アルバム単位のカバー表示で右クリックメニューが正しく出ない不具合を修正しました（一覧と同じトラック操作メニューを表示します）。

### English

#### Added
- **CD ripping on Windows.** TOC detection and CDDA reads are done directly via Windows IOCTLs (no external tools); encoding uses the auto-downloaded ffmpeg (FLAC / MP3 / ALAC / WAV). MusicBrainz / freedb disc IDs are computed in-house.
- **Richer metadata editor**: edit Genre as **tag chips with autocomplete** from existing tags, plus a **Compilation** toggle and a **details panel** (format / duration / play & skip counts / date added & modified / last played / file presence).
- **Edit genre directly from the list view** (pencil icon on the Genre column → chip editor).
- **Full third-party license texts**: the About & Licenses settings section now lists **every package including transitive deps (Rust / JS)** with full license texts, filling in canonical SPDX texts where a package didn't bundle one.

#### Changed
- Compilation edits are also written back to the file's tags (`cpil`, etc.).

#### Fixed
- Fixed overlapping / unevenly-sized cards in the covers (tile) view.
- Fixed the right-click menu in the album-grouped covers view (now shows the same track-action menu as the list).

## [v0.3.0] - 2026-06-06

### 日本語

#### 追加
- **設定（Preferences）画面**を新設しました。ツールバー右端の⚙から開け、**一般 / 変換(ffmpeg) / アップデート / 情報・ライセンス** の4セクションを備えます。
- **ライセンス / クレジット表記**（情報タブ）。FFmpeg(GPL) や主要 OSS 依存を明記します。
- **ポータブル版（zip）配布**。解凍して `crateforge.exe` を起動するだけ・インストール不要。アプリ内アップデートは exe を直接差し替えるので高速です。

#### 変更
- **変換用 ffmpeg を同梱から「初回利用時に自動取得＋キャッシュ」へ変更**。PATH → `%LOCALAPPDATA%` のキャッシュ → 無ければ上流(BtbN)から取得、の順で解決します。**アプリを更新しても ffmpeg は保持**され、毎回の再展開が無くなります。配布物も軽量化し、GPL バイナリの再配布も回避します（CLI 経由で外部プロセスとして利用）。
- **インストーラからデスクトップショートカット作成を既定オフ**にしました。
- インストーラから ffmpeg の同梱を取りやめました（上記の自動取得に統一）。

### English

#### Added
- **Settings (Preferences) screen**, opened from the toolbar's gear, with four sections: **General / Conversion (ffmpeg) / Updates / About & licenses**.
- **License / credits** listing (About tab), explicitly noting FFmpeg (GPL) and the main open-source dependencies.
- **Portable build (zip)**: just unzip and run `crateforge.exe` — no installer. In-app updates swap the exe directly, so they're fast.

#### Changed
- **ffmpeg is no longer bundled** — it's fetched on first use and cached. Resolution order is PATH → `%LOCALAPPDATA%` cache → download from upstream (BtbN). **ffmpeg survives app updates** and is never re-extracted; downloads are smaller, and we avoid redistributing the GPL binary (it's used as an external CLI process).
- **The installer no longer creates a desktop shortcut by default.**
- Removed ffmpeg from the installer bundle (unified with the on-demand fetch above).

## [v0.2.1] - 2026-06-06

### 日本語

#### 追加
- **キーボードでの複数選択**: 曲リストで **↑ / ↓** でカーソル移動、**Shift + ↑ / ↓** で範囲拡張、**Ctrl/Cmd + A** で全選択できるようになりました。移動先へ自動スクロールします。

#### 変更
- **Shift クリックの挙動を自然に**: 直前にクリックした行を起点（アンカー）として固定し、Shift クリックで何度でも同じ起点から範囲を伸縮できるようにしました。**Shift + Ctrl/Cmd クリック**で既存の選択へ範囲を追加できます。
- **カバー表示をアルバム単位に集約**: 同じアルバムを 1 枚のカードにまとめ、**クリックすると中の曲一覧がその場で展開**します（曲数バッジ・hover の再生ボタン・アルバムごとクレート追加つき）。展開した各曲は BPM・時間・クレート追加を備え、ダブルクリックでアルバムを再生します。
- 矢印キーを選択操作に使うため、これまで ↑ / ↓ に割り当てていた音量調整を外しました（音量はプレイヤーバーで操作できます）。

### English

#### Added
- **Keyboard multi-select**: in the track list, **↑ / ↓** move the cursor, **Shift + ↑ / ↓** extend the selection, and **Ctrl/Cmd + A** selects all, with scroll-into-view.

#### Changed
- **More natural Shift-click**: the previously clicked row is kept as a fixed anchor, so Shift-clicking re-extends the range from the same start; **Shift + Ctrl/Cmd-click** adds the range onto the existing selection.
- **Album-merged covers view**: tracks from the same album collapse into one card that **expands an inline track list on click** (with a track-count badge, a hover play button, and add-whole-album-to-crate). Each expanded track shows BPM / time / crate-add and plays the album on double-click.
- Removed the old ↑ / ↓ volume shortcut so the arrow keys drive selection (volume lives on the player bar).

## [v0.2.0] - 2026-06-06

### 日本語

#### 変更
- **アプリ名を「Crateforge」にリブランドしました**（旧 "iTunes Playlist Viewer"）。crate（掘る・集める）+ forge（鍛える・組み上げる）で、解析して選曲しセットを鍛える、という中身を表す名前です。機能は同じで、表示名・内部識別子・インストーラ名が新しくなりました。
  - ⚠️ バンドル識別子（`com.tainakanchu.crateforge`）が変わったため、**旧版とは別アプリとしてインストールされます**。旧 "iTunes Playlist Viewer" のインストールからは自動更新で引き継がれないので、お手数ですが新しい Crateforge を入れ直してください（更新チェック自体は引き続き有効です）。

### English

#### Changed
- **Renamed the app to "Crateforge"** (formerly "iTunes Playlist Viewer") — crate (dig/collect) + forge (craft/build) — the same app under a name that reflects its analyze-select-and-forge-a-set core. Display name, internal identifiers, and installer names are new.
  - ⚠️ The bundle identifier (`com.tainakanchu.crateforge`) changed, so it **installs as a separate app** and won't auto-update from older "iTunes Playlist Viewer" installs — please install the new Crateforge once (update checks keep working from there).

## [v0.1.3] - 2026-06-06

### 日本語

#### 追加
- **メタデータ一括編集**: 複数曲を選んで Get Info / Cmd+I すると 1 つのエディタで編集でき、**触ったフィールドだけ**を全曲へ適用します（共通の値はプリフィル、異なる値は「複数の値」表示）。
- **アートワーク編集**: トラックエディタにジャケット欄を追加。**クリップボードから貼り付け**、または**画像ファイルから選択**で、選択中の全曲にカバーアートを設定できます。
- **スマートプレイリスト**: 条件（フィールド / 演算子 / 値・すべて/いずれか一致・並び替え・上限）で**自動的に中身が決まる**プレイリストを作れます。開くたびにライブラリ全体を評価するので常に最新。**BPM / Key(Camelot) / Energy / 再生回数 / レーティング**などに加え解析結果も条件に使えます。サイドバーの🎛ボタンで作成、右クリック →「[e]」でルール編集。
- **アップデート「閉じるときに更新」**: いまは使い続けて、**アプリを閉じるタイミングで自動的にインストーラを実行**する選択肢を追加しました（起動時に作業を中断されません）。
- **iTunes 互換 XML の自動エクスポート**: ツールバーの🕐トグルで ON にすると、変更があったときだけ・約30分間隔＋終了時に Library XML を自動で書き出します。

### English

#### Added
- **Bulk metadata edit**: selecting multiple tracks and choosing Get Info / Cmd+I opens one editor that applies only the fields you actually touch to every track (shared values are pre-filled; differing ones show "複数の値").
- **Artwork editing**: the track editor gains a cover-art panel — set the cover on all selected tracks by **pasting from the clipboard** or **choosing an image file**.
- **Smart playlists**: create playlists whose contents are defined by rules (field / operator / value, match all-or-any, sort, limit) and evaluated live over the whole library, so they stay current. Rules can use **BPM / key (Camelot) / energy / play count / rating** and more. Create from the sidebar's 🎛 button; right-click → "[e]" to edit rules.
- **"Update on close"**: a new update option that keeps the app running and **launches the installer when you close the window**, so updates don't interrupt you at launch.
- **Auto-export of the iTunes-compatible XML**: a toolbar toggle (clock icon) re-exports the Library XML only when the library changed — at most every ~30 minutes and once when the app closes.

## [v0.1.2] - 2026-06-06

### 日本語

#### 追加
- **曲のフォーマット変換**: 曲を右クリック →「Convert to…」で、**MP3 / FLAC / ALAC / AAC / Opus / WAV** に変換できるようになりました（ffmpeg 使用）。形式・ビットレート・出力先を選べ、変換後にライブラリへ追加できます。ライブラリのタグと埋め込みカバーを引き継ぎ、進捗を表示します。
- Windows ビルドに **ffmpeg を同梱**したので、別途インストールしなくても変換が使えます（インストーラ版）。

### English

#### Added
- **Audio format conversion**: right-click a track → "Convert to…" to re-encode to **MP3 / FLAC / ALAC / AAC / Opus / WAV** (via ffmpeg). Pick the format, bitrate, and output folder, and optionally add the results to the library; it carries over the library's tags and embedded cover art and shows progress.
- Windows builds now **bundle ffmpeg**, so conversion works without installing it separately (installer builds).

## [v0.1.1] - 2026-06-06

### 日本語

#### 追加
- **プレイリストフォルダの折りたたみ**: サイドバーでフォルダをクリックすると開閉できるようになりました（シェブロンが回転）。たたんだ状態は保存され、再起動しても保たれます。
- **アップデートの直接ダウンロード**: 更新通知の「Download」が、ブラウザでリリースページを開く代わりに、この OS 向けのインストーラ（Windows）を**直接ダウンロードして起動**するようになりました。インストーラが見つからない / 失敗した場合は従来どおりリリースページを開きます。

#### 修正
- **プレイリストを選んでも曲が絞り込まれない不具合 (v0.1.0 の回帰)** を修正しました。プレイリスト取得クエリの列が `last_played` 追加後の行マッピングと食い違っていて失敗し、一覧が更新されていませんでした。再発防止のテストも追加しています。

---

### English

#### Added
- **Collapsible playlist folders**: clicking a folder in the sidebar now collapses / expands it (with a rotating chevron). The collapsed state is saved and persists across restarts.
- **Direct download for updates**: the update banner's "Download" now downloads this OS's installer (Windows) and launches it directly, instead of opening the release page in a browser. It falls back to the release page when no installer asset is found or the download fails.

#### Fixed
- Fixed selecting a playlist not filtering the track list (a v0.1.0 regression). The playlist query's columns no longer matched the row mapping after `last_played` was added, so it failed and the list never updated. Added a regression test.

## [v0.1.0] - 2026-06-05

### 日本語

#### 追加
- **DJ 向け音声解析**: 純 Rust の DSP で BPM / キー (Camelot) / エネルギー / ラウドネス と類似度ベクトルを解析します。再生した曲・★4 以上・右クリック「Analyze」をきっかけに「よく使う曲」だけをバックグラウンドで解析（進捗をツールバーに表示）。**Key / Energy** 列を追加しました。
- **類似度サジェスト**: 右レールに **Similar** タブを追加。曲を右クリック →「Find similar」で、Camelot キー互換 + テンポ近接の「次の一手」を提示します（Harmonic トグルで絞り込み）。結果はクレートやキューに追加できます。
- **スムーズな並び替え (smooth set)**: クレートを貪欲最近傍で滑らかな流れに自動ソートする「smooth」ボタンを追加。
- **検索フィルタ構文**: `bpm:120-128` / `key:8A` / `energy:60-100` で解析値による絞り込みができます（テキスト検索と AND 結合）。
- **実波形 + ReplayGain**: プレイヤーの波形が解析ピークによる実波形になりました。ReplayGain（曲ごとの音量正規化、−18 LUFS 基準）のトグルを追加。
- **再生実績の記録**: アプリ内での再生で再生回数 / 最終再生日時 / スキップ数を記録するようになりました。**Last Played** 列とソートを追加。
- **BPM タグの読み取り**: 取り込み時にファイルの BPM タグ (TBPM / tmpo / Vorbis BPM) を読むようになりました。
- **ファイル自動整理**: 整理先フォルダを設定すると、取り込み・編集時に `<整理先>/<アルバムアーティスト>/<アルバム>/` へ iTunes 準拠のリネームで配置します。
- **コンテキストメニュー刷新**: レーティング、ネストしたプレイリストのサブメニュー、最近入れたプレイリスト、アプリケーションキー / Shift+F10 でのキーボード操作に対応。

#### 修正
- 再生まわりを全体的に修正しました: キューの整合、シャッフル / リピート、シーク、前へ / 次へ、Up Next からの頭出しなど。

---

### English

#### Added
- **Audio analysis for DJing**: a pure-Rust DSP pipeline estimates BPM / key (Camelot) / energy / loudness and a similarity vector. Only "hot" tracks are analyzed in the background — triggered by playing, a ≥4★ rating, or a right-click "Analyze" (progress shown in the toolbar). Adds **Key / Energy** columns.
- **Similarity suggestions**: a new **Similar** rail tab. Right-click a track → "Find similar" to surface Camelot-compatible, tempo-close "next picks" (with a Harmonic toggle); results can be added to the crate or queue.
- **Smooth set ordering**: a "smooth" button reorders the crate into a greedy nearest-neighbor flow.
- **Search filter syntax**: `bpm:120-128` / `key:8A` / `energy:60-100` filter by analyzed values (ANDed with the text search).
- **Real waveform + ReplayGain**: the player waveform now renders the analyzed peaks, and a ReplayGain toggle (per-track volume normalization, −18 LUFS reference) was added.
- **Play history**: in-app playback now records play count / last played / skip count. Adds a **Last Played** column and sort.
- **BPM tag reading**: imported files now have their BPM tag (TBPM / tmpo / Vorbis BPM) read.
- **Automatic file organization**: with an organize root set, imports/edits relocate files into `<root>/<Album Artist>/<Album>/` with iTunes-style renaming.
- **Reworked context menu**: rating, a nested playlist submenu, recently-used playlists, and keyboard operation via the Application key / Shift+F10.

#### Fixed
- A broad fix to playback: queue consistency, shuffle / repeat, seeking, previous / next, and jumping into a position from Up Next.

## [v0.0.4] - 2026-05-30

### 日本語

#### 追加
- ジャンル / 語句フィルタチップ: ジャンルタグをクリックすると、検索を置き換える代わりに削除可能なフィルタチップとして追加されるようになりました。複数のチップは AND 条件として積み重なり、それぞれ個別に削除できます（「すべてクリア」もあり）。フリーテキストの検索ボックスとも組み合わせられます。

#### 変更
- 検索がクエリをスペースで分割し、各トークンを AND 結合するようになりました。各トークンは 名前 / アーティスト / アルバム / アルバムアーティスト / ジャンル / コメント のいずれかに一致する必要があります。（以前は空白を含む文字列全体が 1 つの部分文字列として一致する必要がありました。）
- シャッフルが実際のシャッフル再生順（Fisher–Yates）を事前計算するようになりました。これにより **Up Next** リストが、元の順序ではなく実際にこれから再生されるシャッフル後のトラックを反映します。シャッフルをオンにすると未再生の末尾だけを再シャッフルし、リピート（全曲）で 1 周すると次の周回用に再シャッフルします。
- GitHub Release の本文に、そのタグの CHANGELOG セクションを含め、その下に自動生成の "What's Changed" を付与するようになりました。

---

### English

#### Added
- Genre / term filter chips: clicking a genre tag now adds it as a removable filter chip instead of replacing the search. Multiple chips stack as AND conditions, each removable individually (with a "clear all"), and they combine with the free-text search box.

#### Changed
- Search now splits the query on spaces and ANDs the tokens — each token must match somewhere in name / artist / album / album artist / genre / comments. (Previously the whole string, spaces included, had to appear as one substring.)
- Shuffle now precomputes a real shuffled play order (Fisher–Yates), so the **Up Next** list reflects the actual upcoming shuffled tracks instead of the original order. Turning shuffle on reshuffles only the not-yet-played tail; a full pass under repeat-all reshuffles for the next lap.
- The GitHub Release body now includes this CHANGELOG section for the tag, followed by the auto-generated "What's Changed".

## [v0.0.3] - 2026-05-30

### 日本語

#### 追加
- アルバムアートワーク: 各トラックのファイルから埋め込みカバーアート（FLAC picture / MP3 APIC / MP4 covr など）を読み込み、List のサムネイル、Covers カード、プレイヤーバー、Now Playing レール、クレート / Up Next、Album / Artist カードに表示するようになりました。埋め込みアートがない（またはファイルが見つからない）トラックは、従来の生成グラデーション + グリフのプレースホルダのままです。`artwork://` URI スキームで遅延配信し、表示中のアイテムだけを読み込みます（webview が URL 単位でキャッシュ）。

#### 修正
- × ボタンで必ずウィンドウが閉じるようになりました。新しいリリースが公開されていると、終了時の「アップデートあり」ダイアログが最初のクローズを（`preventDefault` で）横取りしていた挙動を取り除きました。アップデートはウィンドウ上部の非ブロッキングなバナーで引き続き通知されます。

---

### English

#### Added
- Album artwork: embedded cover art (FLAC picture / MP3 APIC / MP4 covr, etc.) is now read from each track's file and shown in the List thumbnails, Covers cards, player bar, Now Playing rail, crate / up-next, and Album / Artist cards. Tracks without embedded art (or with a missing file) keep the generated gradient + glyph placeholder. Served lazily via an `artwork://` URI scheme so only visible items are read, and the webview caches by URL.

#### Fixed
- The window now always closes on the × button. The close-time "update available" dialog was intercepting the first close (via `preventDefault`) whenever a newer release was published; that interception is removed. Updates are still surfaced by the non-blocking banner at the top of the window.

## [v0.0.2] - 2026-05-29

### 日本語

#### 変更
- UI を **Cratebox**（アート志向 / DJ テーマ）に刷新しました:
  - ティール基調のパレットと Lucide 風のラインアイコンセット（絵文字アイコンを全廃）。
  - 3 ペイン構成: サイドバー / 中央 / **右レール** + フル幅のプレイヤーバー。
  - **List** / **Covers** ビューモード（ツールバーのセグメント）。
  - List 行: アルバムアートのプレースホルダ（生成グラデーション + 先頭グリフ）、BPM の色分け、ジャンルのピルチップ、インライン ★ 評価。
  - **カラムピッカー** ポップオーバー: 列のドラッグ並べ替え、表示項目のトグル、行高スライダー（32〜64px）、アートワークサイズ（なし / 豆 / 小）— いずれも永続化。
  - サイドの **ステージングクレート** レール（Now Playing / Up Next / Crate）で選曲を組み立て、プレイリストとして保存; プレイヤーには波形シークバー。

#### 修正
- トラックのソートをバックエンド（SQLite の `ORDER BY`）で行うようにし、結果セット全体が正しく並ぶようになりました。以前はメモリに読み込み済みの行だけがソートされていたため、末尾までスクロールして戻るまではソートでトラックが欠落して見えていました。
- プレイリストからのトラック削除を、表示インデックスではなくトラック ID で対象指定するようにし、リストがソートされているときに誤った行を削除する不具合を修正しました。

---

### English

#### Changed
- Redesigned the UI to the **Cratebox** art-forward / DJ theme:
  - Teal palette and a Lucide-style line-icon set (all emoji icons removed).
  - Three-pane shell: sidebar / center / **right rail** + full-width player bar.
  - **List** and **Covers** view modes (toolbar segment).
  - List rows: album-art placeholders (generated gradient + leading glyph), BPM color coding, genre pill chips, inline ★ rating.
  - **Column picker** popover: drag-reorder columns, toggle fields, row-height slider (32–64 px), artwork size (none / 豆 / 小) — persisted.
  - **Staging Crate** side rail (Now Playing / Up Next / Crate) for building a selection and saving it as a playlist; waveform seek bar in the player.

#### Fixed
- Track sorting is now applied in the backend (SQLite `ORDER BY`) so the entire result set orders correctly. Previously only the rows already paged into memory were sorted, so sorting appeared to drop tracks until you scrolled to the bottom and back.
- Removing a track from a playlist now targets it by track id instead of display index, fixing wrong removals when the list was sorted.

## [v0.0.1] - 2026-05-29

### 日本語

最初の公開リリース。ライブラリのインポート / 編集 / 再生 / エクスポート、MusicBrainz 照会付きの CD リッピング、YAML ルールからの宣言的プレイリスト生成までを単体で完結させる、iTunes ライクな音楽マネージャです。実装した主な機能をおおまかに列挙します:

- **ライブラリ入出力** — iTunes `Library.xml`（Apple plist 形式）のインポート / エクスポート、FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF の追加、1 万曲以上で検証した SQLite (WAL) キャッシュ。
- **再生** — ローカル再生（rodio + symphonia）、キューの自動送り、シャッフル、リピート（オフ / 全曲 / 1 曲）、ボリューム、Windows SMTC のメディアキー連携。
- **ライブラリビュー** — All Tracks（仮想スクロール）、Albums、Artists、Recently Played、フォルダ階層のプレイリストツリー。
- **トラック編集** — ソート可能なカラム、カラムピッカー、インライン ★ 評価、クリック可能なジャンルチップ、全メタデータを編集できる Get Info ダイアログ。
- **CD リッピング** — TOC + MusicBrainz ディスク照会、Cover Art Archive プレビュー、FLAC / ALAC / MP3 320 / WAV への進捗表示付きリッピング。
- **宣言的プレイリスト** — YAML ルール（条件・ジェネレータ・テンプレート）をライブラリにコンパイルし、アプリ内エディタ（検証 / プレビュー / 適用）で操作。
- **アップデート** — 新しい GitHub Release の公開時に、起動バナーと終了時ダイアログで通知。
- **キーボードショートカット** — Space / Enter / J / K / S / R / 音量 / 検索 / Get Info など。
- **ビルド & 開発** — Nix flake によるツールチェーン、タグ push で GitHub Actions が `.exe` + MSI + NSIS インストーラをビルド。

---

### English

Initial public release. A self-contained, iTunes-style music manager that imports / edits / plays / exports your library, rips CDs with MusicBrainz lookup, and builds playlists declaratively from a YAML rules file. A rough list of the main features shipped:

- **Library I/O** — import / export iTunes `Library.xml` (Apple plist format); add FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF files; SQLite (WAL) cache tested on 10,000+ tracks.
- **Playback** — local playback (rodio + symphonia) with queue auto-advance, shuffle, repeat (off / all / one), and volume; Windows SMTC media-key integration.
- **Library views** — All Tracks (virtualized), Albums, Artists, Recently Played, and a folder-based playlist tree.
- **Track editing** — sortable columns, column picker, inline ★ rating, clickable genre chips, and a Get Info dialog for every metadata field.
- **CD ripping** — TOC + MusicBrainz disc lookup, Cover Art Archive preview, rip to FLAC / ALAC / MP3 320 / WAV with live progress.
- **Declarative playlists** — YAML rules (conditions, generators, templates) compiled into the library, with an in-app editor (validate / preview / apply).
- **Updates** — startup banner + close-time dialog when a newer GitHub Release is published.
- **Keyboard shortcuts** — Space / Enter / J / K / S / R / volume / search / Get Info, etc.
- **Build & dev** — Nix flake toolchain; GitHub Actions builds the `.exe` + MSI + NSIS installers on tag push.

[Unreleased]: https://github.com/tainakanchu/itunes-playlist-viewer/compare/v0.0.4...HEAD
[v0.0.4]: https://github.com/tainakanchu/itunes-playlist-viewer/compare/v0.0.3...v0.0.4
[v0.0.3]: https://github.com/tainakanchu/itunes-playlist-viewer/compare/v0.0.2...v0.0.3
[v0.0.2]: https://github.com/tainakanchu/itunes-playlist-viewer/compare/v0.0.1...v0.0.2
[v0.0.1]: https://github.com/tainakanchu/itunes-playlist-viewer/releases/tag/v0.0.1
