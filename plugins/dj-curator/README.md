# dj-curator (Crateforge プラグイン)

何らかのインプット（イベントのフライヤー / テーマ・ムード / 参照曲）から、Crateforge の
ローカル API を叩いて **DJ 選曲の叩き台**（新規プレイリスト + 根拠レポート）を作る Claude Code プラグイン。

- **入力は問わない**：フライヤー画像でもテーマ文でも参照曲でも。
- **AI は候補選定に集中、曲順は人間が GUI で詰める**。
- **メタデータ主体**の選曲（レーティング / ジャンル / 年代）。BPM/Key/Energy はあれば使う。
- 選曲の**方針・基準・嗜好はユーザー自身の「選曲ワークスペース repo」の rules** に置く（このプラグインには持たせない）。

## 前提
Crateforge アプリ（v0.5+ 予定。内蔵 API サーバー対応版）を起動し、
設定 → 「AI 連携 / API」で API サーバーを有効化しておくこと（既定 `http://127.0.0.1:8787`）。

## 導入
```
/plugin marketplace add tainakanchu/itunes-playlist-viewer
/plugin install dj-curator@crateforge
```

## 使い方
選曲ワークスペース用のディレクトリで Claude Code を開く。

**初回だけ** 選曲方針をヒアリングして用意する（`CLAUDE.md` か `rules/` を生成）:
```
/dj-curator:init-workspace
```

以降は叩き台づくり:
```
/dj-curator:build-set [フライヤー画像のパス | テーマ・ムード | 参照曲]
```
（ワークスペースの構造は `skills/build-set/workspace-template/README.md` も参照）

## 構成
```
dj-curator/
  .claude-plugin/plugin.json
  skills/
    init-workspace/    # 選曲ワークスペースを対話で初期化（CLAUDE.md or rules/・sets/ を生成）
      SKILL.md
    build-set/
      SKILL.md                # スキル本体（手順・原則）
      reference.md            # Crateforge API リファレンス
      scripts/crate-api.sh    # curl ラッパ（jq 非依存）
      workspace-template/     # 選曲ワークスペースのひな形（CLAUDE.md / README.md）
  README.md
```

## 関連
- API サーバー（データ層）: 本体リポジトリの `src-tauri/src/api/`（issue #25）
- このプラグイン（オーケストレーション層）: issue #26
