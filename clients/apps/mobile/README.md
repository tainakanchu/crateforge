# Crateforge モバイルクライアント

Crateforge デスクトップが LAN に公開する HTTP API の、薄いモバイルクライアントです。
Expo (React Native, SDK 56) 製。曲ライブラリ／プレイリストの閲覧、端末での再生、
そしてデスクトップ側プレイヤーのリモコン操作を行います。**Android では Android Auto にも対応**しています
（GitHub Releases の署名済み APK で配布）。

## 目次

- [特徴](#特徴)
- [Android: GitHub Releases の APK（正式配布）](#android-github-releases-の-apk正式配布)
  - [インストール手順](#インストール手順)
  - [APK の検証（SHA-256 と署名証明書）](#apk-の検証sha-256-と署名証明書)
  - [Android Auto の設定（OS の許可とは別物）](#android-auto-の設定os-の許可とは別物)
  - [更新と初回起動時の注意](#更新と初回起動時の注意)
  - [トラブルシューティング](#トラブルシューティング)
  - [既知の制約](#既知の制約)
- [メンテナ向け: Android のビルド・署名・リリース](#メンテナ向け-android-のビルド署名リリース)
- [必要環境と開発](#必要環境と開発)
- [接続](#接続)
- [オフライン再生](#オフライン再生)
- [コーデック](#コーデック)
- [iOS / OTA の配布（EAS）](#ios--ota-の配布eas)

## 特徴

- 既存 LAN API を呼ぶだけの薄いクライアント。ライブラリ本体や解析はデスクトップが担う。
- 端末での音声再生。背景再生・ロック画面 / 通知からの操作に対応。
  - iOS: expo-audio（`UIBackgroundModes=audio`）。
  - Android: 自前の Media3（ExoPlayer + `MediaLibraryService`）が再生を担当し、**スマホ・通知・Android Auto が同じ 1 つのプレイヤー／キュー**を操作する。
    アプリを一度も開いていなくても、車載から保存済みライブラリを再生できる。
- **Android Auto 対応**: 車載ランチャーに「Crateforge」が現れ、ダウンロード済み曲／プレイリスト／アーティスト／アルバムを閲覧・検索・再生できる
  （Google アプリ経由の Google Assistant / Gemini による音声操作に対応。実機では未検証。LAN に届くときはデスクトップのライブラリも再生）。
- デスクトップ側プレイヤーのリモコン（再生／一時停止／シーク／キュー操作）。
- 接続は QR スキャン（expo-camera）または手動入力。トークン認証つき。
- 曲／プレイリスト／アルバム単位のオフライン再生（Downloads 画面で管理）。
- ライブラリは「曲」「アルバム」表示を切替可能。アルバム→詳細で全曲再生・アルバム DL。
- プレイリストはフォルダ階層を保持して表示（フォルダをタップで中へ）。
- 大規模ライブラリ対応: 一覧の 500/200 上限を撤廃し、`BROWSE_LIMIT` で全件取得 + 仮想リスト描画。

---

## Android: GitHub Releases の APK（正式配布）

Android 版の**正式な配布経路は GitHub Releases の署名済み APK のみ**です（Google Play・Play Console・内部テストトラックでは配布しません）。
Android Auto 対応は、通常のスマホ用と**同じ 1 つの APK**（同じ `com.tainakanchu.crateforge`）に入っています。別の車載専用 APK はありません。

> **この配布は「利用者が開発者向け設定を手で切り替える」モデルです。** Google Play 版のような手間なしの導入や、
> すべての車載機・Android / Android Auto のバージョンでの動作は保証できません（[既知の制約](#既知の制約)）。

### インストール手順

1. [GitHub Releases](https://github.com/tainakanchu/crateforge/releases) の対象バージョンから
   `crateforge-android-<version>.apk` を取得する（隣にある `crateforge-android-<version>.apk.sha256` も取得すると検証できる）。
   - デスクトップアプリの自動更新は `releases/latest` を見ます。APK はそのリリースに同梱されますが、デスクトップの更新には影響しません。
   - 非公式のミラーや再配布サイトからは入手しないでください。
2. [APK の検証](#apk-の検証sha-256-と署名証明書)で SHA-256（任意で署名証明書）を確認する。
3. Android 端末で APK を開く。「この提供元からのインストールを許可」を求められたら、ブラウザやファイルマネージャなど**開いたアプリ**に対して許可する（Android OS の設定）。
   Play プロテクトの警告が出たら「詳細」→「インストールする」。
4. [Android Auto の設定](#android-auto-の設定os-の許可とは別物)で、開発者モードと **Unknown sources（提供元不明のアプリ）** を有効にする。
5. Crateforge を 1 度開き、デスクトップに接続する（[接続](#接続)）。必要な曲やプレイリストを Downloads でダウンロードしておく。
6. スマホを車載機（または DHU）に接続し直し、Android Auto のランチャー、または「ランチャーのカスタマイズ」で「Crateforge」を確認する。
   出ない場合は Android Auto を再起動する。
7. 車載で Crateforge を開き、ダウンロード済み・プレイリスト・アーティスト・アルバムから再生する。ネットワークに届かないときは**ダウンロード済みの曲だけ**が再生対象になる。

### APK の検証（SHA-256 と署名証明書）

Release のノートには、APK の SHA-256 と**署名証明書の SHA-256**が載っています。ダウンロードしたファイルと突き合わせてください。

```bash
# 1) ファイルの SHA-256（.sha256 と同じフォルダで）
sha256sum -c crateforge-android-<version>.apk.sha256        # macOS: shasum -a 256 -c …

# 2) 署名の検証と署名証明書の SHA-256（Android SDK build-tools の apksigner）
apksigner verify --verbose --print-certs crateforge-android-<version>.apk
#   Verified using v2 scheme (APK Signature Scheme v2): true
#   Signer #1 certificate SHA-256 digest: <Release ノートの署名証明書 SHA-256 と一致すること>

# 3) （任意）パッケージ名・バージョン
aapt2 dump badging crateforge-android-<version>.apk | head -n 1
#   package: name='com.tainakanchu.crateforge' versionCode='…' versionName='<version>'
```

署名証明書の SHA-256 が前回のリリースと**同じ**であることが、上書きアップデートが成立する条件です。違う場合はインストールしないでください。

### Android Auto の設定（OS の許可とは別物）

> **重要: 次の 2 つは別の設定です。** 手順 3 の「この提供元からのインストールを許可」（**Android OS** の設定）だけでは、車載ランチャーに Crateforge が現れるとは限りません。
> Android Auto 側の **Unknown sources** も必要です。

1. スマホで **Android Auto の設定**を開く（見つからなければ設定アプリの検索で「Android Auto」）。
2. 画面の一番下にある **「バージョン」** を **10 回タップ**して開発者モードを有効にする（確認ダイアログで OK）。
   画面名や位置は OS・Android Auto のバージョンで変わります。
3. 右上の **︙（メニュー）→「デベロッパー向けの設定 / Developer settings」** を開く。
4. **「提供元不明のアプリ / Unknown sources」** を **ON** にする。
5. スマホを車載機に接続し直す（必要なら Android Auto を再起動）。ランチャーに出ない場合は「ランチャーのカスタマイズ」で Crateforge が非表示になっていないか確認する。

なお、Google の定める「Unknown sources」は、信頼済みストア以外からインストールされた**メディアアプリ**に適用される例外です。Crateforge は標準のメディアブラウザ方式（`MediaLibraryService`）で作ってあり、
Car App Library（独自テンプレート）のアプリには使えない設定に依存しません。

### 更新と初回起動時の注意

- 新しいバージョンの APK を**そのまま上書きインストール**できます（アンインストール不要。ダウンロード済みの曲・プレイリスト・接続設定は維持されます）。
- **アップデート直後は、アプリを 1 度スマホで開いてください。** 接続情報（アドレスとトークン）は、アプリを開いたときに車載側の暗号化ストアへ共有されます。
  開くまでは、車載からのデスクトップ（LAN）ライブラリのストリーミングは使えません。**ダウンロード済みの曲はアプリを開かなくても車載で再生できます。**
- 以前に EAS ビルド（QR / internal distribution）で配布した版からも、同じ署名鍵であれば上書きできます。**ただし逆（GitHub 版 → EAS 版）はできません。**
  GitHub 版の `versionCode` は EAS が採番する値より必ず大きいためです。以後 Android は EAS Build を使いません。
- JS のみの変更は OTA（EAS Update、`production` チャネル）で届きます。ネイティブ構成が変わる更新（fingerprint が変わる）は APK の入れ替えが必要です。

### トラブルシューティング

| 症状 | 確認すること |
|---|---|
| 車載ランチャーに Crateforge が出ない | ① Android Auto の **Unknown sources が ON** か（OS の提供元許可とは別）。② 開発者モードが有効か（バージョン 10 回タップ）。③ 接続し直す／Android Auto を強制停止して再接続。④「ランチャーのカスタマイズ」で非表示になっていないか。⑤ データ転送対応の USB ケーブルか（有線の場合）。⑥ スマホで Crateforge を 1 度開く。 |
| 開いても一覧が空 | ダウンロード済みの曲／プレイリストが無い。スマホで Downloads から保存する。LAN に届くときは同期後にデスクトップのライブラリも出る（初回は少し待つ）。 |
| デスクトップの曲が出ない・再生できない | ① アップデート後に**スマホでアプリを 1 度開いた**か。② スマホとデスクトップが同じネットワークか（Tailscale 等の URL でも可）。③ トークンを再発行した場合はスマホで再接続する（失効すると車載は明示エラーになりストリームを繰り返し試さない）。 |
| 「上書きインストールできない」「パッケージの競合」 | 署名証明書が違います。APK の[署名証明書 SHA-256](#apk-の検証sha-256-と署名証明書)を前回のリリースと比べる。違う署名の版が入っている場合、入れ替えにはアンインストール（**ダウンロードと設定が消える**）が必要です。 |
| インストールがブロックされる | Android OS の「提供元不明のアプリ」許可（開いたアプリごと）／Play プロテクトの「詳細 → インストールする」。 |
| 特定の曲だけ再生できない（AIFF / CAF の原本など） | 端末が再生できない形式です。Downloads 画面でその曲に出る「AAC で再ダウンロード」を使う。LAN に届くときは AAC に変換されたストリームで再生されます。 |
| シークバーが出ない／動かない | 変換済み AAC のストリーミング（デスクトップが逐次配信）は長さ不明のためシークできません。ダウンロード済みの曲か、原本ストリームならシークできます。 |
| 音声操作（Gemini / Assistant）が反応しない | 端末側の Gemini / Google Assistant のメディア連携が有効か。曲名・アーティスト名・アルバム名・プレイリスト名で試す。ダウンロード済みか LAN に届く曲だけが対象です。 |
| スリープタイマー・「曲の終わりで停止」 | Android ではネイティブ側で動作するので、プレイヤー画面を閉じていても効きます。 |
| 二重に音が出る／キューがおかしい | 不具合の可能性があります。再現手順と Android / Android Auto のバージョンを添えて Issue に報告してください（[検証チェックリスト](../../../docs/android-auto/verification-checklist.md) の V-16）。 |

### 既知の制約

- **Google Play では配布しません。** Android Auto 側の開発者設定（Unknown sources）が必要で、Play 版と同等の手軽さではありません。
- **車載機・OEM・Android Auto / Android のバージョン差**で、表示や挙動が異なる／動作しない可能性があります。保証対象はありません。
  開発者設定やシステム画面の名称・配置は変わるため、上記の手順は検証端末に合わせて保守されます。
- **実機・DHU・実車での検証状況: 未実施。** 現時点では、CI の自動テスト（Kotlin 単体・JS・APK 検査）までが確認済みで、
  Android Auto Desktop Head Unit・実車・GitHub Release 実アセットのインストール確認はこれから行います。
  結果は [`docs/android-auto/verification-checklist.md`](../../../docs/android-auto/verification-checklist.md) に記録します。
- 車載の制御を許可するのは、システム署名のアプリ、既知の Google ホスト（Android Auto／Google アプリ（Assistant・Gemini）／Bluetooth・SystemUI 等）。Gemini の単体アプリは署名を未確認のため現時点では対象外です、そして Crateforge 自身だけです。
  **サードパーティの車載ランチャーや Wear OS アプリなどは接続できません。**
- 接続先のデスクトップは 1 つです（現在のアプリの仕様）。
- 変換済み AAC のストリーミングはシークできません（上記）。端末が再生できない形式の原本はダウンロード済みでも再生できません。
- Android Automotive OS（車載 OS に直接入れるアプリ）、Apple CarPlay、Car App Library のテンプレートアプリは対象外です。
- TV 版（`apps/tv`）は Android Auto の対象外で、従来どおり EAS で配布します。

---

## メンテナ向け: Android のビルド・署名・リリース

### 方針

- APK は **GitHub Actions 上の `expo prebuild` + Gradle `assembleRelease` だけ**で作る（EAS Build は使わない。`eas.json` は変更していない）。
  ネイティブ側（`android/`）は CNG の生成物でコミットしない。署名とバージョンの注入は config plugin（`expo-crateforge-android-auto`）が行い、
  CI が環境変数で値を渡す。
- 署名鍵と署名情報は GitHub Secrets のみ。**リポジトリ・APK・ビルドログに入れない。**
- fork の PR には Secrets が渡らない（`pull_request` イベント + `signed: false` 固定）。PR の APK は debug 署名で、配布物ではない。

### ワークフロー

| ファイル | いつ | 内容 |
|---|---|---|
| `.github/workflows/mobile.yml` | PR / main push（`clients/**` 等に変更があるとき） | core / mobile / TV の型チェックとテスト、config plugin・スクリプトの node テスト、iOS / TV の prebuild 回帰、`android-apk.yml` を未署名で実行 |
| `.github/workflows/android-apk.yml` | 再利用（`workflow_call`） | pnpm install → `prebuild --clean` ×2（再現性）→ `package.json` 復元 → Kotlin 単体テスト → `assembleRelease` → `verify-apk.sh` → artifact |
| `.github/workflows/release.yml` | tag `v*` / 手動 | 既存の desktop ジョブ → `release`（desktop Release）。並行して `build-android`（署名付き APK）→ 両方成功後に `release-android` が APK と SHA-256 を同じ Release に添付 |

- desktop の `release` ジョブは Android に依存せず、`crateforge-*` の artifact だけを取得します。APK のビルドが失敗しても desktop Release は従来どおり公開されます。
- `release-android` は、APK 添付の途中で失敗・キャンセルされた場合に **APK と `.sha256` を両方削除**し（Release 本文の Android 節も外す）、「APK 同梱」と誤認される半端な状態を残しません。
  失敗したらワークフロー実行画面の **Re-run failed jobs** で再実行します（成功済みの desktop ジョブは再実行されません）。
- 手動実行（`workflow_dispatch`）は署名付き APK を artifact（`android-apk`）として生成するだけで、Release は触りません。

### Secrets と変数（GitHub: Settings → Secrets and variables → Actions）

| 種類 | 名前 | 内容 |
|---|---|---|
| Secret | `CRATEFORGE_ANDROID_KEYSTORE_BASE64` | リリース keystore（`.jks` / PKCS12）を base64 化した 1 行の文字列 |
| Secret | `CRATEFORGE_ANDROID_KEYSTORE_PASSWORD` | keystore のパスワード |
| Secret | `CRATEFORGE_ANDROID_KEY_ALIAS` | 署名鍵の alias |
| Secret | `CRATEFORGE_ANDROID_KEY_PASSWORD` | 署名鍵のパスワード |
| Variable | `CRATEFORGE_ANDROID_CERT_SHA256` | 期待する署名証明書の SHA-256（`:` 有無・大小文字は不問）。**設定されていると CI が一致を強制**する。未設定のときは警告のみで続行 |

CI は keystore を `$RUNNER_TEMP/release.jks` に復元して、alias とパスワードを `keytool` で**ビルド前に**検査し、終了時に削除します。
Gradle には `CRATEFORGE_SIGNING_STORE_FILE / STORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD` と `CRATEFORGE_SIGNING_REQUIRED=true`、
`CRATEFORGE_VERSION_NAME / CODE` が環境変数で渡ります（署名情報が欠けていれば debug 署名にフォールバックせずビルドが失敗します）。

### 既存の EAS keystore を 1 度だけエクスポートして登録する

既に EAS 管理の鍵で配布した APK がある場合、**同じ鍵**で署名することで上書きアップデートが成立します。

```bash
cd clients/apps/mobile
pnpm exec eas login
pnpm exec eas credentials -p android
#   → ビルドプロファイル（配布に使っていた preview / production）を選ぶ
#   → Keystore の管理 → 既存の keystore をダウンロード（メニュー名は eas-cli のバージョンで変わる）
#   → <名前>.jks が保存され、keystore password / key alias / key password が表示される
```

1. **どの鍵か確認する:** 既に端末に入っている APK の署名証明書と、エクスポートした鍵の証明書が一致することを確認する。

   ```bash
   keytool -list -v -keystore <名前>.jks -alias <alias>      # "SHA256:" 行 = 署名証明書の SHA-256
   apksigner verify --print-certs <以前の APK>               # 同じ値になること
   ```
2. **登録する**（値をシェルの履歴やログに残さない）:

   ```bash
   base64 -w0 <名前>.jks | gh secret set CRATEFORGE_ANDROID_KEYSTORE_BASE64      # macOS: base64 -i <名前>.jks | tr -d '\n' | gh secret set …
   gh secret set CRATEFORGE_ANDROID_KEYSTORE_PASSWORD        # プロンプトに貼り付け
   gh secret set CRATEFORGE_ANDROID_KEY_ALIAS
   gh secret set CRATEFORGE_ANDROID_KEY_PASSWORD
   gh variable set CRATEFORGE_ANDROID_CERT_SHA256 --body "<上の SHA256 値>"
   ```
3. **バックアップする:** keystore ファイルとパスワード・alias を、パスワードマネージャ等の**リポジトリ外**に 2 か所以上保管する。その後ローカルのダウンロードコピーは削除する（`*.jks` は `.gitignore` 済みだが、**リポジトリの作業ツリーに置かない・コミットしない**）。
4. 初めての署名付きビルドは tag を切る前に `workflow_dispatch` で実行し、artifact を確認すると安全。

### 鍵のバックアップとローテーションの影響

- **署名鍵を失う／変える と、既存インストールへ上書きできなくなります。** Android は署名の異なる同名パッケージの上書きを拒否するため、
  利用者はアンインストール（ダウンロード済み曲・設定が消える）が必要になります。鍵は必ずバックアップしてください。
- 鍵を変えざるを得ない場合は、`CRATEFORGE_ANDROID_CERT_SHA256` の更新、Release ノートでの告知に加え、
  APK Signature Scheme v3 のローテーション（`apksigner rotate` による証明書リネージ）で旧鍵とのつながりを持たせる方法があります（本リポジトリには未実装）。
- 鍵漏えいの疑いがあるときは、Secrets を直ちに無効化・再発行し、Release ノートで署名証明書 SHA-256 の変更を告知します。

### バージョン（versionName / versionCode）

- `versionName` = ルート `package.json` の `version`（desktop と同じ。tag `vX.Y.Z[-pre.N]` と一致しなければ CI が失敗）。
- `versionCode = 100_000_000 + major*1_000_000 + minor*10_000 + patch*100 + (プレリリースなら N、正式版は 99)`
  （制約: minor・patch ≤ 99、プレリリース番号 N ≤ 98）。例: `0.15.0` → `100150099`、`0.16.0-alpha.1` → `100160001`（同じ `0.16.0` の正式版 `100160099` より小さい）。
- 1 億のオフセットは、これまで EAS が自動採番した versionCode（高々数百）より必ず大きくするため。**以後 EAS Build で作った版は GitHub 版を上書きできません。**
- 計算は `scripts/android-version.mjs`（`node --test "scripts/__tests__/*.test.mjs"` でテスト）。

### リリースの切り方

desktop のリリースと**同じ tag で APK も同時に出ます**（専用の手順は不要）。

1. [`release` スキル / リリース手順](../../../.claude/skills/release/SKILL.md) どおり、ルートの version（`package.json` / `tauri.conf.json` / `Cargo.toml`）を上げて `chore(release): vX.Y.Z` をコミットし、`git tag vX.Y.Z && git push origin vX.Y.Z`。
2. `release.yml` が desktop をビルドして Release を作成し、並行して APK をビルド・署名・検証する。両方成功すると `crateforge-android-X.Y.Z.apk` と `.apk.sha256` が同じ Release に添付され、
   本文に Android 節（SHA-256・署名証明書 SHA-256）が追記される。
3. Release の実アセットをダウンロードし、[APK の検証](#apk-の検証sha-256-と署名証明書)と実機／DHU での確認を行い、
   [検証チェックリスト](../../../docs/android-auto/verification-checklist.md)に記録する。未検証の項目はその旨を Release ノートに書く。

プレリリース（`v0.16.0-alpha.1` など）も同じ流れで出ます（GitHub の prerelease 扱い）。

### ローカルでの再現ビルド

CI と同じコマンドです（JDK 21、Android SDK 36 / build-tools 36.0.0 / NDK 27.1.12297006 / CMake 3.22.1 が必要）。

```bash
cd clients && pnpm install --frozen-lockfile                  # pnpm 10.28.0
cd apps/mobile
pnpm exec expo prebuild --platform android --clean --no-install
git checkout -- package.json                                  # prebuild が書き換える scripts を戻す（OTA の runtimeVersion を守る）
cd android
./gradlew :expo-crateforge-android-auto:testDebugUnitTest     # Kotlin 単体テスト
CRATEFORGE_VERSION_NAME=0.15.0 CRATEFORGE_VERSION_CODE=100150099 \
  ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
../scripts/verify-apk.sh app/build/outputs/apk/release/app-release.apk   # 署名なしなら debug 署名で通る
```

署名付きで作るときは `CRATEFORGE_SIGNING_STORE_FILE` / `_STORE_PASSWORD` / `_KEY_ALIAS` / `_KEY_PASSWORD`（環境変数または Gradle プロパティ `crateforge.signing.*`）を渡します。
鍵をローカルに置くのは避け、基本は CI で署名してください。

### EAS について

- **Android の配布には EAS Build を使いません。** `eas build` で作った APK は `versionCode` が GitHub 版より小さく、GitHub 版を上書きできません。
- EAS は引き続き **iOS のビルド／配布** と **OTA（EAS Update）** に使います。GitHub 配布 APK は `production` チャネル（`updates.requestHeaders` の `expo-channel-name`）の OTA を受け取ります（fingerprint が一致するときだけ適用）。
  OTA は `pnpm ota:prod`（production）／`pnpm ota:preview`（preview）。

---

## 必要環境と開発

- Node.js 22 / pnpm 10.x。`clients/` の pnpm workspace（`clients/pnpm-lock.yaml`、`node-linker=hoisted`）で依存を管理します。
  ルートの `package.json`（desktop）は pnpm 9.15.4 を固定していますが、`clients/` は pnpm 10.28.0 で lockfile を維持しているため、**`clients/` 配下では pnpm 10.28.0 を使ってください**。
- `apps/mobile/pnpm-lock.yaml` は旧構成の残骸で未使用です。

すべて `clients/` から実行できます。

```bash
cd clients
pnpm install --frozen-lockfile          # 依存インストール
pnpm -C apps/mobile start               # Expo dev server を起動
pnpm -C apps/mobile typecheck           # TypeScript 型チェック（strict）
pnpm -C apps/mobile test                # Jest（jest-expo）
node --test "apps/mobile/scripts/__tests__/*.test.mjs"    # versionCode 計算 / APK 検査スクリプトのテスト
```

Android Auto のネイティブ実装は `clients/packages/expo-crateforge-android-auto`（Kotlin / Media3）です。
Expo Go や古い dev client ではネイティブモジュールが無いため、従来どおり expo-audio で再生します。ネイティブ機能の確認には、上記の prebuild + Gradle で作った APK（または dev client の再ビルド）が必要です。

## 接続

1. デスクトップの Crateforge 設定で LAN（HTTP API）を有効化し、API トークンを発行する。
2. モバイルアプリ起動後、QR コードを読み取るか、ベース URL とトークンを手動入力する。

LAN の外から接続する場合は、Tailscale などを経由して端末から到達できる URL を手動入力してください。
アプリ自身は LAN 外向けの経路やトンネルを作成しません。

平文 HTTP（`http://...`）での LAN 接続は、app.config.ts の expo-build-properties
（`android.usesCleartextTraffic: true`）で許可済みです。

## オフライン再生

曲・プレイリスト・アルバム単位でダウンロードして、ネットワークなしで再生できます。

- **管理**: Downloads 画面でダウンロード済みを一覧・容量表示・削除できます。
- **品質**: 設定の「ダウンロード品質」で 原本 / AAC-LC 256k / 192k / 128k を選択（既定は AAC-LC 192k）。
- **ピン留め**: プレイリストをピン留めすると、再接続時に現在のメンバーとの差分を同期します。
  追加曲は記憶済みの品質で保存し、削除曲は他のピン留めプレイリストと共有されていない場合だけ端末から削除します。
- **変換**: 変換はデスクトップ側 ffmpeg が `/stream?fmt=aac&br=<kbps>` で実施し、端末は保存するだけ。
- **自動ローカル再生**: ダウンロード済みの曲は自動でローカルファイルから再生します。
  Android の車載（Android Auto）も同じダウンロード済みデータ（`downloads/index.json` / `playlists.json`）を直接読むので、アプリを開かなくても使えます。

## コーデック

既定でアプリは端末で再生可能な形式（ALAC / FLAC 等）を原本ロスレスのまま受信し、本当に鳴らせない形式のときだけ、デスクトップが AAC へ変換して配信します
（iOS / expo-audio 経路は `/stream?native=1`。Android の Media3 経路は、ExoPlayer が扱える形式だけ原本、AIFF / CAF などは AAC で受信）。

## iOS / OTA の配布（EAS）

iOS のビルド・配布と、JS のみの変更の OTA は EAS を使います。**Android の APK は上記の GitHub Releases が正式経路で、EAS Build では作りません。**
以下はユーザーが手で行う手順です。

1. `npm i -g eas-cli`（または `pnpm exec eas`）
2. `eas login`（作成済みの Expo アカウントでログイン）
3. `cd clients/apps/mobile && eas init`（Expo プロジェクトへ紐付け）
4. iOS: `eas build -p ios --profile preview`（internal distribution）
5. JS のみの変更: `pnpm ota:prod`（production チャネル）／`pnpm ota:preview`（preview）。fingerprint（runtimeVersion）が一致する端末だけに届きます。

### eas.json のプロファイル

- `preview`: internal distribution（iOS 向け。Android の `apk` 設定は残っているが配布には使わない）。
- `production`: Android は `app-bundle`（ストア提出向け。現状未使用）。
- `development`: dev client 用（internal / apk）。ローカルの開発用で、配布物ではありません。

## 既知の制約（全般）

- Android のロック画面 / 通知 / 車載の next / prev・shuffle・repeat は、ネイティブの Media3 セッションが提供します。iOS（expo-audio）は従来どおり単一プレイヤー構成で、曲送りの挙動が限定的です。
- ネイティブビルドの検証は実機または CI（`android-apk.yml`）で行う必要があります。
  ローカルで簡単に検証できるのは `pnpm -C apps/mobile typecheck`（tsc）と `pnpm -C apps/mobile test`（jest）まで。
