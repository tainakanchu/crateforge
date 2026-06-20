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

平文 HTTP（`http://...`）での LAN 接続は、app.config.ts の expo-build-properties
（`android.usesCleartextTraffic: true`）で許可済みです。

## オフライン再生

曲・プレイリスト・アルバム単位でダウンロードして、ネットワークなしで再生できます。

- **管理**: Downloads 画面でダウンロード済みを一覧・容量表示・削除できます。
- **品質**: 設定の「ダウンロード品質」で 原本 / AAC-LC 256k / 192k / 128k を選択（既定は AAC-LC 192k）。
- **変換**: 変換はデスクトップ側 ffmpeg が `/stream?fmt=aac&br=<kbps>` で実施し、端末は保存するだけ。
- **自動ローカル再生**: ダウンロード済みの曲は自動でローカルファイルから再生します（`ExpoAudioEngine` が優先）。

## コーデック

既定でアプリは `/stream?native=1` を使い、端末で再生可能な形式（ALAC / FLAC / AIFF 等）は
原本ロスレスのまま受信します。本当に鳴らせない形式のときだけ、デスクトップが AAC へ変換して配信します。

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
