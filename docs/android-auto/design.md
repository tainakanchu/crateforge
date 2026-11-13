# Android Auto ネイティブ対応 設計書

- 対象: `clients/apps/mobile`（`com.tainakanchu.crateforge`）／仕様書 v1.1（2026-10-18）
- 位置づけ: 実装者（N / J / C）が **そのまま従う契約**。変更は統合担当（lead）経由で本書を更新してから行う。
- 前提（PO 決定済み）: 署名は EAS 管理鍵をエクスポートして GitHub Secrets に保管し、**GitHub Actions 上の `expo prebuild` + Gradle `assembleRelease` のみ**で署名 APK を作る（EAS Build 不使用）。APK は `release.yml`（tag `v*`）に同梱、desktop Release をブロックしない。1 PR で Step A–E。DHU/実機検証は PO のみ。

---

## 1. 現状調査（2026-10-18, main = v0.15.0）

### 1.1 ワークスペース / ビルド
- pnpm workspace ルートは `clients/`（`pnpm-workspace.yaml`: `apps/*`, `packages/*`、`.npmrc`: `node-linker=hoisted`）。依存は `clients/pnpm-lock.yaml` で `cd clients && pnpm install --frozen-lockfile`（node_modules は `clients/node_modules` に hoist）。`clients/apps/mobile/pnpm-lock.yaml` は旧隔離 install の残骸で **未使用**（触らない）。
- Expo SDK 56 / RN 0.85.3。`expo prebuild` 生成物: AGP 8.12.0、Kotlin 2.1.20（`@react-native/gradle-plugin`）、Gradle wrapper **9.3.1**、compileSdk/targetSdk 36、minSdk 24、NDK 27.1.12297006、newArch + Hermes。release の minify は既定 OFF（`android.enableMinifyInReleaseBuilds`）。
- **`expo prebuild` は `apps/mobile/package.json` の scripts を `expo run:*` に書き換える**（実測）。fingerprint の既定 skip（scripts に "run" を含まない場合のみ除外）が外れ runtimeVersion が変わるため、CI では prebuild 直後に `git checkout -- clients/apps/mobile/package.json` 必須。
- CI（`.github/workflows/ci.yml`）は desktop のみ。`clients/**` の Jest/tsc は CI で一切走っていない。ローカル基準値: mobile Jest 25 suites / 230 tests 緑、`tsc --noEmit` 緑。

### 1.2 再生（JS）
- `clients/packages/core/src/store/player.ts`: zustand `usePlayer`。`queue: Track[]`（表示順）、`order: number[]`（再生順の順列）、`orderPos`、`index = order[orderPos]`。`buildOrder`/`reorderForShuffle`/`upNextEntries`。
  - `next(auto)`: auto && repeat=one → 同曲。末尾 + repeat=all + shuffle → **新しい順列を作り、直前曲が先頭に来ないよう swap** して `fresh[0]` から。末尾 + off → pause + positionMs=0。
  - `prev()`: `positionMs > 3000` → seek(0)、`orderPos-1>=0` → 前、なければ seek(0)。
  - `enqueueNext`: queue は `index+1` に挿入、order は `orderPos+1` に挿入。`enqueue`: 末尾、index=-1 なら再生開始。`moveQueueItem`（shuffle 中は order を写像のみ／OFF は自然順に再構築）、`moveUpNext`、`removeQueueAt`（現在曲削除は次へ）。
  - 自動送りは `_onFinished → next(true)` の **1 経路**。エラーは `_onError`: 連続 3 回（`MAX_CONSECUTIVE_FAILURES`）で停止 + `lastError`「再生できない曲が続いたため停止しました」、それ未満は `next(false)`。
  - `setRate` は 0.5–2.0 clamp。`sleepTimerMs`/`stopAtTrackEnd` は **state のみ**で、実行は `clients/apps/mobile/src/app/player.tsx` の `useEffect`（setTimeout / index 変化検知）＝ **プレイヤー画面がマウントされている時しか効かない**（仕様 6.3 の指摘どおり）。
  - shuffle/repeat は SecureStore `crateforge.player.shuffle` / `crateforge.player.repeat`。queue は永続化されていない。
- `clients/packages/core/src/playback/engine.ts`: `ExpoAudioEngine`（`createAudioPlayer(null,{updateInterval:500})` を 1 個）。ローカル優先（`useDownloads.getLocalUri(trackId)`）→ 接続中なら `streamSource(trackId,{native:true})`（`?native=1` + `X-API-Token` ヘッダ）→ どちらも無ければ `onError("オフラインのため再生できません（未ダウンロード）")`。リモートの Source error は 1 回だけ `?fmt=aac` で再ロード。`setActiveForLockScreen` でロック画面。
- expo-audio プレイヤーを生成する箇所は **`ExpoAudioEngine` のみ**（`createAudioEngine()` 呼び出し元: `apps/mobile/src/app/_layout.tsx`, `apps/tv/src/app/_layout.tsx`, テスト）。プレビュー再生等は無し。リモコンタブ（`features/remote`）はデスクトップ API 操作のみで端末音声なし。
- `apps/mobile/src/components/ErrorBoundary.tsx` が `engine.pause()/release()` を直接呼ぶ。
- **TV（`clients/apps/tv`）も Android** で、`@crateforge/core` の `usePlayer` + `ExpoAudioEngine` をそのまま使う（`src/stores/playerStore.ts`, `src/playback/audioPlayer.ts` は re-export）。→ core に `*.android.ts` の platform split を置くと TV まで切り替わるため **禁止**。

### 1.3 ダウンロード（`core/src/store/downloads.ts`）
- 実ファイル: `Paths.document` = Android `context.filesDir`（expo-modules-core `AppDirectoriesService.persistentFilesDirectory`）。
  - 音源 `files/downloads/<trackId>.<ext>`（original は locationPath の拡張子、圧縮 DL は ADTS で `.aac`）
  - アート `files/downloads/art/<albumArtKey>.webp`（256px webp、アルバム単位で共有）
  - `files/downloads/index.json` = `DownloadEntry[]`、`files/downloads/playlists.json` = `DownloadedPlaylist[]`
- JSON 形（`core/src/lib/types.ts`）:
  - `DownloadEntry { trackId:number; track:Track; localUri:"file:///data/user/0/…/files/downloads/123.aac"; quality:"original"|"aac256"|"aac192"|"aac128"; bytes:number; createdAt:number(epoch ms); artworkUri?: string|null }`
  - `DownloadedPlaylist { playlistId:number; name:string; trackIds:number[]; createdAt:number; pinned?:boolean }`
- 書き込みは毎回全量 `JSON.stringify(Object.values(...))`。trackId キー（同一 trackId は後勝ち）。サーバー識別子は保持していない。

### 1.4 接続・API
- `core/src/store/connection.ts`: SecureStore `crateforge.baseUrl` / `crateforge.token`。`hydrate()` は 6s タイムアウトで `/api/health` を probe。serverId は保持していない。
- `core/src/lib/api/client.ts`: 認証は **ヘッダ `X-API-Token`**（または `?token=`）。サーバー `src-tauri/src/api/mod.rs` の `auth_guard` は `/api/health` を含め LAN では token 必須（公開は pair/PWA 資産のみ）。
- ネイティブが使う API:
  | 用途 | エンドポイント |
  |---|---|
  | 疎通 + scope | `GET /api/health` → `{name, serverId, version, trackCount}`（**serverId は存在するが TS 型に未定義**） |
  | 全曲 | `GET /api/tracks`（パラメータ無し = 全件、Track[]。q 無しでは limit/offset は Rust 側スライス） |
  | プレイリスト | `GET /api/playlists`（フォルダ含む, `persistentId/parentPersistentId/isFolder/isSmart`）、`GET /api/playlists/{id}/tracks?limit=100000` |
  | アート | `GET /api/tracks/{trackId}/artwork?size=<px>&format=webp` |
  | ストリーム | `GET /api/tracks/{trackId}/stream`：既定（パラメータ無し）は browser-native（mp3/m4a/mp4/aac/m4b/ogg/oga/opus/flac/wav/weba/webm）を **原本 ServeFile = Range/206 対応**、他は AAC。`native=1` は aiff/aif/aifc/alac/caf も原本。`fmt=aac&br=N` は ffmpeg の **ADTS 逐次配信（chunked, Content-Length なし, Range 不可）** |
- アルバムはサーバーで `GROUP BY album`（空 album 除外）。モバイルのアルバム曲順は disc→track、アーティスト曲順は album(大小無視)→disc→track、アーティスト名は `trackArtist = artist || albumArtist || "Unknown Artist"`（`""` は falsy）／設定 `artistGrouping` で `trackAlbumArtist` に切替。
- 既存 JS の検索正規化は **`toLowerCase()` + 部分一致のみ**（`(tabs)/index.tsx`）。サーバーも `to_lowercase`。

### 1.5 expo-audio（56.0.12）の Android 実態
- config plugin（`expo-audio/plugin/build/withAudio.js`）は `enableBackgroundPlayback`（既定 true）で `expo.modules.audio.service.AudioControlsService`（`exported=false`, `foregroundServiceType=mediaPlayback`, **intent-filter `androidx.media3.session.MediaSessionService`**）と FOREGROUND_SERVICE(_MEDIA_PLAYBACK) 権限を追加（prebuild で実測確認）。`recordAudioAndroid` 既定 true で RECORD_AUDIO も入っている（現状維持）。
- `AudioPlayer` 生成ごとに `MediaSession` を作る。**Media3 は 1.9.0 固定**（`expo-audio/android/build.gradle`）。
- iOS の `UIBackgroundModes: ["audio"]` は `app.config.ts` の `ios.infoPlist` に既に明示されている（plugin 依存ではない）。

### 1.6 その他
- `expo-crateforge-mdns`（`clients/packages/expo-crateforge-mdns`）: `expo-module.config.json` + `android/build.gradle`（`expo-module-gradle-plugin`）+ `src/index.ts` で `requireOptionalNativeModule`。mobile/tv は `"workspace:*"` 依存で autolinking。これを雛形にする。
- Expo config plugin の mod 実行順: **plugins 配列で後に書いたものが先に実行される**（`withMod` は自 action → `nextMod`）。
- `src-tauri/src/updater` は `releases/latest` の asset を Windows 用に `_portable.zip`→`setup`→`.msi`→`.exe` で選ぶ。`*.apk` / `*.apk.sha256` はどれにもマッチしない。body の `[installer-required]` マーカーのみ参照。

---

## 2. アーキテクチャ

### 2.1 パッケージ / 配置
- 新パッケージ `clients/packages/expo-crateforge-android-auto`（npm 名 `expo-crateforge-android-auto`, private, `"workspace:*"` で **mobile のみ**依存。TV/iOS には入れない）。
- `expo-module.config.json`: `{"platforms":["android"],"android":{"modules":["com.tainakanchu.crateforge.auto.bridge.AndroidAutoModule"]}}`（iOS 実装なし → iOS では `requireOptionalNativeModule` が null）。
- Gradle project 名 `:expo-crateforge-android-auto`、`namespace "com.tainakanchu.crateforge.auto"`、Kotlin パッケージ `com.tainakanchu.crateforge.auto.*`。
- `app.plugin.js` → `plugin/withCrateforgeAndroidAuto.js`（CommonJS、ビルド工程なし）。

```
android/src/main/AndroidManifest.xml       # service/receiver/provider/meta-data/permissions（§6）
android/src/main/res/xml/automotive_app_desc.xml
android/src/main/res/xml/allowed_media_browser_callers.xml   # UAMP 由来の署名 allowlist（Apache-2.0 表記）
android/src/main/res/drawable/ic_crateforge_car_attribution.xml  # 白単色 vector（§6.3）
android/src/main/res/values/strings.xml    # カテゴリ名・エラー文言（日本語）
android/src/main/java/com/tainakanchu/crateforge/auto/
  CrateforgeRuntime.kt            # プロセス単位 singleton（Repository/Store/Executors/Reachability）
  bridge/AndroidAutoModule.kt     # Expo Module "ExpoCrateforgeAndroidAuto"
  service/CrateforgeMediaLibraryService.kt
  service/LibraryCallback.kt      # MediaLibrarySession.Callback
  service/ControllerPolicy.kt     # onConnect 認可
  playback/QueueModel.kt          # JS player.ts の純 Kotlin 移植（Android 非依存）
  playback/CrateforgeShuffleOrder.kt
  playback/SessionPlayer.kt       # ForwardingSimpleBasePlayer(ExoPlayer)
  playback/PlaybackCoordinator.kt # 唯一のコマンド入口（main looper）
  playback/PlaybackPersistence.kt, SleepTimer.kt, StateMapper.kt
  catalog/CatalogDb.kt (SQLiteOpenHelper), CatalogRepository.kt, LegacyJsonImporter.kt,
  catalog/ServerLibrarySync.kt, BrowseTree.kt, MediaIds.kt, MediaItemMapper.kt,
  catalog/SearchNormalizer.kt, SearchRanker.kt, IndexBuckets.kt, DisplayRules.kt
  source/SourceResolver.kt, CrateforgeDataSourceFactory.kt, Reachability.kt, ApiHttp.kt
  security/SecureConnectionStore.kt, KeyProvider.kt (AndroidKeystoreKeyProvider / テスト用 InMemory)
  artwork/ArtworkProvider.kt, ArtworkCache.kt
android/src/test/...                       # JVM + Robolectric
test-fixtures/                             # index.json/playlists.json サンプル、正規化ベクタ
```

### 2.2 依存とバージョン
- **Media3 = 1.9.4 に統一**（`media3-exoplayer`, `media3-session`。datasource は exoplayer 経由）。最新安定は 1.11.1 だが、同一 APK に同居する expo-audio 56 が 1.9.0 でコンパイルされ `@UnstableApi` を多用しているため、マイナーを跨ぐと実行時 `NoSuchMethodError` リスクがある。1.9 系の最新パッチに揃える（Gradle 解決で expo-audio 側も 1.9.4 になる）。`ForwardingSimpleBasePlayer`, `MediaSession.ControllerInfo.isTrusted()/createTestOnlyControllerInfo()`, `onPlaybackResumption(session, controller, isForPlayback)`, `SessionError` は 1.9.4 に存在することを確認済み。
- Guava は media3 から推移。**coroutines / Room / KSP / OkHttp 直接依存は追加しない**。
- 永続化は **framework `SQLiteOpenHelper`**（Room 不採用）。理由: Expo module gradle plugin 配下で KSP plugin を適用するにはルート buildscript への classpath 追加が必要で CNG 上で壊れやすい。SQLite は追加依存ゼロ・Robolectric でそのまま動く。
- テスト: `junit:4.13.2`, `org.robolectric:robolectric:4.17`（SDK36 で問題があれば `@Config(sdk=[34])` 固定）, `androidx.test:core:1.6.1`, `com.google.truth:truth:1.4.4`, `androidx.media3:media3-test-utils(-robolectric):1.9.4`。`testOptions.unitTests.includeAndroidResources = true`。

### 2.3 スレッドと単一性
- **ExoPlayer は 1 個、`MediaLibrarySession` は 1 個**。所有者は `CrateforgeMediaLibraryService`。`CrateforgeRuntime.coordinator` に公開。
- 全ての再生/キュー変更は `PlaybackCoordinator` の main looper 上でシリアル実行（Expo の `AsyncFunction(...).runOnQueue(Queues.MAIN)`、Media3 session callback も application looper = main）。到着順に確定。
- DB 読み取りは `libraryExecutor`（2 スレッド）、書き込み/インポート/同期は `writeExecutor`（1 スレッド）。Media3 callback は `Futures.submit(..., libraryExecutor)` で返す。
- RN Activity / JS が無くても Service 単体で全機能が動く（Runtime は `applicationContext` から遅延生成）。

### 2.4 カタログ DB（`files/../databases/crateforge_auto.db`, version 1）
```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- import.index.fp / import.playlists.fp（size:mtime）, legacy.adoptedScope, sync.<scope>.at, pref.artistGrouping
CREATE TABLE tracks(
  scope TEXT NOT NULL, track_id INTEGER NOT NULL,
  title TEXT NOT NULL, artist TEXT, album_artist TEXT, album TEXT, genre TEXT,
  year INTEGER, disc_no INTEGER, track_no INTEGER, duration_ms INTEGER, ext TEXT,
  disp_artist TEXT NOT NULL, disp_album_artist TEXT NOT NULL,      -- DisplayRules（JS と同一規則）
  artist_key TEXT NOT NULL, album_artist_key TEXT NOT NULL, album_key TEXT,  -- 16hex, album 空なら NULL
  title_n TEXT NOT NULL, artist_n TEXT NOT NULL, album_artist_n TEXT NOT NULL, album_n TEXT NOT NULL, genre_n TEXT NOT NULL,
  track_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, track_id));
CREATE INDEX ix_tracks_album ON tracks(album_key, disc_no, track_no);
CREATE INDEX ix_tracks_artist ON tracks(artist_key, album_n);
CREATE INDEX ix_tracks_aartist ON tracks(album_artist_key, album_n);
CREATE INDEX ix_tracks_title ON tracks(title_n);
CREATE TABLE downloads(scope TEXT NOT NULL, track_id INTEGER NOT NULL, local_path TEXT NOT NULL,
  quality TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, art_path TEXT,
  file_ok INTEGER NOT NULL, PRIMARY KEY(scope, track_id));
CREATE INDEX ix_dl_created ON downloads(created_at DESC);
CREATE INDEX ix_dl_track ON downloads(track_id);
CREATE TABLE local_playlists(scope TEXT NOT NULL, playlist_id INTEGER NOT NULL, name TEXT NOT NULL,
  name_n TEXT NOT NULL, created_at INTEGER NOT NULL, pinned INTEGER NOT NULL, PRIMARY KEY(scope, playlist_id));
CREATE TABLE local_playlist_tracks(scope TEXT, playlist_id INTEGER, pos INTEGER, track_id INTEGER,
  PRIMARY KEY(scope, playlist_id, pos));
CREATE TABLE server_tracks(scope TEXT NOT NULL, track_id INTEGER NOT NULL, PRIMARY KEY(scope, track_id));
CREATE TABLE server_playlists(scope TEXT, playlist_id INTEGER, persistent_id TEXT, parent_pid TEXT,
  name TEXT NOT NULL, name_n TEXT NOT NULL, is_folder INTEGER, is_smart INTEGER, track_count INTEGER,
  PRIMARY KEY(scope, playlist_id));
CREATE INDEX ix_spl_parent ON server_playlists(scope, parent_pid);
CREATE TABLE server_playlist_tracks(scope TEXT, playlist_id INTEGER, pos INTEGER, track_id INTEGER,
  PRIMARY KEY(scope, playlist_id, pos));
CREATE TABLE server_playlist_fetch(scope TEXT, playlist_id INTEGER, fetched_at INTEGER, PRIMARY KEY(scope, playlist_id));
CREATE TABLE recent_plays(scope TEXT, track_id INTEGER, played_at INTEGER, PRIMARY KEY(scope, track_id));  -- 上限 100
CREATE TABLE queue_items(pos INTEGER PRIMARY KEY, scope TEXT NOT NULL, track_id INTEGER NOT NULL, track_json TEXT NOT NULL);
CREATE TABLE playback_state(id INTEGER PRIMARY KEY CHECK(id=1), queue_version INTEGER, idx INTEGER,
  order_json TEXT, position_ms INTEGER, shuffle INTEGER, repeat TEXT, rate REAL,
  sleep_duration_ms INTEGER, sleep_ends_at INTEGER, stop_at_track_end INTEGER, settings_initialized INTEGER);
```
- **「今再生可能」集合** = `downloads.file_ok=1` ∪ （`server_tracks.scope = activeScope` かつ `Reachability == REACHABLE`）。browse/search/キュー生成は全てこの集合で絞る（SQL `EXISTS` 2 本の OR）。
- `onCorruption` 既定（ファイル削除）→ 次回 `ensureImported()` で JSON から再構築。queue は失われ空で起動（エラーにしない）。
- トークン・API URL は DB に保存しない。`track_json` は MediaItem/MediaMetadata/ログに出さない（JS へのキュー返却のみ）。

### 2.5 libraryScope と既存 trackId の移行
- scope = サーバーの `/api/health.serverId`（16 桁 HEX）。無い旧サーバーは `"legacy"`。正規表現 `^[A-Za-z0-9_-]{1,64}$`。
- 既存 `index.json`/`playlists.json` の行は serverId を持たない → `meta.legacy.adoptedScope`（未設定なら `"legacy"`）に割り当て。**最初に serverId 付き `setConnection` を受けた時点で `legacy` を採用 scope に一括付け替え**（`UPDATE … SET scope=?` 同一トランザクション、既存衝突行は legacy 側を削除）し `adoptedScope` を記録。以後のインポートも `entry.serverId ?? adoptedScope ?? "legacy"`。
- J は新規 DL 時に `DownloadEntry.serverId` / `DownloadedPlaylist.serverId`（optional, 追加のみ）を書く。
- 端末ローカル解決は JS と同じく **trackId 主体**: `(scope, trackId)` 完全一致 → 無ければ同 trackId の downloads 行（created_at 最新）を採用。

### 2.6 JSON 移行（`LegacyJsonImporter`）
- `ensureImported()`（Service onCreate・`notifyDownloadsChanged()`・DB 再生成時）: 2 ファイルの `size:lastModified` が `meta` と同じなら何もしない。異なれば `android.util.JsonReader` でストリーム解析し 1 トランザクションで downloads/tracks/local_playlists を全置換（差分適用は不要、10k 件で < 2s 目標）。
- 頑健性: 要素単位で不正（trackId 非数値, localUri 欠落等）はスキップ件数に計上。**ルートが壊れた JSON は既存 DB 行を保持し fp を更新しない**（次回再試行）。ファイル不在 = 空。重複 trackId は後勝ち。
- `localUri` 検証: `Uri.parse` → `file` scheme のみ → `File(path).canonicalFile` が `filesDir/downloads` の canonical 配下であること（`/data/user/0` と `/data/data` の差は canonical 化で吸収）。存在しなければ `file_ok=0`（browse から外れる）。`artworkUri` も `filesDir/downloads/art` 配下のみ採用。
- `tracks` の表示列・正規化列・キーは `track` オブジェクトから `DisplayRules` で導出。

### 2.7 サーバーライブラリ同期（`ServerLibrarySync`）
- 契機: `setConnection` 後、Service 起動時、`Reachability` が REACHABLE になった時、`refreshServerLibrary()`。前回成功から 6h 未満ならスキップ（明示 refresh は除く）。実行中は多重起動しない。
- `GET /api/tracks` をストリーム解析し `tracks`(upsert) + `server_tracks_staging` に書き、完了時に 1 トランザクションで `server_tracks` を差し替え。`GET /api/playlists` も同様。プレイリスト曲は **閲覧時に遅延取得**（3s タイムアウト、10 分以内のキャッシュは即返して裏で更新）。
- root/カテゴリ応答は同期完了を待たない。完了時 `notifyChildrenChanged`（購読中の `category:*`）。
- 差分 API が無いので全量同期（仕様 7.3 の「段階的」は、ローカル即応答 + 後追い同期で満たす）。

### 2.8 接続情報（`SecureConnectionStore`）と疎通（`Reachability`）
- AndroidKeyStore の AES-256-GCM 鍵（alias `crateforge_auto_conn_v1`, 非 exportable）で `{baseUrl, token, serverId}` JSON を暗号化し SharedPreferences `crateforge_auto_secure` に `base64(iv|ct)` 保存。`KeyProvider` を抽象化しテストは InMemory 実装。復号失敗（バックアップ復元・鍵消失）は「未設定」扱い。
- JS 側 SecureStore の値はネイティブから読めない（expo-secure-store の内部形式に依存しない方針）。**JS が 1 度でも起動すれば `setConnection` で共有**。未共有の間もオフライン機能は完全動作（§10 R4）。
- `Reachability`: `GET /api/health`（connect 1.5s / read 2s, `X-API-Token`）、結果 30s キャッシュ、`ConnectivityManager.NetworkCallback` で無効化。状態 `UNKNOWN|REACHABLE|UNREACHABLE|UNAUTHORIZED|SCOPE_MISMATCH`（serverId が activeScope と異なる）。browse スレッドでは **キャッシュ値のみ参照**し、UNKNOWN なら非同期チェックを起動して「到達不可」として即応答。

### 2.9 音源解決（`SourceResolver` + `CrateforgeDataSourceFactory`）
- MediaItem の URI は不透明な `crateforge://track/<scope>/<trackId>`（パス/トークン無し）。`ResolvingDataSource.Factory(DefaultDataSource.Factory(ctx, DefaultHttpDataSource.Factory()), resolver)`。
- 解決順: ① downloads 行があり file 実在 → `file://`（ただし ext が aiff/aif/aifc/caf の original は端末非対応として ②へ、エラーコード `UNSUPPORTED_FORMAT` 記録）。② REACHABLE かつ scope 一致 → `{baseUrl}/api/tracks/{id}/stream`（**`native=1` は付けない**＝browser-native 規則で ExoPlayer が扱える形式だけ原本、他は AAC）＋ ヘッダ `X-API-Token`。当該 trackId に AAC フォールバック印があれば `?fmt=aac&br=192`。③ どちらも不可 → `SourceUnavailableException(OFFLINE_NOT_DOWNLOADED)`。
- 抽出器: `DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true).setAdtsExtractorFlags(FLAG_ENABLE_CONSTANT_BITRATE_SEEKING)` → ローカル `.aac` は近似シーク可。chunked の ADTS 逐次配信は長さ不明で **非シーク**（`isSeekable=false` を state に出し、Android Auto はスクラバ非表示）。
- AAC フォールバック: リモート原本で `ERROR_CODE_DECODING_*` / `PARSING_*` / `DECODER_INIT_FAILED` → 印を付け 1 回だけ `prepare()` し直す（失敗カウントに含めない）。
- HTTP 401/403 → `UNAUTHORIZED`（Reachability も UNAUTHORIZED に落とし以後ストリームしない）、404 → `NOT_FOUND`、5xx → `SERVER_ERROR`、IO/timeout → `NETWORK`、ファイル消失 → `FILE_MISSING`（downloads.file_ok=0 に更新）。

### 2.10 アートワーク（`ArtworkProvider`）
- authority `${applicationId}.crateforge.artwork`（library manifest の placeholder）、`exported=true`, read-only（`openFile` の mode が `r` 以外は `SecurityException`、insert/update/delete は例外）。
- URI: `content://<auth>/t/<scope>/<trackId>`。解決: downloads の `art_path`（webp）→ REACHABLE なら `/api/tracks/{id}/artwork?size=320&format=webp` を取得し `cacheDir/cf-art/<scope>_<id>.webp` に保存（LRU 合計 50MB、1 枚 512KB 上限超は破棄）→ 無ければ `FileNotFoundException`（ホスト側がフォールバック表示）。任意パスは受け付けない（ID パースのみ）。ネットワーク取得は 3s タイムアウト。
- `MediaMetadata.artworkUri` にこの URI を設定。通知は Media3 `DataSourceBitmapLoader` が content:// を読む。最大辺 320px（Binder/メモリ対策）。

### 2.11 検索（`SearchNormalizer` / `SearchRanker`）
- 正規化 `n(s)` = NFKC → `lowercase(Locale.ROOT)` → カタカナ(U+30A1–U+30F6)→ひらがな(−0x60) → 空白・記号（Unicode P*/Z*）を単一スペースに畳み trim。既存 JS（lowercase + 部分一致）の上位互換（JS で一致するものは必ず一致）。ベクタ `test-fixtures/search-normalization.json`（全角英数, 半角カナ, 大小, 中文, 絵文字, 結合文字）。
- 候補: 再生可能集合から `title_n/artist_n/album_artist_n/album_n/genre_n LIKE '%q%' ESCAPE '\'` 上位 2000 行 + プレイリスト名。
- 順位（決定的）: フィールド別 score = exact 0 / prefix 1 / 単語先頭一致 2 / contains 3。focus（`MediaStore.EXTRA_MEDIA_FOCUS` の artist/album/playlist/genre）があればそのフィールドを優先。同点は「ローカル保存あり」→ title_n → trackId。結果: プレイリスト ≤5、アルバム ≤5、アーティスト ≤5（browsable）、曲 ≤50（`search:<seq>#…` 文脈付き）。

### 2.12 コントローラ認可（`ControllerPolicy.onConnect`）
- 許可: (a) `uid == Process.myUid()`（自アプリの MediaController）、(b) `controller.isTrusted`（system / MEDIA_CONTENT_CONTROL 保持 = SystemUI, Bluetooth, Assistant 系の一部）、(c) `allowed_media_browser_callers.xml` の **パッケージ名 + 署名 SHA-256 一致**（`com.google.android.projection.gearhead`, `com.google.android.googlequicksearchbox`, `com.google.android.carassistant`, `com.google.android.apps.bard`(Gemini) 等。UAMP の allowlist を移植）、(d) Media3 legacy/media-button 経由（`LEGACY_CONTROLLER_PACKAGE_NAME` かつ isTrusted）。
- それ以外は `ConnectionResult.reject()`。ログはパッケージ名と判定理由のみ。
- 許可コントローラには標準 Player コマンド + library コマンド。カスタムコマンドは使わない（JS は in-process 直呼び、§5）。Now Playing 用に `setMediaButtonPreferences` で shuffle（`ICON_SHUFFLE_ON/OFF`, `COMMAND_SET_SHUFFLE_MODE`）と repeat（`ICON_REPEAT_OFF/ALL/ONE`, `COMMAND_SET_REPEAT_MODE`）ボタンを状態に応じ更新。

### 2.13 Service ライフサイクル / 通知 / Audio
- `onCreate`: Runtime 取得 → ExoPlayer（`AudioAttributes(USAGE_MEDIA, AUDIO_CONTENT_TYPE_MUSIC)`, `handleAudioFocus=true`, `setHandleAudioBecomingNoisy(true)`, `WAKE_MODE_NETWORK`, `setMaxSeekToPreviousPositionMs(3000)`）→ `SessionPlayer` → `MediaLibrarySession`（id `crateforge`, `setSessionActivity` = launcher Activity の PendingIntent）→ `PlaybackPersistence.restore()`（**paused / playWhenReady=false / prepare しない**）→ `ensureImported()` 非同期。
- 通知: `DefaultMediaNotificationProvider` + small icon `ic_crateforge_car_attribution`。FGS は Media3 が管理（`foregroundServiceType=mediaPlayback`）。`onForegroundServiceStartNotAllowedException` はログのみ。POST_NOTIFICATIONS はメディアセッション通知の免除対象のため要求しない。
- `onTaskRemoved`: Media3 既定（再生中は継続、停止中なら stopSelf）。`onDestroy`: 永続化 flush → session/player release → `runtime.coordinator = null`。
- 接続/起動だけでは再生しない。`onPlaybackResumption(isForPlayback=false)` は保存キューを返すだけ、`true`（MediaButton/明示再開）時のみ Media3 が再生。

---

## 3. Media ID と browse tree

### 3.1 文法（`MediaIds.kt` が唯一のパーサ/ビルダ。不正は `LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)`、例外を投げない）
```
root | recent
category:downloads | category:playlists | category:artists | category:albums
downloads:played | downloads:added | downloads:all
index:<list>:<bucket>          list ∈ {downloads.all, playlists, artists, albums}; bucket ∈ {a..z, num, h-a,h-ka,h-sa,h-ta,h-na,h-ha,h-ma,h-ya,h-ra,h-wa, other}
playlist:<scope>:<playlistId>  pfolder:<scope>:<persistentId>
artist:<key16>                 album:<key16>        key16 = hex(SHA-256(n(displayName)))[0,16)
track:<scope>:<trackId>        正準 playable（文脈なし）
<containerId>#<scope>:<trackId>   文脈付き playable（container は上記 browsable ID または search:<seq>）
<containerId>#all | <containerId>#shuffle   コレクション再生アクション（実曲キューを生成。ダミー曲ではない）
search:<seq>                   直近 8 件の検索結果セッション（メモリ保持、失効時は単曲→そのアルバムで代替）
```
- `#` は他所で使わない区切り。scope 検証 `^[A-Za-z0-9_-]{1,64}$`、trackId/playlistId は正の 10 進 int64。

### 3.2 ツリー
| ノード | 子 | style |
|---|---|---|
| `root` | downloads, playlists, artists, albums（**この優先順**。`EXTRAS_KEY_ROOT_CHILDREN_LIMIT` < 4 なら先頭から切る）。root extras: `android.media.browse.SEARCH_SUPPORTED=true`、browsable=GRID 既定 | category |
| `category:downloads` | `#all`, `#shuffle`, `downloads:played`（再生履歴がある時のみ, 50 件）, 総数 ≤100 なら曲（created_at desc）を直接、>100 なら `downloads:added`（100 件）+ `downloads:all`（索引） | LIST |
| `category:playlists` | オンライン: サーバーのトップ階層（フォルダ先 → 名前順）＋ローカル保存のみのもの。オフライン: ローカル保存（曲は DL 済みに絞る）。>100 は索引 | LIST |
| `category:artists` | 再生可能曲の表示アーティスト（`pref.artistGrouping`）名順。>100 は索引 | GRID |
| `category:albums` | 再生可能曲のアルバム（空 album 除外）名順。>100 は索引 | GRID |
| `artist:<k>` | `#all`, `#shuffle`, そのアーティストのアルバム（album:…） | GRID |
| `album:<k>` | `#all`, 曲（disc→track→title_n→trackId） | LIST |
| `playlist:…` | `#all`, `#shuffle`, 曲（プレイリスト順、再生可能のみ） / `pfolder:…` は子プレイリスト | LIST |
| `recent` | 保存キューの現在曲 1 件（システムのメディア再開 UI 用） | — |
- 1 ノードの子は **最大 500**（決定的順で打切り + ログ）。索引バケットは n(sortKey) 先頭文字で分類（英字/数字/ひらがな行/その他。漢字は読み不明のため other）。バケット内も 500 上限。
- `onGetChildren(page,pageSize)` は全リスト生成後に slice するだけ（ページング非依存）。空カテゴリは空リスト（ダミー禁止）。
- 曲 MediaItem: `isPlayable=true, isBrowsable=false`、title/artist/albumTitle/albumArtist/genre/trackNumber/discNumber/durationMs/artworkUri。browsable は `isBrowsable=true, isPlayable=false`、子数 subtitle。
- ライブラリ変化（import/sync/接続変化）で `notifyChildrenChanged` を `root` と `category:*` に送る。

### 3.3 キュー生成（Android Auto / 音声 / スマホ共通）
- 文脈付き ID → container の再生可能曲リストを §3.2 の順で作り、対象曲の位置を startIndex に。`#all` は先頭から、`#shuffle` は shuffle=ON を設定して開始。
- `artist` の順序は JS アーティスト画面と同じ album(n)→disc→track。`downloads` は created_at desc、`played` は played_at desc。
- `track:` 単体（文脈なし）→ その曲のアルバム（再生可能分）を文脈にする。
- 音声 `requestMetadata.searchQuery`: 空 → 保存キュー再開 → 無ければ recent → 無ければ downloads `#shuffle` → 何も無ければ `SessionError.ERROR_NOT_SUPPORTED`（メッセージ「スマホで曲をダウンロードしてください」）。非空 → 最上位ヒットの種別で album/artist/playlist 全体、曲ならヒット曲 + 残りの検索結果。

---

## 4. キュー意味論（ネイティブ実装）

### 4.1 ExoPlayer との対応（**ExoPlayer がプレイリストを全保持し、遷移の唯一の主体**）
| JS 概念 | ネイティブ |
|---|---|
| `queue`（表示順） | ExoPlayer のメディアアイテム並び（currentMediaItemIndex = `index`） |
| `order`（順列） | `CrateforgeShuffleOrder(order)` を `exo.setShuffleOrder()`。shuffle OFF 時も自然順を保持 |
| `shuffle` | `exo.shuffleModeEnabled` |
| `orderPos` | `order.indexOf(currentMediaItemIndex)`（Coordinator が遷移ごとに再計算） |
| `repeat` | 論理 repeat は Coordinator が保持。**下位 ExoPlayer の repeat は `one→ONE`, `all→ALL`, ただし `all && shuffle` のときだけ `OFF`**（末尾で ENDED を受け再シャッフル） |
- `SessionPlayer : ForwardingSimpleBasePlayer(exo)` が `getState()` で論理 repeat/shuffle と available commands（論理 repeat=all なら末尾でも SEEK_TO_NEXT 有効）を報告し、`handleSeek/handleSetRepeatMode/handleSetShuffleModeEnabled/handleSetMediaItems/handleAddMediaItems/handleRemoveMediaItems/handleMoveMediaItems/handleSetPlaybackParameters/handleStop` を全て Coordinator に委譲。外部コントローラも JS も同じ経路。
- `CrateforgeShuffleOrder.cloneAndInsert/cloneAndRemove` は「挿入は末尾追加・削除は詰める」決定的実装（ExoPlayer 内部用の一時値）。Coordinator は変更直後に必ず計算済みの正確な順列を `setShuffleOrder` し直す（同一 main タスク内なので遷移は挟まらない）。

### 4.2 操作（`QueueModel` は JS 関数の 1:1 移植。テストも `apps/mobile/src/store/player.test.ts` のケースを Kotlin へ移植）
- `setQueue(tracks,start)`: `buildOrder`（shuffle なら start 先頭 + 残りシャッフル）→ `setMediaItems` → `seekTo(start,0)` → `prepare` → `play`。空なら `clearQueue`。
- `playAt(i)`: `seekTo(i,0)`、orderPos 再計算、play。
- **次へ（手動/ホスト）**: `orderPos+1 < len` → `order[orderPos+1]`。末尾: repeat=all → shuffle なら再シャッフル（下記）、でなければ `order[0]`。repeat=off → pause + seek(現在,0)。repeat=one でも手動は次曲。
- **自動**: ExoPlayer に任せる（ONE はリピート、ALL は折返し、OFF は ENDED で停止）。`all && shuffle` は下位 OFF のため末尾で `STATE_ENDED` → Coordinator が `fresh = shuffle(0..n-1)`、`fresh[0]==直前 index` なら `fresh[0]↔fresh[1]` swap → `setShuffleOrder(fresh)` → `seekTo(fresh[0],0)` → play。**遷移は常に 1 回**（ExoPlayer の自動遷移 or Coordinator の seek のどちらか一方だけ）。この折返しのみギャップレスでない（JS と同等）。
- **前へ**: `position > 3000` → seek 0；`orderPos > 0` → `order[orderPos-1]`；それ以外 seek 0（repeat=all でも末尾へは回らない＝JS と同じ）。`COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM` は 3 秒規則なし。
- `setShuffle(on)`: `reorderForShuffle`（ON: 現在位置より後のみシャッフル / OFF: 自然順、現在曲継続）。
- `enqueue(tracks,"end")`: 末尾追加・order 末尾追加。空キューなら追加先頭から再生。`enqueue(tracks,"next")`: queue は `index+1`、order は `orderPos+1` に挿入（複数曲は順に連続挿入）。index<0 なら追加して 0 から再生。
- `removeQueueAt`, `moveQueueItem`, `moveUpNext`, `clearQueue`: JS 実装と同一の順列写像。現在曲削除は次曲を再生。
- `stopAtTrackEnd`: `exo.pauseAtEndOfMediaItems=true`。`PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM` で pause されたら次曲（論理 next, auto）へ paused のまま移動し、フラグを false に戻す。
- **スリープタイマー**: Coordinator が `elapsedRealtime` 基準の Handler で保持。満了で pause + 解除。JS 画面の有無に依存しない。`sleepTimerMs`（選択した長さ）と `endsAtEpochMs` を state に出す。`setSleepTimer` と `setStopAtTrackEnd` は相互排他（JS と同じ）。
- **再生速度**: `PlaybackParameters(rate,1f)`、0.5–2.0 clamp、永続化。
- **エラー**: `onPlayerError` → (AAC フォールバック対象なら §2.9) → 連続失敗 +1。3 回到達で pause + `lastError(TOO_MANY_FAILURES,"再生できない曲が続いたため停止しました")`、未満で `(repeat==all || orderPos+1<len)` なら手動 next + prepare + play、なければ pause。再生位置 >0 で READY & playing になったらカウンタ 0。
- **再生履歴**: 遷移時（reason AUTO/SEEK/PLAYLIST_CHANGED で新曲開始）に `recent_plays` upsert（上限 100）。

### 4.3 永続化 / 復元（`PlaybackPersistence`）
- 保存契機: キュー変更（500ms debounce, 全量）、遷移、pause、再生中 10s ごと（位置のみ）、`onDestroy`。書込みは不変スナップショットを writeExecutor へ。
- 保存内容: queue_items（scope, trackId, track_json）、idx、order、position、shuffle、repeat、rate、sleep（復元時は破棄）、stopAtTrackEnd、queueVersion、settingsInitialized。
- 復元: 破損（order が順列でない・idx 範囲外・JSON 不正）は queue を空にして設定だけ復元。曲ファイル消失は再生時に §4.2 のエラー規則でスキップ。接続先変更で解決不能な曲も同様。

---

## 5. JS ⇄ ネイティブ契約

### 5.1 Expo module API（`clients/packages/expo-crateforge-android-auto/src/` — Step 0 で lead が下記をそのまま作成し凍結）
```ts
// src/ExpoCrateforgeAndroidAuto.types.ts
export type NativeRepeatMode = "off" | "all" | "one";
export type NativeArtistGrouping = "artist" | "albumArtist";
/** Crateforge Track DTO の JSON（camelCase）をそのまま運ぶ。trackId 必須。 */
export type NativeTrackJson = { trackId: number } & Record<string, unknown>;
export type NativeErrorCode =
  | "OFFLINE_NOT_DOWNLOADED" | "FILE_MISSING" | "UNSUPPORTED_FORMAT" | "UNAUTHORIZED"
  | "NOT_FOUND" | "SERVER_ERROR" | "NETWORK" | "TOO_MANY_FAILURES" | "UNKNOWN";
export interface NativePlaybackError { code: NativeErrorCode; message: string; trackId: number | null; atEpochMs: number; }
export interface NativePlaybackState {
  revision: number;              // 発行ごとに単調増加
  queueVersion: number;          // キュー内容/順列が変わるたび単調増加（永続化される）
  queueLength: number;
  index: number;                 // queue インデックス。空は -1
  orderPos: number;              // 空は -1
  currentTrackId: number | null;
  currentScope: string | null;
  isPlaying: boolean;            // playWhenReady && state∉{IDLE,ENDED}
  isBuffering: boolean;
  positionMs: number;
  durationMs: number;            // 不明は 0
  isSeekable: boolean;
  shuffle: boolean;
  repeat: NativeRepeatMode;
  rate: number;
  sleepTimerMs: number | null;
  sleepTimerEndsAtEpochMs: number | null;
  stopAtTrackEnd: boolean;
  lastError: NativePlaybackError | null;
  settingsInitialized: boolean;  // ネイティブが shuffle/repeat を一度でも保存済みか
}
export interface NativeQueueItem { scope: string; trackId: number; track: NativeTrackJson; }
export interface NativeQueueSnapshot { queueVersion: number; items: NativeQueueItem[]; order: number[]; orderPos: number; index: number; }
export interface NativeProgressEvent { positionMs: number; durationMs: number; isPlaying: boolean; }
export interface NativeConnectionInput { baseUrl: string; token: string | null; serverId: string | null; }
export interface CatalogImportResult { downloads: number; playlists: number; skipped: number; error: string | null; }
export type EnqueueMode = "end" | "next";
export type AndroidAutoSubscription = { remove(): void };
```
```ts
// src/index.ts（requireOptionalNativeModule('ExpoCrateforgeAndroidAuto')。null の場合 isAvailable()=false、他は reject(ERR_UNAVAILABLE)）
export function isAvailable(): boolean;
export function connect(): Promise<NativePlaybackState>;          // Service 起動 + MediaController 接続 + 現状態（復元済み）
export function getState(): Promise<NativePlaybackState>;
export function getQueue(): Promise<NativeQueueSnapshot>;
export function setQueue(tracks: NativeTrackJson[], startIndex: number, scope: string | null): Promise<void>; // 常に再生開始
export function playAt(index: number): Promise<void>;
export function play(): Promise<void>;  export function pause(): Promise<void>;  export function stop(): Promise<void>;
export function seekTo(positionMs: number): Promise<void>;
export function skipNext(): Promise<void>;  export function skipPrevious(): Promise<void>;
export function setShuffle(enabled: boolean): Promise<void>;
export function setRepeat(mode: NativeRepeatMode): Promise<void>;
export function setRate(rate: number): Promise<void>;
export function enqueue(tracks: NativeTrackJson[], mode: EnqueueMode, scope: string | null): Promise<void>;
export function removeQueueAt(index: number): Promise<void>;
export function moveQueueItem(from: number, to: number): Promise<void>;
export function moveUpNext(fromOrderPos: number, toOrderPos: number): Promise<void>;
export function clearQueue(): Promise<void>;
export function setSleepTimer(durationMs: number | null): Promise<void>;
export function setStopAtTrackEnd(enabled: boolean): Promise<void>;
export function clearError(): Promise<void>;
export function migrateLegacySettings(s: { shuffle: boolean | null; repeat: NativeRepeatMode | null }): Promise<boolean>; // settingsInitialized=false の時だけ適用し true
export function setConnection(c: NativeConnectionInput): Promise<void>;  // serverId=null かつ baseUrl 同一なら既知 serverId を保持
export function clearConnection(): Promise<void>;
export function setBrowsePreferences(p: { artistGrouping: NativeArtistGrouping }): Promise<void>;
export function notifyDownloadsChanged(): Promise<CatalogImportResult>;
export function refreshServerLibrary(): Promise<void>;
export function addStateListener(l: (s: NativePlaybackState) => void): AndroidAutoSubscription;    // event "onStateChange"
export function addProgressListener(l: (p: NativeProgressEvent) => void): AndroidAutoSubscription; // event "onProgress"
```
- ネイティブ規約: 全関数 `runOnQueue(MAIN)`。Promise は「コマンド実行 → `onStateChange` 発行」の **後に** resolve。不正引数は `ERR_BAD_ARGUMENT`、Service 未接続で再接続も失敗なら `ERR_SERVICE`。`onStateChange` は離散変化時（`Player.Listener.onEvents` を 1 回に集約）、`onProgress` は再生中かつ購読者がいる時のみ 500ms 間隔（`OnStartObserving/OnStopObserving`）。
- MediaController は Service の bind/起動維持のために保持（JS 生存中）。コマンドは Coordinator を直接呼ぶ（巨大キューで Binder 1MB 制限を避け、順序を main looper で確定）。切断時は次コマンドで自動再接続。

### 5.2 core 側（TV/iOS 不変を保証する設計）
- `clients/packages/core/src/playback/nativeBackend.ts`（新規）:
  ```ts
  export interface NativePlaybackBridge {  // module に依存しない構造型。型は nativeTypes.ts に §5.1 と同形で複製
    connect(): Promise<NativePlaybackState>; getQueue(): Promise<NativeQueueSnapshot>;
    addStateListener(l): { remove(): void }; addProgressListener(l): { remove(): void };
    setQueue(tracks: Track[], startIndex: number): Promise<void>; playAt(i: number): Promise<void>;
    play(): Promise<void>; pause(): Promise<void>; seekTo(ms: number): Promise<void>;
    skipNext(): Promise<void>; skipPrevious(): Promise<void>;
    setShuffle(on: boolean): Promise<void>; setRepeat(m: RepeatMode): Promise<void>; setRate(r: number): Promise<void>;
    enqueue(tracks: Track[], mode: "end" | "next"): Promise<void>;
    removeQueueAt(i: number): Promise<void>; moveQueueItem(f: number, t: number): Promise<void>;
    moveUpNext(f: number, t: number): Promise<void>; clearQueue(): Promise<void>;
    setSleepTimer(ms: number | null): Promise<void>; setStopAtTrackEnd(v: boolean): Promise<void>;
    clearError(): Promise<void>;
    migrateLegacySettings(s: { shuffle: boolean | null; repeat: RepeatMode | null }): Promise<boolean>;
  }
  export function installNativePlaybackBackend(bridge: NativePlaybackBridge): { ready: Promise<void>; uninstall(): void };
  export function isNativePlaybackActive(): boolean;
  ```
- `install` は `usePlayer.setState` で **アクション関数だけを差し替える**（hook の同一性・selector・`current()/upNext()/upNextEntries` は不変 → UI 変更最小）。元のアクションは保存し `uninstall()` で復元（テスト用）。
  - 差し替え: `setQueue, playAt, toggle(isPlaying で play/pause), play, pause, next(auto 引数は無視=手動), prev, seek, setRepeat, setShuffle, removeQueueAt, moveQueueItem, moveUpNext, setRate, setSleepTimer, setStopAtTrackEnd, enqueue, enqueueNext, clear, clearError, hydrate`。
  - 無効化（no-op）: `setEngine`, `_onProgress`, `_onFinished`, `_onPlayingChange`, `_onError`（**JS 側自動送りの完全排除**）。`engine` は `NoopAudioEngine` のまま。
  - **楽観更新しない**。結果はネイティブ state で反映。Promise reject 時は `resync()`（`connect()` + `getQueue()`）し `lastError = {message:"操作に失敗しました", at}`。
  - コマンドは呼び出し順に即 dispatch（直列化はネイティブ main queue）。`ready` 解決前のコマンドは内部キューに溜め、解決後に順に送る。
- state 反映規則（**ネイティブが常に勝つ**）:
  1. `ready`: `connect()` → `getQueue()` → `setState({queue: items.map(i=>i.track as Track), order, orderPos, index, isPlaying, positionMs, durationMs, shuffle, repeat, playbackRate: rate, sleepTimerMs, stopAtTrackEnd})`。
  2. `onStateChange`: 上記スカラーを反映。`queueVersion` が保持値より大きければ `getQueue()` を取り直し、取得結果の `queueVersion` が最新以上の場合のみ適用（古い応答は捨てる）。`lastError.atEpochMs` が未見なら `lastError={message, at}`。
  3. `onProgress`: `positionMs/durationMs/isPlaying` のみ。
  4. `hydrate()`（差し替え後）: SecureStore の shuffle/repeat を読み `migrateLegacySettings` に渡すだけ。**キューを空で上書きしない**。
- `core/src/lib/types.ts`: `Health.serverId?: string`、`DownloadEntry.serverId?: string`、`DownloadedPlaylist.serverId?: string`（追加のみ）。
- `core/src/store/connection.ts`: state に `serverId: string | null`（probe の health から設定、disconnect で null）。
- `core/src/store/downloads.ts`: 新規 entry/playlist に `serverId` を記録。`export function setDownloadsPersistListener(fn: (() => void) | null): void` を追加し `persist()/persistPlaylists()` 成功後に呼ぶ（core はネイティブを import しない）。
- `core/src/index.ts` から `nativeBackend` を export。`player.ts` のロジックは変更しない。

### 5.3 mobile 側
- `clients/apps/mobile/src/playback/setupPlayback.ts`（新規）: `setupPlayback(): "native" | "expo-audio"`。`Platform.OS==="android" && AndroidAuto.isAvailable()` なら `installAndroidNativePlayback()`、それ以外は従来どおり `setEngine(createAudioEngine())` + `initPlayback()`（iOS/Expo Go/旧 dev client）。**Android native モードでは `createAudioEngine()`/`initPlayback()` を呼ばない**（expo-audio の Player/MediaSession を作らない）。
- `clients/apps/mobile/src/playback/androidNativePlayback.ts`（新規、仕様 4.1 の `androidMediaEngine.ts` 相当）: module → `NativePlaybackBridge` アダプタ（Track ⇄ NativeTrackJson、scope = `useConnection.getState().serverId`）、および配線:
  - `useConnection.subscribe`: `(baseUrl, token, serverId)` 変化で `baseUrl!=null` → `setConnection`、`null` → `clearConnection`。
  - `setDownloadsPersistListener(debounce(300ms, notifyDownloadsChanged))`、`useDownloads.hydrate()` 完了後に 1 回 `notifyDownloadsChanged()`。
  - `useSettings.subscribe`: `artistGrouping` → `setBrowsePreferences`。
- `_layout.tsx`: `setEngine/initPlayback` 2 行を `setupPlayback()` に置換（hydrate 群より前）。
- `app/player.tsx`: スリープ/曲終わり停止の `useEffect` 2 つを `!isNativePlaybackActive()` のときだけ有効化（ネイティブが実行主体）。
- `components/ErrorBoundary.tsx`: `engine.pause()/release()` → `usePlayer.getState().pause()`（native/JS 共通で安全）。
- `app/downloads.tsx`: `quality==="original"` かつ拡張子 aiff/aif/aifc/caf の行に「AAC で再ダウンロード」アクション（`removeDownload` → 品質 aac192 で `downloadTrack`）。`lastError.code==="UNSUPPORTED_FORMAT"` 時の文言でこの導線を案内（仕様 7.2 の救済導線）。
- `jest.setup.ts`: `jest.mock("expo-crateforge-android-auto", …)`（既定 `isAvailable:false`）。

---

## 6. Config plugin とマニフェスト

### 6.1 library manifest（`android/src/main/AndroidManifest.xml`。AGP の manifest merge で必ず入る＝`prebuild --clean` に依存せず二重宣言も起きない）
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>
  <uses-permission android:name="android.permission.WAKE_LOCK"/>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
  <application>
    <meta-data android:name="com.google.android.gms.car.application" android:resource="@xml/automotive_app_desc"/>
    <meta-data android:name="androidx.car.app.TintableAttributionIcon" android:resource="@drawable/ic_crateforge_car_attribution"/>
    <service android:name="com.tainakanchu.crateforge.auto.service.CrateforgeMediaLibraryService"
      android:exported="true" android:foregroundServiceType="mediaPlayback" android:label="Crateforge">
      <intent-filter>
        <action android:name="androidx.media3.session.MediaLibraryService"/>
        <action android:name="android.media.browse.MediaBrowserService"/>
      </intent-filter>
    </service>
    <receiver android:name="androidx.media3.session.MediaButtonReceiver" android:exported="true">
      <intent-filter><action android:name="android.intent.action.MEDIA_BUTTON"/></intent-filter>
    </receiver>
    <provider android:name="com.tainakanchu.crateforge.auto.artwork.ArtworkProvider"
      android:authorities="${applicationId}.crateforge.artwork" android:exported="true"/>
  </application>
</manifest>
```
- `res/xml/automotive_app_desc.xml` = `<automotiveApp><uses name="media"/></automotiveApp>`。AAOS 用宣言（`android.hardware.type.automotive` 等）は入れない。Car App Library 依存は追加しない。

### 6.2 `plugin/withCrateforgeAndroidAuto.js`（冪等。純関数を export して node:test で検証）
1. **expo-audio の Android サービス無効化**: `app.config.ts` で `["expo-audio", { enableBackgroundPlayback: false }]`（iOS は `infoPlist.UIBackgroundModes` 明示済みで影響なし。`recordAudioAndroid` は現状維持）。加えて本 plugin を **plugins 配列で "expo-audio" より前**に置き（= mod は後に実行）、`withAndroidManifest` で `expo.modules.audio.service.AudioControlsService` が残っていれば除去。さらに `androidx.media3.session.MediaSessionService`/`MediaLibraryService` action を持つ他 service が app manifest にあれば prebuild を失敗させる（MediaButtonReceiver は該当 service がちょうど 1 つでないと例外）。
2. **署名注入**（`withAppBuildGradle`）: `// @crateforge-android-auto:begin` 〜 `end` ブロックを末尾に追加（既存ブロックは置換）。Gradle 実行時に `findProperty('crateforge.signing.*') ?: System.getenv('CRATEFORGE_SIGNING_*')`（`STORE_FILE, STORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD`）を読み、4 つ揃えば `signingConfigs.crateforgeRelease` を作り `buildTypes.release.signingConfig` に設定。揃わなければ template 既定（debug 署名）のまま＝PR CI は秘密なしで成立。`CRATEFORGE_SIGNING_REQUIRED=true` なのに未設定なら `GradleException`。秘密値はコンフィグ時に一切展開しない（fingerprint にも入らない）。
3. **version 注入**（同ブロック）: `crateforge.versionCode`/`CRATEFORGE_VERSION_CODE`、`crateforge.versionName`/`CRATEFORGE_VERSION_NAME` があれば `defaultConfig` を上書き。無ければ Expo 既定。
4. `withGradleProperties`: `org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m`。
5. アイコン/リソース/権限/service は plugin では生成しない（§6.1 の library 側）。R8 は既定 OFF のまま。library に `consumer-rules.pro`（Service/Provider/Module クラスの keep。manifest 参照で通常不要だが保険）。
- `app.config.ts` 変更（N）: plugins に `"expo-crateforge-android-auto"` を **`"expo-audio"` の直前**に追加、`"expo-audio"` → `["expo-audio", { enableBackgroundPlayback: false }]`、`updates.requestHeaders: { "expo-channel-name": "production" }`（GitHub APK が production チャネルの OTA を受ける。§10 Q2）。`version` と `android.versionCode` は触らない（CI が gradle 側で上書き、fingerprint を汚さない）。`eas.json` は変更しない。

### 6.3 アイコン
- ランチャーアイコンは既存 adaptive icon をそのまま使用（Android Auto はアプリアイコンを表示）。
- attribution / 通知 small icon: `ic_crateforge_car_attribution.xml` = 24dp vector、`#FFFFFFFF` 単色・透明背景。既存マーク（`clients/apps/mobile/assets/images/android-icon-monochrome.png` の二重角丸ダイヤ + 中央塗りダイヤ）を 45° 回転 group の stroke 2 本 + fill 1 つで手書き再現。

---

## 7. CI / リリース

### 7.1 バージョン
- `versionName` = ルート `package.json` の `version`（tag `vX.Y.Z[-pre.N]` と一致を検証）。
- `versionCode = 100_000_000 + major*1_000_000 + minor*10_000 + patch*100 + (pre ? N : 99)`（制約: minor,patch ≤ 99, pre N ≤ 98）。例 0.15.0 → 100150099、0.16.0-alpha.1 → 100160001 < 100160099。EAS remote autoIncrement は 1 ずつ増える整数でビルド回数は高々数百 → 1 億オフセットで既存 EAS 版より必ず大きく、上限 2,100,000,000 にも余裕。単調増加はセマンティックバージョン順に従う。帰結: 以後の EAS Build（< 1 億）は GitHub 版への上書き不可（README に明記）。
- 実装: `clients/apps/mobile/scripts/android-version.mjs`（`--tag` or root package.json → `name=…`/`code=…` を `$GITHUB_OUTPUT` 形式で出力、範囲外は exit 1）+ `node:test`。

### 7.2 再利用ワークフロー `.github/workflows/android-apk.yml`（`on: workflow_call`, inputs `signed: boolean`, `version: string`（任意））
1. checkout → pnpm/action-setup@v4（root packageManager）→ setup-node 22（`cache-dependency-path: clients/pnpm-lock.yaml`）→ `actions/setup-java@v4` temurin 21 → `gradle/actions/setup-gradle@v4` → `sdkmanager "ndk;27.1.12297006" "cmake;3.22.1"`（生成 build.gradle の値に合わせる）。
2. `cd clients && pnpm install --frozen-lockfile`。
3. `cd clients/apps/mobile && pnpm exec expo prebuild --platform android --clean --no-install` を **2 回**実行し、`android/` のファイル一覧 + sha256（`build/` `.gradle/` 除外）が一致することを検査 → `git checkout -- clients/apps/mobile/package.json`。
4. `./gradlew :expo-crateforge-android-auto:testDebugUnitTest`（JUnit レポートを artifact）。
5. signed=true: Secret の keystore を `$RUNNER_TEMP/release.jks` に base64 decode、`CRATEFORGE_SIGNING_*` と `CRATEFORGE_SIGNING_REQUIRED=true` を env で渡す。version は 7.1 スクリプト出力。
6. `./gradlew :app:assembleRelease -PreactNativeArchitectures=<PR: arm64-v8a / release: arm64-v8a,armeabi-v7a>`。
7. `clients/apps/mobile/scripts/verify-apk.sh <apk> [--expect-cert <sha256>] [--expect-version-code N]`: `aapt2 dump badging/xmltree` と `apksigner verify --print-certs` で package=`com.tainakanchu.crateforge`、versionCode/Name、service + 2 actions、MediaButtonReceiver 1 個、`com.google.android.gms.car.application`・attribution meta-data、`automotive_app_desc` 内容、provider、**AudioControlsService 不在**、`MediaSessionService`/`MediaLibraryService` action を持つ service が 1 個、`android.hardware.type.automotive` 不在、`expo_runtime_version` が `pnpm exec expo-updates runtimeversion:resolve --platform android`（clean checkout 状態）と一致。signed 時は証明書 SHA-256 が `vars.CRATEFORGE_ANDROID_CERT_SHA256` と一致。
8. 出力 `crateforge-android-<version>.apk` + `crateforge-android-<version>.apk.sha256`（`sha256sum` 形式）を artifact **`android-apk`**（`crateforge-` で始めない）に upload。`if: always()` で keystore 削除。
- job 権限 `contents: read`。PR（fork 含む）では signed=false 固定で secrets を参照しない。

### 7.3 PR 用 `.github/workflows/mobile.yml`（新規。ci.yml は desktop 専用のまま）
- `on: pull_request / push(main)`、paths: `clients/**`, `.github/workflows/mobile.yml`, `.github/workflows/android-apk.yml`。concurrency は ci.yml と同様。
- job `js`（ubuntu）: install → `pnpm -C apps/mobile typecheck && test`、`pnpm -C apps/tv typecheck && test`、`pnpm -C packages/core exec tsc --noEmit`、`pnpm -C packages/expo-crateforge-android-auto exec tsc --noEmit`、`node --test packages/expo-crateforge-android-auto/plugin/__tests__ apps/mobile/scripts/__tests__`、`expo prebuild --platform ios --no-install`（一時 dir）で `Info.plist` の `UIBackgroundModes` に audio があり Android Auto 由来の差分が無いことを確認（iOS 回帰の自動化可能範囲）。
- job `android`: `uses: ./.github/workflows/android-apk.yml` with `signed: false`。

### 7.4 `release.yml` 変更
- 既存 `release` job: `actions/download-artifact@v4` に **`pattern: crateforge-*`** を追加（Android artifact を desktop Release に混ぜない＝競合状態を排除）。needs/if は不変。desktop の挙動・`releases/latest`・updater は不変。
- `build-android`: `if: startsWith(github.ref,'refs/tags/v') || github.event_name=='workflow_dispatch'`、`uses: ./.github/workflows/android-apk.yml`、`with: {signed: true}`、secrets: `CRATEFORGE_ANDROID_KEYSTORE_BASE64`, `CRATEFORGE_ANDROID_KEYSTORE_PASSWORD`, `CRATEFORGE_ANDROID_KEY_ALIAS`, `CRATEFORGE_ANDROID_KEY_PASSWORD`（+ repository variable `CRATEFORGE_ANDROID_CERT_SHA256`）。desktop job とは依存しない。
- `release-android`: `needs: [release, build-android]`, `if: always() && startsWith(github.ref,'refs/tags/v') && needs.release.result=='success' && needs.build-android.result=='success'`, `permissions: contents: write`。artifact `android-apk` を取得 → sha256 再検証 → `gh release upload "$TAG" <apk> <sha256>` → `gh release view --json assets` で 2 つの存在とサイズを確認 → 成功時のみ release body 末尾に「Android（Android Auto 対応 APK）」節（ファイル名・SHA-256・署名証明書 SHA-256・README 導入手順リンク。`[installer-required]` は含めない）を `gh release edit --notes-file` で追記。途中失敗時は `if: failure()` で `gh release delete-asset` により APK/sha256 を両方削除（「APK 同梱」と誤認される半端な状態を残さない）。
- APK 失敗は desktop Release に影響しない（別 job、desktop release job は android に依存しない）。workflow_dispatch では artifact のみ（Release 操作なし）。

### 7.5 ドキュメント
- `clients/apps/mobile/README.md`: 「Android: GitHub Releases の APK（正式配布）」節（取得・SHA-256/証明書確認 `apksigner verify --print-certs`・OS の提供元許可・**Android Auto 開発者モード（バージョン 10 回タップ）→ 開発者向け設定 → Unknown sources ON** と 2 設定が別物である注意・再接続/ランチャーのカスタマイズ・トラブルシュート・既知制約）、「署名鍵運用」（`eas credentials` で 1 回エクスポート → Secrets 4 つ + 変数 1 つ、バックアップ、鍵変更=上書き不可、ローテーション影響）、再現ビルド手順（§8 のコマンド）。EAS 節は「Android 配布には使わない（iOS/OTA 用）」に更新。
- `website/src/content/docs/guide/mobile.md` と `en/guide/mobile.md`: Android Auto 節（ユーザー向け要約 + README へのリンク）。ルート `README.md`: モバイル節に GitHub Releases APK へのリンク。
- `.claude/skills/release/SKILL.md`（+ 旧 `.claude/skills/release.md`）: desktop タグで Android APK も同時発行されること、versionName=desktop version、Secrets 前提、APK 失敗時の再実行（`gh workflow run` ではなく tag の re-run of failed jobs）、EAS build を Android 配布に使わないこと、OTA は `ota:prod`（production チャネル、fingerprint 一致時のみ）。
- `docs/android-auto/verification-checklist.md`: 仕様 §11.2/§11.3/§14.4 の PO 記録用テンプレート。

---

## 8. テスト計画（仕様 §11 対応）

凡例: **A** = 本環境/CI で自動化、**O** = PO 実機/DHU のみ。

| 仕様項目 | 内容 | 区分 | 実装場所 |
|---|---|---|---|
| 11.1 Kotlin unit | MediaIds パース/生成（不正 ID 含む）、DisplayRules、SearchNormalizer（fixture）、SearchRanker、IndexBuckets、BrowseTree（4 カテゴリ, 空, >100 索引, 500 上限, root limit hint）、SourceResolver（優先順位, 401/404, パス逸脱拒否, aiff→stream）、QueueModel（JS player.test.ts 全ケース移植 + 3s 規則 + repeat-all 再シャッフル swap）、重複 trackId、壊れた JSON | A | `android/src/test` |
| 11.1 Session | Robolectric で `MediaLibrarySession` + `MediaBrowser`（in-process）: root/children/getItem/search/getSearchResult、play-from-mediaId（文脈→キュー）、play-from-search（空/非空/focus）、`notifyChildrenChanged` 受信、`createTestOnlyControllerInfo` で未許可パッケージ reject・自 UID/trusted accept | A | 同上 |
| 11.1 再生 | `TestExoPlayerBuilder` + 偽 DataSource: pause/resume/seek/next/prev、shuffle/repeat 3 モード、**遷移 1 回**（`onMediaItemTransition` 回数を計測; 曲末・repeat one・連続 skip・all+shuffle 折返し）、エラー連続 3 回停止、AAC フォールバック 1 回、stopAtTrackEnd、sleep timer（ShadowSystemClock）、rate | A | 同上 |
| 11.1 Audio Focus / MediaButton / 途中切断 | 属性設定と `handleAudioFocus` 有効の検証のみ | A(部分)/O | — |
| 11.1 永続化 | index/playlists.json 互換（実データ形 fixture）、art 参照、欠損/壊れ JSON（行保持）、JS 未起動での import、legacy scope 採用、**10,000 曲**: import < 5s・カテゴリ子 < 500ms・検索 < 500ms（Robolectric 上の緩い上限）、DB 破損→再構築、保存キュー破損→空復元、Keystore 暗号化（InMemory KeyProvider）とトークン非露出（DB/MediaItem/ログ文字列に token が無いことを assert） | A | 同上 |
| 11.1 JS | 偽 bridge で `installNativePlaybackBackend`: hydrate（ネイティブ queue が SecureStore hydrate で消えない＝Android Auto 操作中にスマホ起動）、queueVersion 順序（古い getQueue 応答を捨てる）、`_onFinished` 等 no-op（二重自動送り防止）、reject 時 resync + lastError、ready 前コマンドのバッファ順序、UI 回帰（既存 230 tests 緑、MiniPlayer/player 画面が native モードで描画）、`setupPlayback` の分岐（android+available / android+unavailable / ios）、connection/downloads/settings 配線、TV tests 緑 | A | `apps/mobile/src/playback/__tests__` |
| 11.1 CNG | prebuild --clean ×2 同一、APK manifest 検査（§7.2-7）、release ビルド成立、iOS prebuild 検査 | A | CI |
| 10.1.6 OTA 整合 | APK の `expo_runtime_version` = clean checkout の fingerprint | A | CI |
| 10.4 / 14.4 | GitHub Release の実アセット DL → インストール、EAS 版からの上書き更新とデータ維持、Unknown sources ON/OFF の表示差 | O | checklist |
| 11.2 全項目 | DHU/実車: ランチャー表示、Activity 未起動/画面 OFF/プロセス再作成、4 カテゴリ、Now Playing、LAN 瞬断/トークン失効、ハンドル/BT ボタン、着信/ナビ、Gemini/Assistant、二重音声なし、解像度/ロータリー/ダーク | O | checklist |
| 11.3 DR/VC/MA/VD/EP | 実測値記録 | O（MA-1 の「接続だけで再生しない」は A で単体検証） | checklist |

---

## 9. 作業分割（Step 0 → N / J / C 並行）

### Step 0（lead が並行開始前に実施・コミット単位 1）
- 作成: `clients/packages/expo-crateforge-android-auto/{package.json, tsconfig.json, expo-module.config.json, src/ExpoCrateforgeAndroidAuto.types.ts, src/index.ts, app.plugin.js(= module.exports = require('./plugin/withCrateforgeAndroidAuto'))}`（§5.1 を逐語で）。`package.json`: name/private/main=`src/index.ts`、peerDeps expo/react/react-native、devDeps は mdns と同じ。
- `clients/apps/mobile/package.json` に `"expo-crateforge-android-auto": "workspace:*"`、`cd clients && pnpm install` で `clients/pnpm-lock.yaml` 更新。
- 以後 `src/*.ts`・`package.json`・lockfile の変更は lead のみ。

### N: Kotlin ネイティブ + config plugin
- 所有（作成/変更）: `clients/packages/expo-crateforge-android-auto/{android/**, plugin/**, test-fixtures/**}`、`clients/apps/mobile/app.config.ts`。
- 提供: §5.1 の native 実装（イベント名 `onStateChange`/`onProgress`、モジュール名 `ExpoCrateforgeAndroidAuto`）、§6 の manifest/plugin、§2–4 全て。消費: JS が書く JSON（§1.3 形 + `serverId?`）。
- 完了条件 / 検証コマンド:
  ```bash
  cd clients && pnpm install --frozen-lockfile
  node --test packages/expo-crateforge-android-auto/plugin/__tests__
  cd apps/mobile && pnpm exec expo prebuild --platform android --clean --no-install && git checkout -- package.json
  cd android && ./gradlew :expo-crateforge-android-auto:testDebugUnitTest
  ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
  ../scripts/verify-apk.sh app/build/outputs/apk/release/app-release.apk   # C 提供。未着なら aapt2 で同等確認
  ```
  §8 の Kotlin/Session/再生/永続化テストが全て緑、prebuild 2 回一致、APK に AudioControlsService 不在。

### J: JS/TS（core + mobile）
- 所有: `clients/packages/core/src/**`、`clients/apps/mobile/src/**`、`clients/apps/mobile/jest.setup.ts`。
- 提供: §5.2/§5.3。消費: Step 0 の module TS API（実装は mock で可）。
- 完了条件:
  ```bash
  cd clients && pnpm install --frozen-lockfile
  pnpm -C apps/mobile typecheck && pnpm -C apps/mobile test
  pnpm -C apps/tv typecheck && pnpm -C apps/tv test
  pnpm -C packages/core exec tsc --noEmit
  ```
  既存テスト無改変で緑（ErrorBoundary 等の期待値変更が必要なら最小限）、§8 JS 行のテスト追加、iOS 経路（`Platform.OS="ios"` テスト）で `createAudioEngine` が従来どおり呼ばれる。

### C: CI / リリース / ドキュメント
- 所有: `.github/workflows/{mobile.yml(新), android-apk.yml(新), release.yml}`、`clients/apps/mobile/scripts/{android-version.mjs, verify-apk.sh, __tests__/**}`、`clients/apps/mobile/README.md`、`README.md`、`website/src/content/docs/{guide,en/guide}/mobile.md`、`.claude/skills/release/SKILL.md`、`.claude/skills/release.md`、`docs/android-auto/verification-checklist.md`。
- 提供: §7。消費: N の gradle property/env 名（§6.2）、module の Gradle project 名、APK 期待内容。
- 完了条件:
  ```bash
  node --test clients/apps/mobile/scripts/__tests__
  python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml
  actionlint   # 利用可能なら（無ければ PR 上の実行で確認）
  pnpm check:docs
  bash clients/apps/mobile/scripts/verify-apk.sh <N が作った APK>   # 統合後
  ```
  desktop `release` job の needs/if/upload 対象が `crateforge-*` 以外を含まないこと、APK 失敗時に Release asset が残らないことを YAML レビューで確認。

### 統合（lead）
- N/J/C 統合後: CI 相当をローカルで一巡（§9 各コマンド）→ PR 作成。実機/DHU 未検証項目は PR 本文と checklist に「未実施」と明記。

---

## 10. 仕様との差分・リスク・PO への確認事項

### 10.1 差分（推奨解決を採用済み）
| # | 仕様 | 実態/判断 |
|---|---|---|
| D1 | Plugin が manifest に service/receiver/meta-data を追加 | **library manifest で宣言**（merge で確実・重複なし・CNG 非依存）。plugin は expo-audio 無効化・署名・version を担当。APK 検査で担保 |
| D2 | `player.android.ts` 等の platform split | **TV も Android** のため不可。core にアクション差し替え型 backend、mobile が明示 install |
| D3 | Media3 は実装時点の最新安定 | 最新 1.11.1 ではなく **1.9.4**（expo-audio 56 の 1.9.0 と整合）|
| D4 | Room 等 | **SQLiteOpenHelper**（KSP 不要・低脆弱性）|
| D5 | `eas.json` に `github-release` profile | PO 決定で EAS Build 不使用。`eas.json` は無変更、GitHub Actions + Gradle が唯一の正式経路 |
| D6 | ADTS 逐次配信のシーク対応（サーバー改修 or 一時ファイル）| サーバー改修はしない。原本（Range）＝シーク可、逐次 AAC＝**非シーク**として `isSeekable=false` を明示。ローカル `.aac` は CBR 近似シーク |
| D7 | 原本の端末非対応形式の救済 | ストリームは `native=1` を使わず browser-native 規則（ExoPlayer 非対応の aiff/caf を原本で受けない）。ローカル原本 aiff/caf は到達可能なら AAC ストリーム、不可なら `UNSUPPORTED_FORMAT` + 「AAC で再ダウンロード」導線 |
| D8 | トークンを Keystore へ「移行・共有」| JS SecureStore は維持し、JS 起動時にネイティブ Keystore 暗号化ストアへ複製。**アップデート後 JS 未起動の間は LAN ストリーム不可**（オフラインは可）|
| D9 | 段階的初回同期 | 差分 API が無く全量同期（ローカル即応答 + 後追い、6h スロットル）|
| D10 | repeat-all+shuffle | 折返し時のみ ENDED→再シャッフル（ギャップレスでない。JS と同挙動）|
| D11 | 複数ライブラリ | 現アプリは接続先 1 つ。legacy データは最初の serverId に採用（§2.5）|
| D12 | ExoPlayer の shuffle | 自前の再生順を常に ExoPlayer の ShuffleOrder として与えるため ExoPlayer は常時 shuffle ON で動かす（shuffle OFF でも「次に再生」等で順序が自然順でなくなるため）。コントローラへは実際の shuffle ON/OFF を報告 |
| D13 | 前後曲の再生状態 | 車載/通知の next/prev は現在の再生/一時停止を維持。JS は従来どおり常に再生。repeat off の末尾ではホストの next を無効化 |
| D14 | スキーマ | `server_tracks_staging` テーブルと `tracks(track_id)` インデックスを追加 |
| D15 | 最近再生 | ダウンロード済み配下の「最近再生」はダウンロード済み曲のみ |
| D16 | serverId 学習 | JS が serverId を送らない場合は native が `/api/health` から取得・保存し、旧ダウンロードをそのスコープへ移す |
| D17 | 検索結果 | プレイリスト→アルバム→アーティスト→曲の順にグループ見出し付きで返す。音声要求は曲名一致を優先し、同点は 曲 > アルバム > アーティスト > プレイリスト。`#shuffle` はランダム曲から開始 |
| D18 | 許可コントローラ | UAMP の許可リストから Wear OS を除いたもの。Gemini 単体アプリ（`com.google.android.apps.bard`）は署名ハッシュ未検証のため除外（Google アプリ経由の Gemini とシステム署名の呼び出し元は許可） |
| D19 | `stop()` / `setConnection` | `stop()` はキューを保持し idle にする。`setConnection` は http(s) 以外・クエリ付きのベース URL を `ERR_BAD_ARGUMENT` で拒否 |
| D20 | 再ダウンロード（JS） | §5.3 の「削除→ダウンロード」ではなく `redownloadTrack` で新しい AAC を保存してから旧ファイルを消す（失敗時に既存ファイルを失わない） |
| D21 | JS の再同期 | install 結果に `resync()` を追加し、フォアグラウンド復帰時に呼ぶ。JS 旧実装で無視していた範囲外操作はネイティブへ送らない |
| D22 | 非シーク音源 | JS はシークバーを無効化しない。ネイティブが非シーク音源への `seekTo` を無視する（外部コントローラからもシーク不可） |
| D23 | ビルド環境 | RN Gradle プラグインが JDK 17 toolchain を要求するため、CI は JDK 17 と 21 を導入し `org.gradle.java.installations.fromEnv=JAVA_HOME_17_X64` を渡す |

### 10.2 リスク
- R1 legacy MediaSession（Android Auto 側）へ 1 万曲キューを渡す際の Binder サイズ: Session テストで 10k キュー + legacy browser を検証、問題時は Media3 の queue 公開を現在位置±250 に制限する案。
- R2 ControllerPolicy が厳しすぎると一部 OEM/Wear OS/サードパーティランチャーが接続不可（仕様のセキュリティ要件を優先）。
- R3 CI 時間（RN release ビルド 15–25 分）と NDK/CMake 取得。本環境は NDK 未導入・Gradle wrapper 9.3.1 のダウンロード可否に依存（不可なら `GRADLE_USER_HOME` 事前配置）。
- R4 `ALAC in m4a` 等は端末デコーダ依存。失敗は AAC フォールバック/明示エラーで隠さない。
- R5 prebuild が package.json を書き換える件を CI で戻し忘れると OTA runtime 不一致（verify-apk で検出）。
- R6 Robolectric 上の性能値は実機 DR-2/DR-3 の代替にならない（PO 実測必須）。
- R7 expo-audio のネイティブコードは Android APK に残る（JS から未使用。サイズ増のみ）。

### 10.3 PO 決定事項（2026-10-18）
- Q1 Secrets 名は §7.4 の 4 つで確定。証明書 SHA-256 は repository variable `CRATEFORGE_ANDROID_CERT_SHA256` に登録し、CI で署名一致を強制する（未設定時は警告のみで続行）。
- Q2 GitHub 配布 APK の OTA チャネルは **`production`**（fingerprint 一致時のみ適用）。
- Q3 コントローラは **システム署名アプリ + 既知の Google ホスト（Android Auto / Assistant・Gemini / Bluetooth・SystemUI 等）+ 自アプリ** のみ許可し、それ以外（サードパーティ車載ランチャー、Wear OS アプリ等）は reject。
- Q4 以後 Android は EAS Build を使わない（EAS 版は上書き不可になる）ことを前提とする。
- Q5 アップデート直後、アプリを 1 度開くまで車載からの LAN ストリームは使えない（D8）。README の導入手順に明記する。
