# 選曲ワークスペースの作り方

`dj-curator` プラグインは、**あなた自身の「選曲ワークスペース repo」** で使うことを想定しています。
このワークスペースは Crateforge アプリの repo とは別に、各自で運用します（嗜好・基準・履歴の置き場）。

## セットアップ

1. 適当な場所に新しいディレクトリ（or git repo）を作る。例: `~/dj-crate/`
2. このテンプレートの `CLAUDE.md` をコピーし、**自分の選曲方針**（母集団・好み・避ける・DJ の色）に書き換える。
3. 作業用のサブフォルダを用意（任意）:
   ```
   ~/dj-crate/
     CLAUDE.md      # 選曲方針・基準・嗜好（rules）
     inputs/        # フライヤー画像・テーマメモ
     sets/          # 過去の叩き台レポート（重複回避・振り返り）
   ```
4. Crateforge アプリを起動し、設定 → 「AI 連携 / API」で **API サーバーを有効化**（既定ポート 8787）。

## 使い方

`~/dj-crate/` で Claude Code を開き:

```
/dj-curator:build-set inputs/summer-party-flyer.png
```

または:

```
/dj-curator:build-set 夏の夕暮れの chill house、90分、ゆるめスタート
```

Claude がコンセプトをヒアリングし、ライブラリから候補を選んで **新規プレイリストを Crateforge に作成**、
各曲の根拠レポートを返します。**曲順は Crateforge の GUI で詰めてください**。

## プラグインの導入

```
/plugin marketplace add tainakanchu/itunes-playlist-viewer
/plugin install dj-curator@crateforge
```
