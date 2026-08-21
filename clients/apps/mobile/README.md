# Crateforge モバイルクライアント

Crateforge デスクトップが LAN に公開する HTTP API の、薄いモバイルクライアントです。
Expo (React Native, SDK 56) 製。曲ライブラリ／プレイリストの閲覧、端末での再生、
そしてデスクトップ側プレイヤーのリモコン操作を行います。

## 特徴

- 既存 LAN API を呼ぶだけの薄いクライアント。ライブラリ本体や解析はデスクトップが担う。
- 端末での音声再生（expo-audio）。背景再生・ロック画面 / 通知からの操作に対応。
  - iOS: `UIBackgroundModes=audio`、Android: expo-audio プラグインが foreground service /
    通知権限を付与（app.config.ts で設定済み）。
- デスクトップ側プレイヤーのリモコン（再生／一時停止／シーク／キュー操作）。
- 接続は QR スキャン（expo-camera）または手動入力。トークン認証つき。
- 曲／プレイリスト／アルバム単位のオフライン再生（Downloads 画面で管理）。
- ライブラリは「曲」「アルバム」表示を切替可能。アルバム→詳細で全曲再生・アルバム DL。
- プレイリストはフォルダ階層を保持して表示（フォルダをタップで中へ）。
- 大規模ライブラリ対応: 一覧の 500/200 上限を撤廃し、`BROWSE_LIMIT` で全件取得 + 仮想リスト描画。
- 簡易 DJ モード: 2 デッキ + クロスフェーダー。USB (OTG) の MIDI コントローラや
  DJM 系ミキサーを MIDI ラーンで割り当てて操作できる（Android）。

## 必要環境

- Node.js / pnpm
- 依存は `mobile/` 配下で隔離 install します（`.npmrc` の `node-linker=hoisted`）。
  ルートの workspace とは独立してインストールされる点に注意。

## 開発

すべてリポジトリルートから実行できます。

```bash
pnpm -C mobile install     # 依存インストール（mobile/ 隔離・hoisted）
pnpm -C mobile start       # Expo dev server を起動
pnpm -C mobile typecheck   # TypeScript 型チェック（strict）
pnpm -C mobile test        # Jest（jest-expo）
```

`mobile/` に `cd` してから `pnpm install` / `pnpm start` などを直接叩いても構いません。

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
- **自動ローカル再生**: ダウンロード済みの曲は自動でローカルファイルから再生します（`ExpoAudioEngine` が優先）。

## コーデック

既定でアプリは `/stream?native=1` を使い、端末で再生可能な形式（ALAC / FLAC / AIFF 等）は
原本ロスレスのまま受信します。本当に鳴らせない形式のときだけ、デスクトップが AAC へ変換して配信します。

## DJ モード

DJ タブ →「DJ モードを開始」で、2 デッキ + クロスフェーダーの簡易 DJ 画面（`/dj`）を開きます。

- **デッキ**: 各デッキに LOAD で曲を読み込み（オンラインは検索、オフラインは DL 済みから）。
  CUE（停止中=キュー設定 / 再生中=キューへ戻って停止）、PLAY、SYNC（相手デッキの実効 BPM に
  合わせる。要 BPM 解析済み）、ナッジ（ホールドで ±2% ピッチベンド）、テンポフェーダー
  （±4/8/16% 切替。レート変更はピッチ保持）、チャンネルフェーダー。
- **ミキサー**: クロスフェーダーは等パワー則。出力は端末の 1 系統ステレオにミックスされます
  （デッキ別ヘッドホンキューは未対応）。
- **MIDI（Android）**: `expo-crateforge-midi`（`android.media.midi`）が USB (OTG) 接続の
  MIDI デバイスを自動オープンし、CC / Note を受信します。機種プリセットは持たず、
  DJ 画面の MIDI パネルで **MIDI ラーン**（ラーン → 操作子を動かす）して割り当てます。
  DJM-900 系ミキサーもフェーダー / ボタンが CC を送るのでラーンで割り当て可能です。
  割り当ては SecureStore に永続化されます。iOS / Expo Go では MIDI は無効
  （タッチ操作のみ）に自動フォールバックします。
- **注意**: ネイティブモジュール追加のため、既存の dev build / APK には OTA では配信されません
  （runtimeVersion の fingerprint が変わる）。`eas build` での再ビルドが必要です。

### 音声出力とヘッドホンキュー（制約と今後）

現状の出力は Android 標準のオーディオ経路 1 系統（ステレオ）のみで、**デッキ別の
ヘッドホンキュー（プリリスニング）はできません**。これは expo-audio 固有の制約ではなく
Android のオーディオスタックの制約で、USB 接続したオーディオインターフェース
（DJM シリーズ等）もフレームワークからは 1 ステレオ出力としてしか見えません。

キューを本当に成立させるにはデッキ再生を expo-audio から自前のネイティブエンジン
（デコード → テンポ変換 → ミックス → 出力）へ移す必要があります。`DjEngine` 抽象
（`src/features/dj/store.ts`）はこの差し替えを前提に切ってあります。検討中の段階案:

1. **split-mono**: デッキ A→L / B→R にハードパンした 1 ステレオを出力し、分岐ケーブルで
   DJM の 2ch（モノ）へ入れる。ミキサーの実フェーダーと DJM 側ヘッドホンキューが
   機能する（音はモノになる）。ネイティブエンジン化の最小到達点。
2. **USB マルチチャンネル（真の 4ch: A→USB1/2, B→USB3/4）**: Android フレームワークでは
   不可能なため、USB ホスト API + libusb によるユーザースペース UAC2 ドライバが必要
   （isochronous 転送。USB Audio Player PRO 等に前例あり）。エンジンごとネイティブ化する大工事。
3. **デスクトップ 4ch + モバイルはコントローラ**: DJM を本来の 4ch サウンドカードとして
   使えるのは公式ドライバのあるデスクトップ側。デスクトップに DJ エンジンを実装し
   （rodio/cpal はマルチチャンネル出力可）、モバイルは既存 LAN API 経由のリモート UI に徹する案。

## 配布（EAS internal distribution）

社内配布相当（Bitrise 風の QR インストール）として、EAS の internal distribution を使います。
以下はユーザーが手で行う手順です。

1. `npm i -g eas-cli`
2. `eas login`（作成済みの Expo アカウントでログイン）
3. `cd mobile && eas init`（Expo プロジェクトへ紐付け）
4. `eas build -p android --profile preview`
   - 初回は keystore の自動生成を聞かれるので **Yes** で進める。
5. ビルド完了後に出る URL / QR を端末で開き、APK をインストールする。
   - 「提供元不明のアプリ」のインストール許可が必要。
6. 更新時は再ビルドして、新しく出た QR からインストールし直す。

### eas.json のプロファイル

- `preview`: internal distribution / Android は `apk`。動作確認・配布用。
- `production`: Android は `app-bundle`（ストア提出向け）。
- `development`: dev client 用（internal / apk）。

## 既知の制約

- ロック画面 / 通知の next / prev は、単一プレイヤー構成のため再生・一時停止・シーク中心。
  曲送り操作の挙動は限定的です。
- EAS のネイティブビルド検証は実機またはクラウドで行う必要があります。
  ローカルで検証できるのは `pnpm -C mobile typecheck`（tsc）と `pnpm -C mobile test`（jest）まで。
