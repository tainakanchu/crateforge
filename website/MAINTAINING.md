# ドキュメントの保守（アップデート追従の仕組み）

GitHub Pages の使い方ドキュメント（`website/src/content/docs/`）が、実装の更新に
取り残されて **嘘になる** のを防ぐための運用ガイド。二段構えで鮮度を担保する。

1. **機械チェック（自動）** — コードから一意に抽出できる事実を CI で照合。
2. **人間レビュー（リリース時）** — 振る舞いレベルの記述を、下のチェックリストで確認。

---

## 1. 機械チェック — `pnpm check:docs`

`scripts/check-docs.mjs` が、実装とドキュメントの **ドリフト** を検出する。

| チェック | 抽出元（真実） | 照合先（ドキュメント） |
|---|---|---|
| ロケール整合性 | `docs/guide/` のファイル集合 | `en/guide/` `zh-tw/guide/` が同じ集合か |
| API エンドポイント実在性 | `src-tauri/src/api/mod.rs` の router | `guide/api-server.md` の `/api/...` が実在するか |
| 既定 API ポート | `src-tauri/src/commands/api.rs` の `DEFAULT_PORT` | `guide/api-server.md` に同じ番号があるか |
| 変換フォーマット | `src/types/convert.ts` の `ConvertFormat` | `guide/convert.md` が全フォーマットを載せているか |
| リッピング フォーマット | `src-tauri/src/models.rs` の `EncodeFormat` | `guide/import.md` が全フォーマットを載せているか |

- **ローカル実行**: `pnpm check:docs`（依存なしの素の Node スクリプト）。
- **CI**: `.github/workflows/docs-check.yml` が、`src-tauri/src/**` `src/types/**`
  `website/src/content/docs/**` を変更する PR / push で自動実行し、ドリフトがあれば失敗する。
- チェックを足したいときは `scripts/check-docs.mjs` の `CHECKS` 配列に 1 つ追加するだけ。

> 「存在しないエンドポイントを書く」「ポート番号がずれる」「対応フォーマットの記載漏れ」
> といった **機械で判る嘘** はここで弾ける。下の振る舞いレベルは人間が見る。

---

## 2. リリース時の人間レビュー チェックリスト

機械では判定できない「振る舞い」の記述は、**機能を変えた PR** および
**バージョンを上げるリリース**（`chore(release)` + `v*` タグ）の前に確認する。
各ドキュメントが説明している実装の在り処を併記しているので、差分が出たら更新する。

- [ ] **index.mdx / install.md** — 配布形態・対応 OS・自動更新の挙動
      （`.github/workflows/release.yml` のビルドマトリクス、`src-tauri/src/updater/`、
      `src/components/UpdateBanner.tsx`、`src-tauri/tauri.conf.json`）。
      ※ macOS の対象アーキ（arm64 / Intel）は release.yml のマトリクスが真実。
- [ ] **import.md** — XML 入出力・取り込みフォーマット・整理規則・リッピング
      （`src-tauri/src/itunes_xml/`、`src-tauri/src/importer/`、`src-tauri/src/organizer/`、
      `src-tauri/src/cd_ripper/`、`src/components/Toolbar.tsx` のダイアログ フィルタ）。
- [ ] **convert.md** — 対応フォーマット・ビットレート・ffmpeg 解決順・ライブラリ追加の挙動
      （`src-tauri/src/converter/`、`src-tauri/src/ffmpeg.rs`、`src/components/ConvertDialog.tsx`）。
- [ ] **usb-export.md** — 入口・オプション・計画の表示項目・Traktor の変換規則 / 照合 / MP3 オフセット・
      キュー競合時の挙動・rbx-cli の解決順 / 取得 / 対応 OS
      （`src-tauri/src/usb_export/`、`src-tauri/src/rbx_cli.rs`（`RBX_CLI_VERSION` / `PINNED_SHA256`）、
      `src-tauri/src/traktor_nml/`、`src-tauri/src/commands/usb_export.rs`、`src/components/UsbExportDialog.tsx`）。
      ※ rbx-cli 側の挙動（キャッシュ・同期・中止・エラーコード）は rbx-cli の `docs/protocol.md` が真実。
- [ ] **customize.md** — 列/行高/カバーサイズの選択肢・検索構文・**キーボードショートカット表**
      （`src/components/TrackTable.tsx`、`ColumnPicker.tsx`、`src/App.tsx` のキーハンドラ、
      `src/components/ShortcutHelp.tsx`、`src-tauri/src/text_fold/`、`src-tauri/src/db/tracks.rs`）。
- [ ] **dj-analysis.md / playback.md** — 解析トリガー・ReplayGain 基準・キュー/Crate・Similar の追加先
      （`src-tauri/src/analyzer/`、`src-tauri/src/audio/mod.rs`、
      `src-tauri/src/commands/{analysis,playback}.rs`、`src/components/RightRail.tsx`）。
- [ ] **smart-playlists.md** — 使用可能フィールド・入力補助・編集導線・件数プレビューの有無
      （`src/components/SmartPlaylistEditor.tsx`、`src-tauri/src/playlist_rules/`、`src-tauri/src/smart.rs`）。
- [ ] **api-server.md** — エンドポイント一覧・クエリパラメータ・タグ書き戻し対象・認証/ペアリング
      （`src-tauri/src/api/handlers.rs`、`mod.rs`、`src-tauri/src/commands/{api,pairing}.rs`）。
      ※ エンドポイント実在性は `pnpm check:docs` が機械チェックする。
- [ ] **mobile.md** — 接続方式・ブラウズ軸・ストリーミング パラメータ・オフライン・配布/OTA
      （`clients/apps/mobile/`、`clients/packages/core/`、`src-tauri/src/api/handlers.rs` の `/stream`）。
- [ ] `pnpm check:docs` がローカルでも green になることを確認。

### ロケールについて

**ja が canonical（正典）**。`en/`（英語）`zh-tw/`（繁体字）は ja を訳したもので、
2026-06-22 に全ページ翻訳済み。事実を直すときは **まず ja を直し、3 ロケールすべてに
同じ内容で反映** すること（訳文側も忘れず更新）。`check:docs` のロケール整合性チェックは
「ファイルが揃っているか」だけを見る（訳の鮮度・品質までは見ない）ので、訳の追従は
このチェックリストで担保する。コード識別子・API パス・環境変数・フォーマット名・
キー名・アプリ内 UI ラベルは翻訳せず据え置く。
