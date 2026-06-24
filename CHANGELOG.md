# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

各バージョンは **日本語** と **English** の 2 ブロックを併記します。
Each release is documented in both Japanese and English.

## [Unreleased]

### 日本語

#### モバイル（OTA 配信）
- **似た曲でラジオ再生**：曲の長押し、またはプレイヤーの類似曲セクションから、その曲＋似た曲をまとめて即プレイリスト再生。
- **曲の長押しメニューを拡充**：似た曲でラジオ / 次に再生 / アーティストを見る / アルバムを保存（全画面で統一）。
- **「アルバムなし」の曲をまとめて表示**：アーティスト画面で、アルバム情報のない曲を「アルバムなし」グループ（末尾）として表示・再生できるように（以前は除外していた）。

### English

#### Mobile (OTA)
- **Similar-track radio**: instantly play a track plus its similar tracks as a queue — from the track long-press menu or the player's "similar tracks" section.
- **Richer track long-press menu**: radio / play next / view artist / save album (consistent across screens).
- **"No album" grouping**: tracks without album info are grouped as "アルバムなし" (at the end) on the artist screen, browsable and playable (previously omitted).

## [v0.8.10] - 2026-06-24

### 日本語

#### デスクトップ
- **レイアウト崩れの修正**：設定や曲情報などのモーダルが内容に引っ張られて横に広がり、はみ出し・横スクロールしていた問題を修正。長いパスやジャンルタグでの崩れも防止。
- **アートワークの切替を Columns に統合**：重複していたツールバーの「Artwork」ボタンを廃止（表示は「Columns」内で切替）。
- **並び順の改善**：アルバムアーティスト / アルバム / アーティストで並べたとき、同じアルバム内をトラック番号順（ディスク→トラック→曲名）で表示。
- **ジャンルの一括編集を修正**：複数曲をまとめて編集したとき、追加のつもりが全曲上書きになっていた問題を修正（複数選択時は追加/削除のみ反映）。ジャンルタグをドラッグで並べ替え可能に。

#### モバイル
- **レーティングの設定**：プレイヤー画面で ★ をタップしてレートを付けられるように。
- **クラッシュ修正**：「アルバムなし」の曲のまとまりを開くとクラッシュする問題を修正。
- **ミニプレイヤーを常時表示**：アーティスト/アルバムなどの画面でも下部に再生中バーが出るように。
- **下部の余白調整**：設定などで再生中に項目がミニプレイヤーに隠れないように。

### English

#### Desktop
- **Layout fixes**: modals (settings, track info, etc.) no longer stretch to their content and overflow with a horizontal scrollbar; also hardened against long paths / genre tags.
- **Artwork toggle merged into Columns**: removed the duplicate toolbar "Artwork" button (toggle lives in the Columns popover).
- **Better sorting**: when sorting by album artist / album / artist, tracks within an album are ordered by disc → track number → name.
- **Fixed bulk genre edit**: editing multiple tracks at once overwrote every track's genre instead of adding; multi-select now applies adds/removes only. Genre tags can be reordered by drag.

#### Mobile
- **Set ratings**: tap the ★ on the player screen to rate a track.
- **Crash fix**: opening the "no album" group of tracks no longer crashes.
- **Persistent mini-player**: the now-playing bar now shows on artist/album and other screens.
- **Bottom padding**: items are no longer hidden behind the mini-player during playback (settings, etc.).

## [v0.8.9] - 2026-06-23

### 日本語

#### デスクトップ
- **曲一覧の列ずれを修正**：列ヘッダーにだけ件数表示が入っていたため、ヘッダーと本体行で列（ALBUM 以降）の位置がずれていた問題を修正。選択件数はツールバーに移設（`Search · N · M selected`）。

### English

#### Desktop
- **Fixed misaligned track-list columns**: the column header included a count label that the body rows didn't, shifting the header and body columns (ALBUM onward) out of alignment. The selection count moved to the toolbar (`Search · N · M selected`).

## [v0.8.8] - 2026-06-23

### 日本語

#### デスクトップ
- **一部の `.m4a` が再生できずクラッシュする不具合を修正**：ドラッグ&ドロップで追加した曲などで「`decoder crashed`」となり再生できなかった問題を解消（`rodio` を 0.22 に更新し、ギャップレス初期化中の seek 失敗による内部 panic を回避）。

### English

#### Desktop
- **Fixed a crash where some `.m4a` files failed to play**: resolved "`decoder crashed`" on certain tracks (e.g. drag-and-dropped files) by upgrading `rodio` to 0.22 and avoiding the internal panic caused by a failed seek during gapless initialization.

## [v0.8.7] - 2026-06-23

### 日本語

#### デスクトップ
- **圧縮ダウンロード/配信の逐次ストリーミング化**：AAC 変換配信を全件バッファから逐次ストリーミングへ変更。長尺曲でモバイルのオフライン保存が失敗（read timeout）していた問題を解消。
- **空コンソール窓の抑止**：`ffmpeg` / `flac` / `lame` / `cdparanoia` の起動時に Windows で空のターミナルが出ていたのを抑止。
- **`/api/artists` 追加**：アーティスト一覧をサーバ側で集計して返すエンドポイントと、曲一覧の artist / albumArtist 絞り込みを追加。
- **API サーバのポート起動を堅牢化**：既定ポートが Windows の予約範囲や使用中で bind できない場合に代替ポートへ自動フォールバック。状態・QR は実際に待ち受けているポートを表示。

#### モバイル
- **再生エラーの自動回避**：端末が再生できない形式での "Source error" 時に AAC へ自動フォールバックして再生。
- **圧縮ダウンロードの保存形式を修正**：保存後に再生できなかった不具合を修正（`.aac` で保存）。
- **アーティスト表示の高速化**：サーバ集計＋キャッシュ即時表示（裏で再取得）で待ち時間を短縮。

### English

#### Desktop
- **Streamed compressed download/serving**: AAC transcoding is now streamed instead of fully buffered, fixing offline-save failures (read timeout) on longer tracks from mobile.
- **No more empty console window**: suppressed the empty terminal window on Windows when launching `ffmpeg` / `flac` / `lame` / `cdparanoia`.
- **`/api/artists` endpoint**: server-side aggregated artist list, plus artist / albumArtist filters for the tracks list.
- **Robust API server port binding**: automatically falls back to an alternate port when the default port is reserved by Windows or already in use; status and QR now reflect the actually bound port.

#### Mobile
- **Automatic playback fallback**: on a "Source error" for formats the device can't decode, playback now falls back to AAC automatically.
- **Fixed compressed download format**: fixes downloads that could not be played back after saving (now saved as `.aac`).
- **Faster artist browsing**: server-side aggregation plus instant cache display (revalidating in the background) shortens wait time.

## [v0.8.6] - 2026-06-23

### 日本語

#### デスクトップ
- **ドラッグ&ドロップ取り込み**：エクスプローラーから曲ファイルをウィンドウにドロップしてライブラリへ追加（#70）。
- **アルバム / カバービューのアコーディオン化**：同時に開くのは 1 つだけにして見通しを改善（#68）。
- **検索の高速化**：fold 済みの `search_text` 列を使って検索を高速化。

#### モバイル
- **アーティスト起点の導線**：アーティストからアルバムを辿る導線と、アルバムの並び順を追加（#69）。
- **再生失敗の可視化**：再生失敗を通知して自動スキップし、stream 失敗をログに記録（#67）。

#### ドキュメント
- **使い方ドキュメントの是正・多言語化**：実装と突き合わせて事実誤りを修正し、英語・繁體中文を全ページ翻訳。実装との乖離を機械検出するドリフトチェック（`check-docs`）を CI に追加（#72）。

### English

#### Desktop
- **Drag & drop import**: drop audio files from the file explorer onto the window to add them to the library (#70).
- **Accordion album / cover view**: only one album expands at a time for a cleaner view (#68).
- **Faster search**: search now uses a pre-folded `search_text` column.

#### Mobile
- **Artist-centric navigation**: navigate from an artist to their albums, with album ordering (#69).
- **Playback failure visibility**: failed playback is surfaced via a notification and auto-skip, and stream failures are logged (#67).

#### Docs
- **Docs fact-check & localization**: corrected factual errors against the implementation and fully translated the English / Traditional Chinese pages; added a drift check (`check-docs`) to CI that mechanically detects docs/implementation mismatches (#72).

## [v0.8.5] - 2026-06-22

### 日本語

#### ドキュメント
- **使い方ドキュメントサイトを新設**：Astro + Starlight 製のドキュメント（日本語＋英語＋繁體中文）を
  GitHub Pages の `/docs/` に追加（インストール／ライブラリ取り込み／再生・キュー・Crate／
  スマートプレイリスト／表示カスタマイズ・ショートカット／DJ 解析／API サーバー・ペアリング／
  モバイル／変換）。LP のナビから「ドキュメント」で辿れます。※英語・繁體中文は順次翻訳。
- UX「気が利く化」バックログ（`docs/ux-polish-backlog.md`）を、出荷バージョン対応付きの実施記録へ整理。

### English

#### Docs
- **New usage documentation site**: an Astro + Starlight docs site (Japanese + English + Traditional
  Chinese) is now published under `/docs/` on GitHub Pages (install / library import / playback, queue
  & crate / smart playlists / customization & shortcuts / DJ analysis / API server & pairing / mobile /
  convert), reachable from the landing page's "Docs" nav. English/zh-TW translations to follow.
- Reorganized the UX-polish backlog (`docs/ux-polish-backlog.md`) into a shipped-status record.

## [v0.8.4] - 2026-06-22

### 日本語

#### 修正
- **アルバムを開いた時の曲順を正す**：ディスク番号→トラック番号順で並べるように（従来は名前順になっていた）。デスクトップのアルバム表示とモバイルのオンライン取得の両方を修正。(#65)
- **左上のアイコンを正規アプリアイコンに**：サイドバー上部のロゴが汎用アイコンだったのを、アプリの正規アイコンに差し替え。(#59)

#### 追加
- **iPad 等のリモコン Web UI を強化**：内蔵 API サーバーが配信するリモコン（`http://PC-IP:PORT/`）に音量スライダー・シャッフル・リピートのトグルを追加。`/api/remote/state` が音量/シャッフル/リピートも返すように。(#13)
- **曲メタデータ書き込み API の拡張**：`PATCH /api/tracks/{id}` の composer/comments を実ファイルのタグにも反映（従来は DB だけ）。`disabled`/`playCount`/`skipCount`（DB のみ）を追加。複数曲一括の `PATCH /api/tracks`（`{trackIds, edit}`）を新設。(#41)

#### 改善
- **再生失敗の可視化**：曲の再生に失敗したらトーストで通知し、失敗内容（ファイル不在・デコード失敗・デコーダのクラッシュ）をログ（crateforge.log）に記録するように。どの曲がなぜ再生できないか把握しやすく。(#67) ※非対応形式（WMA/.m4p 等）の ffmpeg フォールバックは別途対応予定。

#### モバイル（OTA 配信）
- アルバムを開いた時の曲順をディスク番号→トラック番号順に修正（オンライン時）。(#65)

### English

#### Fixed
- **Correct album track order**: tracks now sort by disc number → track number (previously alphabetical). Fixed on both desktop album view and mobile online fetch. (#65)
- **Real app icon in the top-left**: the sidebar logo now uses the app's real icon instead of a generic one. (#59)

#### Added
- **Richer remote web UI (for iPad etc.)**: the built-in server's remote (`http://PC-IP:PORT/`) gains a volume slider and shuffle/repeat toggles; `/api/remote/state` now also reports volume/shuffle/repeat. (#13)
- **Expanded track-metadata write API**: `PATCH /api/tracks/{id}` now writes composer/comments to the actual file tags (was DB-only); added `disabled`/`playCount`/`skipCount` (DB-only); added bulk `PATCH /api/tracks` (`{trackIds, edit}`). (#41)

#### Improved
- **Playback-failure visibility**: a failed track now shows a toast and logs the reason (missing file / decode failure / decoder crash) to crateforge.log, making it clear which track failed and why. (#67) An ffmpeg fallback for unsupported formats (WMA/.m4p) is planned separately.

#### Mobile (OTA)
- Fixed album track order to disc → track number when online. (#65)

## [v0.8.3] - 2026-06-22

### 日本語

#### 改善
- **内蔵 API サーバーの再起動を堅牢化**：サーバーの停止が確実に完了してから再起動するようにし（停止処理を同期化＋最大3秒で強制終了）、bind 時に `SO_REUSEADDR`/`SO_REUSEPORT` を設定。「前のサーバーが落ち切らずに起動できない（address in use）」を解消。
- **アートワークのサーバー側リサイズ＋webp/jpeg 配信**：`GET /api/tracks/{id}/artwork` が `?size=&format=webp|jpeg` に対応（純 Rust の webp エンコード、C ライブラリ不要）。モバイルのオフライン用に軽量なサムネを返せるように（巨大サイズ指定は安全上限でクランプ）。指定が無ければ従来どおり原本を返す（後方互換）。

#### モバイル（OTA 配信）
- **オフラインでもアートワークが出る**：曲のダウンロード時にアルバムアートを webp でローカル保存（アルバム単位で重複排除）し、未接続でもジャケットを表示。
- **オフラインのコレクションが分かりやすく**：アルバム行にアートワークとアルバムアーティスト（複数混在は "Various Artists"）を表示。アーティスト単位のセクションを新設。
- **アーティストページをアルバム表示に**：アーティストを開くとアルバムが並び、アルバムアーティスト順でソート。オフラインでもダウンロード済みから表示。
- **再生中画面からの導線**：再生中のアーティスト（とアルバム）をタップでそのページへ遷移。アーティストの束ね方は設定（アルバムアーティスト/アーティスト）に追従。

### English

#### Improved
- **More robust embedded API server restarts**: the server now fully stops before restarting (synchronous stop with a 3s force-abort fallback) and binds with `SO_REUSEADDR`/`SO_REUSEPORT`, fixing "address in use" when the previous server hadn't fully shut down.
- **Server-side artwork resize + webp/jpeg**: `GET /api/tracks/{id}/artwork` now accepts `?size=&format=webp|jpeg` (pure-Rust webp encoding, no C library), so mobile can fetch lightweight offline thumbnails (oversized requests are clamped). Without params it returns the original (backward compatible).

#### Mobile (OTA)
- **Artwork now shows offline**: album art is saved locally as webp on download (deduplicated per album), so covers appear even when disconnected.
- **Clearer offline collection**: album rows show artwork and album artist ("Various Artists" when mixed); added an Artists section.
- **Artist page shows albums**: opening an artist lists their albums, sorted by album artist; works offline from downloaded tracks.
- **Now-playing navigation**: tap the artist (and album) on the now-playing screen to jump to that page; artist grouping follows the setting (album artist / artist).

## [v0.8.2] - 2026-06-22

### 日本語

#### 追加
- **グローバルトースト通知**：成功/失敗/情報の一時通知基盤を導入し、各種操作のフィードバックを一本化（右下にスタック表示・自動消滅）。
- **キーボードショートカット一覧**：`?` キーでショートカット一覧オーバーレイを表示（発見性の向上）。
- **再生操作のショートカット拡充**：`Shift+←/→` で 5 秒シーク、`Enter` でフォーカス/選択行を再生。
- **曲名(Track)列のリサイズ**：ヘッダ右端のドラッグで曲名列の幅を変更可能に（永続化）。
- **プレーヤーの操作性**：シークバーをドラッグでシーク可能に、時間表示クリックで「経過⇄残り」切替、音量バーにつまみと % 表示。
- **右ペインの可視化**：Up Next に件数・合計時間・シャッフルバッジを追加、Now Playing に Key/Energy を表示、Similar の「Add all」を全追加済みなら無効化（"All added"）。
- **スマートプレイリスト/タグ入力**：日付条件をネイティブの日付入力に。ジャンルタグ入力は Tab でも確定でき、候補リストをスクロール可能に。

#### 改善
- **ネイティブ `alert()` / `window.prompt()` を全廃**：トースト・インライン入力・カスタムメニューに置き換え（サイドバー右クリック、設定のエラー、クレートの「プレイリストとして保存」、変換失敗など）。暗所で目立つ白い OS ダイアログが出なくなりました。
- **サイドバーのコンテキストメニュー化**：プレイリスト/フォルダの操作を、キーボード操作対応（↑↓/Enter/Esc）のカスタムメニューに刷新（名前変更・複製・ルール編集・削除）。新規作成と名前変更はインライン入力に。
- **破壊的操作の確認**：クレート全消去・ペアリングトークン再生成・トラック編集の未保存破棄に確認を追加。
- **モーダルのキーボード対応**：トラック編集／スマートプレイリスト／変換の各ダイアログを Esc で閉じられるように。初期フォーカスと Enter 確定にも対応。
- **トラック編集**：保存中の表示と「保存しました」トーストを追加。未保存があれば破棄前に確認。
- **一覧の作り込み**：省略表示セル（曲名/アルバム/アルバムアーティスト）にホバーで全文表示（title）、選択件数の表示、読み込み中表示の改善、アプリケーションキーのメニュー位置をフォーカス行基準に。
- **検索ツールバー**：検索ボックスを制御入力化＋クリア(×)ボタン、ソート方向（↑/↓）の常時表示、ボタンの tooltip にショートカットを追記。
- **アップデート通知**：日本語化＋リリースノートの折りたたみ表示を追加。
- **設定**：ReplayGain の変更に失敗したときに通知し、設定を元に戻すように。

### English

#### Added
- **Global toast notifications**: a unified success/error/info transient-notification system (stacked bottom-right, auto-dismiss).
- **Keyboard shortcut overlay**: press `?` to show the list of shortcuts (improved discoverability).
- **More playback shortcuts**: `Shift+←/→` to seek ±5s, `Enter` to play the focused/selected row.
- **Resizable Track (name) column**: drag the right edge of the header to resize the name column (persisted).
- **Player improvements**: drag the seek bar to scrub, click the time to toggle elapsed/remaining, volume bar now has a thumb and a % tooltip.
- **More visible state in the right rail**: Up Next now shows count, total time, and a shuffle badge; Now Playing shows Key/Energy; Similar's "Add all" is disabled ("All added") when everything is already in the crate.
- **Smart playlists / tag input**: native date inputs for date conditions; the genre tag input now also commits on Tab and its suggestion list scrolls.

#### Improved
- **Removed all native `alert()` / `window.prompt()`**: replaced with toasts, inline inputs, and custom menus (sidebar right-click, Settings errors, crate "Save as Playlist", convert failures, etc.). No more jarring white OS dialogs.
- **Sidebar context menu**: playlist/folder actions are now a keyboard-friendly custom menu (↑↓/Enter/Esc) — Rename, Duplicate, Edit rules, Delete. Create and rename use inline inputs.
- **Confirmations for destructive actions**: clearing the crate, regenerating the pairing token, and discarding unsaved track edits now ask first.
- **Keyboard support in modals**: Track editor, Smart playlist editor, and Convert dialogs close on Esc, with initial focus and Enter-to-confirm.
- **Track editor**: saving shows progress and a "Saved" toast; unsaved changes are confirmed before discarding.
- **List polish**: truncated cells (name/album/album artist) show the full text on hover (title); selection count is shown; loading state improved; the Application-key context menu now anchors to the focused row.
- **Search toolbar**: the search box is now a controlled input with a clear (×) button, sort direction (↑/↓) is always shown, and button tooltips list their shortcuts.
- **Update banner**: localized to Japanese and added a collapsible release-notes view.
- **Settings**: a failed ReplayGain change now notifies and rolls back.

## [v0.8.1] - 2026-06-22

### 日本語

#### 追加
- **トラックテーブルの列をカスタマイズしやすく**：ヘッダ右端のドラッグで列幅をリサイズ（Genre/タグ列も全部見える幅に広げられる）。列の並べ替えをヘッダ直接ドラッグ＋カスタマイズメニューのポインタ操作で確実に行えるよう刷新。トラック番号列の発見性を改善（"#" → "Track #"）し、表示順の連番列「No.」を追加。右ペインを隠せるトグルを追加。設定は永続化（既存設定は非破壊で移行）。

#### 改善
- **設定画面を開く速度を改善**：OS フォントの全列挙を、フォント設定セクションを開いたときだけ行う遅延ロードに変更（設定オープン時の引っかかりを解消）。

#### モバイル（OTA 配信）
- サーバー未接続でもダウンロード済みの曲・プレイリスト・アルバムを閲覧／再生できるように。アーティストの束ね方をアルバムアーティストに切り替える設定を追加。(#56)

### English

#### Added
- **Easier track-table column customization**: drag the right edge of a header to resize columns (widen the Genre/tags column so everything shows). Reworked column reordering to work reliably via direct header drag and pointer-based reordering in the customize menu. Improved discoverability of the track-number column ("#" → "Track #") and added a sequential "No." column for the current view order. Added a toggle to hide the right rail. All persisted (existing settings migrated non-destructively).

#### Improved
- **Faster Settings open**: enumerate OS fonts lazily, only when the Fonts section is opened (removes the hitch when opening Settings).

#### Mobile (OTA)
- Browse and play downloaded tracks, playlists, and albums even when the server is unreachable. Added a setting to group artists by Album Artist. (#56)

## [v0.8.0] - 2026-06-21

### 日本語

#### 追加
- **モバイル / Android TV クライアント向けに内蔵 HTTP API を拡張**（クライアント本体は EAS で別途配布）。(#56, #57)
  - `GET /api/albums`（アルバム一覧）。`GET /api/tracks` に `?album` / `?artist` 部分一致フィルタを追加。
  - `GET /api/tracks/{id}/stream` にクライアント向けパラメータ：`?native=1`（端末が再生できる形式は無変換で配信＝ALAC/FLAC 等をロスレスのまま）・`?original=1`（常に原本）・`?fmt=aac&br=N`（AAC-LC へ再エンコード。オフライン保存の容量節約用）。
  - **デバイスペアリング**：`POST /api/pair/start`・`GET /api/pair/poll`（いずれも token 不要）＋設定に「端末を承認」UI。カメラの無い端末（Android TV 等）が長いトークンを手入力せずに接続できます。

### English

#### Added
- **Extended the built-in HTTP API for the mobile / Android TV clients** (the client apps ship separately via EAS). (#56, #57)
  - `GET /api/albums` (album list); `?album` / `?artist` substring filters on `GET /api/tracks`.
  - Client-aware streaming on `GET /api/tracks/{id}/stream`: `?native=1` (serve original bytes for device-playable formats — ALAC/FLAC stay lossless), `?original=1` (always original), `?fmt=aac&br=N` (transcode to AAC-LC for compact offline downloads).
  - **Device pairing**: `POST /api/pair/start` + `GET /api/pair/poll` (no token) plus an "approve device" UI in Settings, so cameraless devices (Android TV, etc.) can connect without typing a long token.

## [v0.7.1] - 2026-06-20

### 日本語

#### 変更
- **リポジトリ名を `crateforge` に変更**。アプリ内アップデートのエンドポイント・各種 GitHub リンク・dj-curator プラグインのメタデータを新リポジトリ名へ更新しました。GitHub の自動リダイレクトにより旧 URL も当面動作します。(#60)

### English

#### Changed
- **Renamed the repository to `crateforge`.** Updated the in-app updater endpoint, GitHub links, and dj-curator plugin metadata to the new name. Old URLs keep working for now via GitHub's automatic redirects. (#60)

## [v0.7.0] - 2026-06-20

### 日本語

#### 追加
- **LAN ストリーミング + Web プレイヤー + デスクトップ遠隔操作**：「LAN 公開」を有効にすると、同じ Wi-Fi のスマホ/TV/PC のブラウザからライブラリを再生できます（接続URL＋**QR コード**を設定に表示）。曲一覧・検索・プレイリスト・ジャンル/年代絞り込み・**アートワーク**・**Up Next**・**似た曲**に対応し、「この端末で再生」と「PCで再生（リモコン）」を切替できます。**iOS は「ホーム画面に追加」で全画面アプリ化（PWA）**。読み取り専用＋トークン必須で、書き込みはローカルのみ。(#53)
- **表示フォントの選択 + CJK フォント統一**：OS のインストール済みフォントから表示フォントを選べます。さらに **Noto Sans CJK** をダウンロードすると、簡体字・繁体字・日本語が1フォントに統一されます（外部ダウンロード方式で本体は軽量なまま）。(#51)
- **整理先フォルダの自動検出**：設定の「自動検出」で、既存の曲のパスから整理先（ライブラリルート）を推定して設定できます。

#### 修正
- iOS のホーム画面 PWA で認証トークンが失われる問題、Noto CJK フォントで簡体字が太く表示される問題を修正。

### English

#### Added
- **LAN streaming + web player + desktop remote control**: enable "LAN 公開" to play your library from a phone/TV/PC browser on the same Wi-Fi (connection URL + **QR code** shown in Settings). Browse tracks/playlists/genres, search, filter by decade, see **artwork** / **Up Next** / **similar tracks**, and switch between "play on this device" and "play on the PC (remote)". **iOS supports Add-to-Home-Screen (PWA)**. Read-only + token-required; writes stay local. (#53)
- **Choose the UI font + unify CJK rendering**: pick from installed OS fonts; download **Noto Sans CJK** to render Simplified/Traditional Chinese and Japanese in one consistent font (fetched on demand to keep the app lean). (#51)
- **Auto-detect the organize root**: a "Detect" button infers the library root folder from your existing tracks' paths.

#### Fixed
- iOS home-screen PWA losing the auth token; Simplified Chinese rendering too bold with the Noto CJK font.

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
