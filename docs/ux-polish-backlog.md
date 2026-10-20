# UX「気が利く化」リファクタ — 実施記録と残タスク

最終更新: 2026-06-22

このファイルはデスクトップ UX 監査（「機能はあるが作り込み/発見性/フィードバックが甘い」箇所）の
バックログを起点に、**何をどのバージョンで出荷したか**を記録するステータス文書。
当初は未着手 TODO の羅列だったが、第1弾／第2弾を実装・リリースしたため、実施記録の形にリファクタした。

- 出荷形態: デスクトップは `vX.Y.Z` タグ → `release.yml` → アプリ内アップデータ配布。モバイルは EAS OTA。
- 着手時は必ず該当ファイルを Read して現在地を確認すること（行番号は監査時点のおおよその位置）。

---

## ✅ 出荷済み

### v0.8.2（第1弾＋トースト基盤＝本バックログの主要部）
- **グローバルトースト基盤**を新設（`useStore` の `pushToast`/`dismissToast`、`Toaster`）。
  これを土台に **ネイティブ `alert()`/`window.prompt()` を全廃**（サイドバー右クリック、設定エラー、
  クレート保存、変換失敗、TrackTable/CoversView/RipDialog のエラー）。
- **当然できてほしい操作**: 曲名(Track)列のドラッグリサイズ（`nameColWidth` 永続化）、`Enter` で再生、
  省略セル（曲名/album/albumArtist）にホバー全文表示（title）、検索ボックスの制御化＋クリア(×)、
  アプリケーションキーのメニュー位置を focus 行基準に、`Shift+←→` で ±5 秒シーク。
- **キーボード/モーダル**: トラック編集／スマートプレイリスト／変換の各ダイアログを Esc で閉じ、
  初期フォーカス＋Enter 確定に対応。`?` でショートカット一覧オーバーレイ。GenreTagInput は Tab でも
  タグ確定＋候補スクロール。
- **破壊操作の確認**: クレート全消去・ペアリングトークン再生成・トラック編集の未保存破棄。
- **状態の可視化**: Up Next の件数・合計時間・シャッフルバッジ、Now Playing の Key/Energy、
  Similar の "Add all" を全追加済みで無効化、プレーヤーのシークドラッグ・残り時間トグル・音量サム、
  ソート方向(↑/↓)常時表示。
- **サイドバー**: 右クリックをキーボード対応のカスタムコンテキストメニュー化（名前変更・複製・
  ルール編集・削除）、新規作成/名前変更をインライン入力に。Save as Playlist もインライン化。
- **表記/日本語化**: ColumnPicker の「なし/豆/小」→「Off/S/M」、UpdateBanner の日本語化＋
  リリースノート折りたたみ。スマプレ日付条件をネイティブ日付入力に。
- 設定: ReplayGain 変更失敗時の通知＋ロールバック。

### v0.8.3
- 内蔵 API サーバーの再起動を堅牢化（停止の同期化＋3秒で強制終了、`SO_REUSEADDR`/`SO_REUSEPORT`、
  bind リトライ）→「前のサーバーが落ち切らず起動できない」を解消。
- アートワークのサーバー側リサイズ＋webp/jpeg 配信（`?size=&format=`、巨大値はクランプ、後方互換）。
- モバイル(OTA): オフラインのアート/コレクション刷新、アーティストページのアルバム表示、
  再生中→アーティスト遷移。

### v0.8.4
- アルバムを開いた時の曲順をディスク→トラック番号順に修正（#65、デスクトップ＋モバイル OTA）。
- 左上ロゴを正規アプリアイコンに（#59）。
- iPad 等のリモコン Web UI に音量/シャッフル/リピートを追加（#13）。
- 曲メタデータ書き込み API の拡張（composer/comments のファイル反映・disabled 等・一括 PATCH、#41）。
- 再生失敗の可視化（トースト＋crateforge.log、#67）。

---

## ⏳ 残タスク（未着手 / 部分のみ）

- **スマートプレイリストの該当件数プレビュー**（条件をデバウンスで count「N件マッチ」）— 未着手。
- **AlbumView / CoversView のキーボード操作**（矢印/選択）— 未着手（第3弾）。右クリック
  (`onContextMenu`) は対応済み。なお **AlbumsView の仮想化は実装済み**（`useVirtualizer` で
  グリッド行＋展開行を行単位に仮想化、overscan 6、列数は ResizeObserver の幅から算出）。
  CoversView という独立コンポーネントは現存せず、アート前面のブラウズは `AlbumsView` に統合されている。
- **サイドバー幅のリサイズ**（現状 202px 固定）— 未着手。
- **プレイリスト表示中の検索 scope**（現状は強制 library へ）— 未着手。
- **ConvertDialog の失敗ファイル一覧 / 変換中キャンセル**（要バックエンド協調）— 未着手。
- **フォルダ内に新規プレイリスト作成**（フォルダ右クリック「ここに新規」）— 未着手。
- **スマプレ曲数のサイドバー表示** / **ペアリング待ち端末の自動ポーリング＋期限表示** /
  **ColumnPicker の Available 列を任意位置に挿入** / **LicenseList の autofocus・全文キーボード** /
  **CoversView 展開部に Key/Energy** / **UpdateBanner の DL 進捗** — 低優先・未着手。
- **再生不可(#67)の根本対応**: 非対応形式（WMA/.m4p 等）の ffmpeg フォールバック — 別 issue で継続。

---

## 技術メモ / gotchas

- **設定の永続化**: zustand persist `itunes-viewer-settings`。state 追加時は partialize 追加＋version up＋
  migrate を必ず。v8 で `nameColWidth`/`showRemainingTime` を追加（既存設定は非破壊で移行）。
- **列定義**: `src/types/edit.ts` の `FIELD_DEFS`/`FieldKey`/`ALL_FIELDS`/`DEFAULT_FIELDS`。
- **リリース手順**: `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` /
  `src-tauri/Cargo.lock`(crateforge entry) のバージョンを揃え、`CHANGELOG.md` に日英で追記 →
  `chore(release): vX.Y.Z` → タグ `vX.Y.Z` を push → `release.yml` 起動。ダッシュ無しタグ＝ latest。
- **モバイル OTA**: `clients/apps/mobile` で
  `pnpm exec eas update --branch preview --message "..." --non-interactive --environment preview`。
- **重要 ID ルール**: API パスの id は `track.trackId`（`track.id` ではない）。
- **検証**: デスクトップは repo root で `pnpm typecheck` / `pnpm build`、Rust は `nix develop` 経由で
  `cargo test`。モバイルは `clients/apps/mobile` で `pnpm typecheck` / `pnpm test`。
- **git ルール**: commit/push は毎回ユーザーの明示許可が必要。
