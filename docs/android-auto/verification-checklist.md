# Android Auto 対応 検証チェックリスト（リリース記録テンプレート）

- 対象: `clients/apps/mobile`（`com.tainakanchu.crateforge`）／仕様書 v1.1 §10.4・§11.2・§11.3・§13・§14.4
- 設計: [`design.md`](./design.md)（§8 テスト計画、§7 CI/リリース）
- 使い方: リリースごとにこのファイルを複製（または PR/Release のコメントに貼り付け）し、**PO が実機・DHU・実車で確認した結果を「状態」「記録」欄に書き込む**。
- 版: 初版（実装 PR 時点）。**実機・DHU・実車の検証はまだ 1 件も実施していない。**

## 凡例

| 区分 | 意味 |
|---|---|
| **A** | 自動化済み。CI（`mobile.yml` / `android-apk.yml` / `release.yml`）または開発環境の単体テストで検証する。PR 上の CI 結果が証跡 |
| **O** | owner-only。DHU・実機・実車でしか確認できない。PO が実施して記録する |

| 状態 | 意味 |
|---|---|
| 自動 | A 区分。CI 緑 = 合格（CI の実行 URL を記録欄に貼る） |
| **未実施** | O 区分でまだ誰も確認していない（現時点の既定値） |
| 合格 / 不合格 / 一部 | PO が確認後に更新する |
| 対象外 | 当該リリースでは該当しない（理由を記録） |

> 開発環境・CI には Android エミュレータ／DHU／実車が無い。O 区分を「未実施」のまま出荷する場合は、その旨を Release ノートに残すこと（仕様 §14.4「未検証ならその旨」）。

---

## 1. リリース記録（仕様 §14.4・必須記入）

| 項目 | 記録 |
|---|---|
| GitHub Release の tag | |
| 添付アセット名（`crateforge-android-<version>.apk` / `.apk.sha256`） | |
| APK の SHA-256（Release からダウンロードした実ファイルを `sha256sum` した値） | |
| 署名証明書 SHA-256（`apksigner verify --print-certs`） | |
| `repository variable CRATEFORGE_ANDROID_CERT_SHA256` と一致 | |
| versionName / versionCode（`aapt2 dump badging`） | |
| Android Auto アプリのバージョン | |
| Android OS（端末名・ビルド） | |
| 車載機 / DHU（機種・DHU バージョン） | |
| Android OS の「この提供元からのインストールを許可」の状態 | |
| Android Auto 開発者設定「Unknown sources」の状態（ON/OFF） | |
| サイドロード版でランチャー表示・閲覧・再生・操作が成功したか（未検証ならその旨） | |
| 配布物・実機構成に依存する制約、残存不具合 | |
| 検証者 / 日付 | |

---

## 2. 配布物の検証（仕様 §10.4・§14.4）

| ID | 項目 | 区分 | 自動検証の根拠 | 状態 | 記録 |
|---|---|---|---|---|---|
| D-1 | package=`com.tainakanchu.crateforge`、versionCode/versionName が `scripts/android-version.mjs` の出力と一致 | A | `verify-apk.sh --expect-version-*`、`__tests__/android-version.test.mjs` | 自動 | |
| D-2 | 署名: `apksigner verify`（v2/v3）が通り、署名者が 1 つ | A | `verify-apk.sh` | 自動 | |
| D-3 | 署名証明書 SHA-256 が `CRATEFORGE_ANDROID_CERT_SHA256` と一致、debug 証明書でない | A | `verify-apk.sh --expect-cert --reject-debug-cert`、keystore 事前検査 | 自動（変数が設定されている場合のみ強制。未設定は警告） | |
| D-4 | メディア再生サービスがちょうど 1 つ（`CrateforgeMediaLibraryService`、exported、`mediaPlayback`、`androidx.media3.session.MediaLibraryService` + `android.media.browse.MediaBrowserService`） | A | `verify-apk.sh` | 自動 | |
| D-5 | expo-audio の `AudioControlsService` が存在しない／`MediaSessionService` 系 action を持つ他の service が無い | A | `verify-apk.sh` | 自動 | |
| D-6 | `MediaButtonReceiver` が 1 つ、`ArtworkProvider`（authorities=`<package>.crateforge.artwork`） | A | `verify-apk.sh` | 自動 | |
| D-7 | `com.google.android.gms.car.application` → `automotive_app_desc`（`<uses name="media"/>` のみ）、attribution icon（単色 vector） | A | `verify-apk.sh` | 自動 | |
| D-8 | AAOS（`android.hardware.type.automotive`）・Car App Library 宣言が無い | A | `verify-apk.sh` | 自動 | |
| D-9 | `expo_runtime_version` が clean checkout の fingerprint と一致（OTA 整合、`production` チャネル） | A | `android-apk.yml`（`expo-updates runtimeversion:resolve`）+ `verify-apk.sh` | 自動 | |
| D-10 | `expo prebuild --clean` を 2 回実行して `android/` が完全一致、prebuild 後に `apps/mobile/package.json` を復元 | A | `android-apk.yml` | 自動 | |
| D-11 | iOS prebuild の `UIBackgroundModes` が `["audio"]` のまま、TV の Android prebuild に expo-audio サービスが残り Android Auto が混入しない | A | `mobile.yml` | 自動 | |
| D-12 | **GitHub Release の実アセットを端末にダウンロード**し、SHA-256 が `.apk.sha256` と一致 | O | — | **未実施** | |
| D-13 | 実アセットを通常インストールできる（Android OS の提供元許可のみで可） | O | — | **未実施** | |
| D-14 | **EAS 版（旧配布）からの上書きアップデート**がアンインストールなしで成立し、ダウンロード曲・プレイリスト・接続情報が維持される | O | versionCode は 1 億オフセットで必ず EAS 版より大きい（`android-version.test.mjs`）が、署名鍵が同一かは実機でのみ確認可 | **未実施** | |
| D-15 | 前 GitHub 版 → 新 GitHub 版の上書きアップデートとデータ維持 | O | — | **未実施** | |
| D-16 | アップデート直後、アプリを 1 度開くまで車載からの LAN ストリームは使えない（オフライン DL 曲は使える）ことの確認（PO 決定 Q5） | O | — | **未実施** | |

---

## 3. デバイス／車載検証（仕様 §11.2）

DHU の起動手順: スマホの Android Auto で開発者モードを有効化 → 「Start head unit server」→ `adb forward tcp:5277 tcp:5277` → PC で `desktop-head-unit`。

| ID | 項目 | 区分 | 状態 | 記録（端末/ホスト・結果・ログ） |
|---|---|---|---|---|
| V-1 | Android Auto のランチャーに専用アイコンと「Crateforge」が表示され、起動できる | O | **未実施** | |
| V-2 | 開発者設定「Unknown sources」**ON** でアイコンが表示される | O | **未実施** | |
| V-3 | 「Unknown sources」**OFF** 時の見え方を記録（端末/ホスト差あり） | O | **未実施** | |
| V-4 | Android OS の提供元許可と Android Auto の Unknown sources が**別設定**であることを実機で確認（前者だけではランチャーに現れない場合がある） | O | **未実施** | |
| V-5 | Activity 未起動（アプリを一度も開いていない）／画面 OFF／プロセス再作成の状態から、車載でライブラリに到達できる | O | **未実施** | |
| V-6 | 4 カテゴリ（ダウンロード済み／プレイリスト／アーティスト／アルバム）を閲覧でき、ダウンロード済み曲・プレイリスト・アルバム・アーティストから再生できる | O | **未実施** | |
| V-7 | Now Playing のアートワーク／メタデータ／進捗、play/pause/seek/next/prev/repeat/shuffle が正しく動く | O | **未実施** | |
| V-8 | ローカルのみ（オフライン）で再生できる | O | **未実施** | |
| V-9 | LAN ストリーミング可能な状態でオンライン曲を再生できる | O | **未実施** | |
| V-10 | LAN 瞬断（Wi-Fi OFF/ON）で長時間ローディングやクラッシュにならず、復帰後に再生できる | O | **未実施** | |
| V-11 | トークン失効（デスクトップでトークン再発行）時に、明示エラーとなりストリームを繰り返し試みない | O | **未実施** | |
| V-12 | ハンドル操作／Bluetooth メディアボタンで再生・一時停止・次/前が効く | O | **未実施** | |
| V-13 | 着信（電話）で音声が止まり、通話終了後に再開する（Audio Focus） | O | **未実施** | |
| V-14 | ナビ音声でダッキング／一時停止し、終了後に復帰する | O | **未実施** | |
| V-15 | Gemini／Google Assistant の音声操作（「Crateforge で〇〇を再生」「次の曲」等）と検索 | O | **未実施** | |
| V-16 | Android Auto の画面切り替え・再接続・スマホ画面オープンで、**二重音声／キュー齟齬がない** | O | **未実施** | |
| V-17 | スマホ側 UI の操作が車載に、車載の操作がスマホ UI に反映される | O | **未実施** | |
| V-18 | ホスト差・解像度差・タッチ/ロータリー操作、ライト/ダーク、アートワーク欠損時の表示 | O | **未実施** | |
| V-19 | 端末再起動後・MediaButton 起動・プロセス再生成後の復元（接続しただけでは自動再生しない） | O（「接続だけで再生しない」は単体で自動検証） | **未実施** | |
| V-20 | 非対応形式（aiff/caf の原本）で明示エラーと「AAC で再ダウンロード」導線が出る | O | **未実施** | |

---

## 4. 性能・品質基準（仕様 §11.3、自主適用）

Google Play の審査提出は不要だが、公式品質チェックリストを自主基準とする。**実測値とログをここに記録**（Robolectric 上の値は代替にならない: 設計 R6）。オフラインかつ大量ローカル音源がある場合と、LAN 接続時の両方で測る。

| ID | 基準 | 測定条件 | 区分 | 状態 | 実測値 / ログ |
|---|---|---|---|---|---|
| DR-1 | アプリ固有ボタン操作の応答 2 秒以内 | | O | **未実施** | |
| DR-2 | 車載アプリ起動 10 秒以内 | オフライン／大量曲（1 万曲級） | O | **未実施** | |
| DR-3 | 車載コンテンツ表示 10 秒以内 | 同上 | O | **未実施** | |
| VC-1 | Gemini と Google Assistant の両方で音声操作 | | O | **未実施** | |
| MA-1 | ユーザー操作なしで自動再生しない | 実機（接続/再起動直後）。単体テストでも検証 | O（部分的に A） | **未実施**（単体: 自動） | |
| VD-1/2/3 | アイコン・配色・視認性（昼夜） | | O | **未実施** | |
| EP-1/2 | 公称機能が動作、再表示で状態復元 | | O | **未実施** | |

---

## 5. 自動テストの証跡（A 区分）

| 内容 | 場所 | 実行 |
|---|---|---|
| Kotlin 単体（MediaIds／検索／SourceResolver／QueueModel／永続化／MediaLibrarySession／再生／10,000 曲） | `clients/packages/expo-crateforge-android-auto/android/src/test` | `android-apk.yml`（`:expo-crateforge-android-auto:testDebugUnitTest`） |
| JS（core / mobile / TV、native backend、setupPlayback） | `clients/packages/core`, `clients/apps/mobile`, `clients/apps/tv` | `mobile.yml` job `js` |
| config plugin（冪等・署名/version 注入・expo-audio 無効化） | `clients/packages/expo-crateforge-android-auto/plugin/__tests__` | `mobile.yml` job `js` |
| versionCode 計算、APK 検査スクリプト | `clients/apps/mobile/scripts/__tests__` | `mobile.yml` job `js` |
| prebuild 再現性 ×2、release ビルド、APK manifest 検査、OTA 整合 | — | `android-apk.yml` |
| iOS／TV 回帰（prebuild） | — | `mobile.yml` job `js` |

CI 実行 URL: （PR / Release ごとに記入）

---

## 6. Definition of Done（仕様 §13）の対応状況

| # | 受け入れ基準 | 検証 | 状態 |
|---|---|---|---|
| 1 | GitHub Releases の署名済み APK が、Unknown sources ON の端末でランチャーに専用アイコン表示 | V-1, V-2, D-12, D-13 | **未実施** |
| 2 | 車載画面で 4 カテゴリ・階層・楽曲選択・Now Playing が動作 | V-6, V-7 | **未実施** |
| 3 | スマホで 1 回も画面を開かない起動シーケンス（既存 DL データあり）から再生できる | V-5。単体: JS 未起動での import／browse | 単体は自動 / 実機 **未実施** |
| 4 | 再生主体が単一の Media3 ExoPlayer + MediaLibrarySession で、二重音声／二重曲送りがない | 単体（遷移 1 回）+ V-16 | 単体は自動 / 実機 **未実施** |
| 5 | Android Auto の操作がスマホ Zustand UI に反映され、逆も同様 | JS テスト（偽 bridge）+ V-17 | JS は自動 / 実機 **未実施** |
| 6 | オフライン DL 曲・保存プレイリスト・アートワークが JS なしで利用できる | 単体 + V-5, V-8 | 単体は自動 / 実機 **未実施** |
| 7 | オンラインライブラリが LAN 接続時に使え、オフラインで停止・長時間ローディングしない | V-9, V-10 | **未実施** |
| 8 | play/pause/stop/next/prev/seek/queue/shuffle/repeat と連続再生 | 単体 + V-7 | 単体は自動 / 実機 **未実施** |
| 9 | Gemini/Assistant、検索、メディアボタン、Audio Focus/着信/ナビ音声 | V-12〜V-15 | **未実施** |
| 10 | MediaButtonReceiver 再開・プロセス再生成・再起動時の安全な復元 | V-19 | **未実施** |
| 11 | 既存 JSON ダウンロードデータのマイグレーションと整合 | 単体（実データ形 fixture） | 自動 |
| 12 | アートワーク・表示名・単色 attribution アイコンが公式ガイドラインを満たす | D-7 + V-18, VD-1/2/3 | 構造は自動 / 視認性 **未実施** |
| 13 | 全サポート形式で再生・シーク仕様が検証され、非対応時に明示エラー／救済導線 | 単体 + V-20 | 単体は自動 / 実機 **未実施** |
| 14 | トークン／ローカルファイルの不正公開がなく、exported Service への接続を検証 | 単体（ControllerPolicy・トークン非露出） | 自動 |
| 15 | `expo prebuild --clean` で完全再生成でき、Android release／iOS／TV に回帰がない | D-10, D-11 | 自動 |
| 16 | 自動テストが通り、DHU/実車の操作確認結果と品質チェックリストの証跡がある | 本ファイル | 自動テスト: 自動 / DHU・実車: **未実施** |
| 17 | 標準 MediaBrowser 方式のままで Car App Library 依存を追加していない | D-7, D-8 | 自動 |
| 18 | 正しい鍵で署名され、バージョン上昇・既存インストールへの上書き更新が成立 | D-3, D-14, D-15 | 署名は自動 / 上書き更新 **未実施** |
| 19 | CI から GitHub Releases へ署名済み APK を添付でき、SHA-256/署名検証・通常インストール・車載起動を確認できる | `release.yml`（release-android）+ D-12, D-13, V-1 | 添付は自動 / 実インストール・車載 **未実施** |
| 20 | 開発者モード/Unknown sources の設定手順とトラブルシューティングを README に記載 | `clients/apps/mobile/README.md` | 記載済み |
| 21 | Google Play への提出・審査・公開がなくても完了と判定できる | 設計上 Play 関連ジョブなし | 自動 |
