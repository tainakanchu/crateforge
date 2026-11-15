# 共通化リファクタリング 設計メモ (2026-11)

- 位置づけ: 重複実装の共通化と、コピー間で食い違っていた挙動の統一の **契約**。
  実装者はこのメモに従い、ここに無い挙動変更をしない。
- 発端: `ArtistsView` が `AlbumsView` のコピーで、AlbumsView だけ直した不具合
  (幅計測が始まらずカードが横長になる、展開行が次の行に重なる) が ArtistsView に残っていた。
  同じ「片方だけ直る」構造がデスクトップ UI・mobile/TV・Rust の各所にあった。

## 原則

1. **ロジックは純関数に出してテストで固定し、hook / コンポーネント / コマンドは薄い配線にする。**
   デスクトップのテストは `node --test tests/desktop/*.test.ts` (DOM なし)、clients は jest、
   Rust は `cargo test` (in-memory SQLite)。
2. **設定フラグの多い万能部品を作らない。** 小さな hook・関数を組み合わせる。コピー間で
   本質的に違う部分 (対象 ID の決め方、データ源、キャッシュ方式、TV の D-pad フォーカス) は共有しない。
3. 依存方向:
   - clients: `apps → packages/core`。core に Expo の UI 系 (`expo-image`, `expo-updates`,
     `expo-device`)・mDNS・フォーカス制御を入れない。新規の純ロジックは `core/src/lib/`。
   - Rust: `commands/*` (Tauri) と `api/handlers.rs` (HTTP) は薄いアダプタ。手順は
     `src-tauri/src/library/` (新設、`AppHandle`・axum に依存しない、引数は `&Database`) に置く。
     エラーは層ごとの enum にし、`ApiError` / `String` への写像はアダプタ側。
4. デスクトップ (`/`) と clients (`/clients`) はパッケージを共有しない (pnpm・テスト基盤・Metro が別)。
   同じ規則の複製は共通テストベクタ (`tests/vectors/*.json`) で固定する。
5. **共通化 (挙動不変) と挙動変更は別コミット。** 挙動変更のコミットは件名か本文に「仕様変更」と書き、
   同じコミットで `docs/ui-spec.md`・ユーザーガイド (ja/en/zh-tw)・`reference.md`・
   CHANGELOG `[Unreleased]` (ja/en) を更新する。

## 統一しないもの

- AlbumsView と ArtistsView を 1 つの汎用ビューにする (共有は行モデルと計測まで)。
- `TrackTable` の 1 次元仮想化をカードグリッド用 hook に入れる。
- 全ダイアログを 1 つの `<Dialog>` に寄せる (共有は外枠と Esc まで)。
- ArtistsView の曲行に BPM・星・右クリックを足す (ui-spec 3.2 で列が決まっている)。
- GUI のアルバム/アーティスト集約と legacy `/api/albums` `/api/artists` (API 契約が別)。
- `organizer::pick_artist` (フォルダ名用) と `ARTIST_NAME_EXPR` (表示用)。
- 実効 BPM の補完 (`apply_effective_bpm`) は HTTP アダプタに残す。
- スマートプレイリスト・YAML ルールのジャンル判定 (`docs/genre/design.md`)。

## フェーズ 1: 共通化 (挙動不変)

### デスクトップ UI (`src/`)
- `lib/gridRows.ts`: `gridMetrics(width)`, `buildGridRows(items, cols, keyOf, expandedKey)`, 安定行キー。
  `hooks/useElementWidth.ts` (callback ref)、`hooks/useCardGridVirtualizer.ts`
  (安定キー、開閉では `measure()` しない、幅/列変更時のみ再計測)。AlbumsView / ArtistsView / TracksView に適用。
  **ArtistsView の展開行の重なりはここで直る (バグ修正)**。
  TracksView の「空状態でマウントするとカードが 2 列に引き伸ばされる」も callback ref 化で直る (Albums / Artists と同じ原因。意図したバグ修正)。
- `lib/format.ts`: 時間表示 (`formatTrackTime` / `formatTotalTime` / `formatPlaybackTime` / `formatRemainingTime`)、`formatBytes`, `formatYmd`。`lib/errors.ts`: `errorMessage`。
  `lib/env.ts`: `isTauri`。`lib/query.ts`: `combineQuery`。重複定義を置き換える (表示は変えない)。
  `errorMessage` は `{ message }` 形式の失敗を優先して読み、Sync 系ダイアログの「[object Object]」表示が直る (意図したバグ修正)。
- `lib/tauriEvents.ts` `subscribeDisposable` + `hooks/useTauriEvent.ts`。App.tsx と
  PairingApprovalDialog の「cleanup が先に走ると購読が残る」形を置き換える (バグ修正)。
- `hooks/useFocusTrap.ts` / `useRestoreFocus.ts` / `useEscapeKey.ts`、`components/modal/ModalFrame.tsx`、
  `AddGenreTagDialog.tsx`、`CovTrackRow.tsx` (共有セルのみ)。
- `lib/trackActions.ts`: ids を受ける操作関数 (play / enqueue / playNext / rating / tag / playlist)。
  エラー通知の **方針の一本化はフェーズ 2** (ここでは各呼び出し元の現行挙動を保つ)。

### clients (`clients/`)
- `core/src/lib/search.ts` (mobile `normalize.ts` を移す)。TV 検索も `isSearchable` を使う
  (CJK 1 文字で検索できる。TV のコメントが「mobile と同値」としていた意図どおりの修正)。
- 星表示は core の半星関数を使う (`conflict.ts` / `settings.tsx` の `/20` 整数化をやめる)。
  `starsToRating` を core に追加。未使用の core `ratingToStars` は削除。
- `core/src/pairing/pairingSession.ts` (状態機械 + mDNS 重複排除の純関数)。TV の文言を
  `describeApiError` と `DESKTOP_API_SETTINGS_PATH` に揃える。
- `core/src/lib/artPlaceholder.ts` (頭文字・色)。TV に `components/Artwork.tsx` を作り 5 箇所を集約し、
  読み込み失敗・アート無しで頭文字プレースホルダを出す。
- `core/src/lib/playlistTree.ts`、`core/src/lib/sort.ts` (`compareNamesUnknownLast`, `compareAlbums`,
  `byDiscTrack`)、`nextRepeat`。並び順を **変える** のはフェーズ 2。
- mobile `features/triage/edits.ts` (`writeRating` / `writeTag` → `"applied" | "queued" | "unsupported"`)。
  長押しメニューの評価でも一覧のクエリを無効化する (バグ修正)。
- `core/src/hooks/browse.ts` (読み取り系 react-query hook。queryKey を定数化してから移す)。

### Rust (`src-tauri/`)
- `library/` 新設。`library::edit::apply_track_edit` (API 版を移し GUI もこれを呼ぶ。最終値の導出を 1 か所に)。
  不正 Camelot キーを `EditError::InvalidKey` にして API は 400。key と本体の UPDATE をトランザクションに。
- `library::similar::similar_hits`、`library::playlists` (`ensure_tracks_editable` と一時再生曲の除外を集約)。
- `library::delete::remove_tracks` (再生キューの掃除をアダプタが必ず行う。同期の退避経路にも適用)。
- DB 層: `TRACK_COLUMNS`、`ALBUM_ARTIST_OR_ARTIST_EXPR` 等の SQL 断片を 1 か所に。
- `rating.rs` (星 ↔ rating の変換を集約。差は明示的な 2 関数のまま残す。統一はフェーズ 2)。
- DB オープンと `map_err` の定型 (`CommandError`) は余力があれば。

## フェーズ 2: 挙動の統一 (仕様変更、ユーザー決定済み 2026-11-15)

| ID | 内容 |
|---|---|
| C1 | GUI のジャンルタグ追加/削除も実ファイルに書き戻す (`docs/genre/design.md` §2) |
| C2 | rating はどの経路でも 0〜100 に収め、`date_modified` を進めない (`set_rating` の規則)。Get Info / `PATCH` / 星クリックで共通。API に範囲外の値が来たら **400** |
| C4 | リモートの「前の曲」に GUI と同じ 3 秒ルール (再生 3 秒超なら頭出し) |
| G1 | `genre:` / `?genre=` をタグ単位の完全一致に (`docs/genre/design.md` §3) |
| R1 | rating ↔ 星の丸めを検索構文の区間方式 (`rating:0` = 0〜19) に統一 (スマートプレイリスト側を合わせる) |
| A2 | 時間表示: 規則は 1 つ。曲の長さ・合計時間・再生位置 (プレイヤーバーを含む) のどれも、1 時間未満は `m:ss`、1 時間以上は `h:mm:ss` (`1:15:03`)。秒未満は切り捨て (`docs/ui-spec.md` §3.8) |
| A3 | デスクトップの曲操作の失敗はトーストで知らせる (再生・キュー追加・rating など全ビュー共通。操作の前段の曲の取得失敗も含む。`docs/ui-spec.md` §4.4) |
| B6 | mobile の評価・タグ書き込みの失敗・未対応はトーストで知らせる (3 経路共通) |
| B5 | TV のアルバム/アーティストの並び順を mobile と同じにする |
| B7 | TV も mobile と同じ接続監視 (`useConnectionMonitor`) を使う |

## フェーズ 3

- C5: `reference.md` の `"Unknown Artist"`・「album が空の曲は除外」の記述を実装 (`""` を返す) に合わせる。
