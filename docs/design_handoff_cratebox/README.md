# Handoff: Cratebox — アートワーク主導の曲管理 / DJ 選曲 UI

ローカル iTunes 風音楽管理アプリ（仕様書 `ui-spec.md` 参照）の UI 再設計。
DJ 的なメタデータ運用（BPM / Key / Rating / Tag）と**選曲のしやすさ**、そして
**アートワークでの曲識別**（とくに曲名が覚えにくい中華圏トラック）を主眼に置いた方向「**Cratebox**」。

---

## このバンドルのファイルについて

`prototype/` 内の `.html` / `.jsx` は **HTML で作られたデザインリファレンス**です。
意図した見た目と挙動を示すプロトタイプであり、そのまま本番投入するコードではありません。

タスクは、これらの HTML デザインを **対象コードベースの既存環境**（このアプリは
クロスプラットフォームのデスクトップアプリ想定 — Electron + React / Tauri / SwiftUI 等）の
確立されたパターン・ライブラリで**作り直す**ことです。環境がまだ無い場合は、
プロジェクトに最も適したフレームワークを選んで実装してください。

プロトタイプは React 18 + Babel standalone を CDN から読み、`design_canvas.jsx`
（パン/ズーム比較キャンバス）の上に各画面を並べているだけです。**design_canvas はビューア**であり、
実装対象ではありません。実装すべきは中の各画面（下記）です。

## 忠実度: ハイファイ (hifi)

最終的な配色・タイポ・余白・インタラクションを含むピクセル単位のモックです。
コードベースの既存ライブラリ・パターンで**ピクセル忠実に**再現してください。

---

## 画面 / ビュー

### 1. List ビュー（メイン・情報密度重視）
- **目的**: 大量ライブラリ（仕様上 36,460 曲）の閲覧・検索・選曲。1曲1行で密度高く。
- **レイアウト**: 縦積み。上から ①ツールバー ②（任意で）フィルタチップ行 ③列ヘッダー ④仮想スクロールの行リスト。
  メインは3カラムの全体シェル（左サイドバー / 中央リスト / 右レール）の中央。
- **行の構造**（左→右、フレックス）:
  - **アートワーク**: 既定で「豆」サイズ **20px**。`なし / 豆(20px) / 小(28px)` で切替。角丸 8px。
    実ジャケが無い場合のプレースホルダは「アルバム名から生成した 2 色グラデ＋曲名先頭1文字」（CJK 可）。
  - **Track（identity, 常時表示・flex:1）**: 曲名（15px / 600、`#F2F4F5`、1行省略）。行高 50px 以上のときのみ
    アーティスト行（12px、`#9DA2A8`）を2行目に表示。
  - **設定可能フィールド群**（ColumnPicker で選択・並べ替え、各固定幅）。下記「ColumnPicker」参照。
  - **＋ボタン**（右端・行ホバーで出現）: Staging Crate に追加。32px 角丸8px、`rgba(39,210,188,.13)` 地に teal アイコン。
- **行高**: スライダーで **32〜64px**（既定 40px）。
- **再生中の行**: 地 `rgba(39,210,188,.09)` ＋ 左端 inset シャドウ 3px teal。
- **クレート投入済みの行**: 地 `rgba(39,210,188,.045)`、＋ボタンの代わりにチェックアイコン。
- 参照ファイル: `dirB3.jsx`（インタラクティブな ColumnPicker 版）, `dirB2.jsx`（List モードのフルシェル）。

### 2. Covers ビュー（ブラウズ・アート前面）
- **目的**: ジャケットを大きく一覧してブラウズ。曲名が覚えにくいトラックを絵で探す。
- **レイアウト**: 5 列グリッド、gap 18px、`padding:18px 20px`。
- **カード**: 正方形（`aspect-ratio:1`）角丸 13px、`box-shadow:0 8px 24px rgba(0,0,0,.42)`。
  - 中央に大きな曲名先頭文字（62px / 800、半透明白）。
  - 下端に向かう黒グラデ（`linear-gradient(to top, rgba(0,0,0,.78), transparent 52%)`）。
  - 左上に Key / BPM タグ（`rgba(0,0,0,.5)` + `backdrop-filter:blur(6px)`、mono 11px）。
  - 右上に＋ボタン（ホバーで出現、44? → 実寸 34px 円、teal 地）。
  - 下部オーバーレイ: 曲名（14.5px / 680 白）＋ アーティスト（11.5px、`#BFEFE8`）。
  - ホバー: カードに `outline:2px solid teal; outline-offset:2px`。投入済みは常時 outline。
- 参照: `dirB2.jsx`（`mode="covers"`）。

### 3. 左サイドバー（共通）
- 幅 **202px**、背景 `#0A0D0F`、右境界 `1px solid #22272B`。
- ブランド（teal 角丸ロゴ + "Cratebox"）→ "Library" 見出し → ナビ（All Tracks / Albums / Artists / Recently Played）
  → "Playlists" 見出し（＋ボタン）→ プレイリスト/フォルダのツリー（インデントは depth×14px、件数右寄せ mono）。
- アクティブナビ: 地 `rgba(39,210,188,.14)`、文字 `#EAFBF8`、アイコン teal、右側だけ角丸 9px。

### 4. 右レール（Now Playing / Up Next / Crate） ★選曲の要
- 幅 **348px**、背景 `#0A0D0F`、左境界 1px。
- **Now Playing（上部）**: 正方形大ジャケ（角丸 14px、`box-shadow:0 14px 40px rgba(0,0,0,.5)`）。
  左下に Key・BPM／Rating のガラスピル。下に曲名（18px / 700）＋ アーティスト—アルバム（12.5px muted）。
- **タブ**: `Now Playing / Up Next / Crate`（セグメント、選択中は `#1E2429` 地）。
- **Staging Crate**: ヘッダーに「件数・合計尺」（teal 数値）。各ノード = ドラッグハンドル＋豆ジャケ（42px）＋
  曲名／`Key · BPM · アーティスト`／×削除。
- **フッター**: 「Save as Playlist」(teal 塗り) ＋ クレート再生ゴーストボタン。
- 参照: `dirB2.jsx`。

### 5. プレイヤーバー（フッター・全幅）
- 高さ 78px、背景 `#0A0D0F`、上境界 1px。3カラム（左:曲情報 / 中央:操作 / 右:キュー・音量）。
- 左: 48px ジャケ + 曲名(14px/680) + `アーティスト · Key · BPM`。
- 中央: シャッフル / 前 / **再生（40px teal 円）** / 次 / リピート（トグル ON = teal）＋ 波形シークバー（経過部 teal）。
- 右: キュー / 音量アイコン + ボリュームバー。

### ColumnPicker（List の列カスタマイズ）★ユーザー要望の中心機能
- ツールバーの **「Columns」** ボタン（バッジに選択数）で右上にポップオーバー（幅 288px、角丸 14px）。
- **フィールド定義**（id / ラベル / 固定幅 px / 描画）:
  | id | ラベル | 幅 | 表示内容 |
  |---|---|---|---|
  | `key` | Key | 58 | Camelot キー（mono 650、teal） |
  | `bpm` | BPM | 58 | BPM（mono 650、値で色変化＝下記 BPM カラー） |
  | `album` | Album | 168 | アルバム名（1行省略） |
  | `genre` | Genre | 104 | ジャンルタグ（`#1E2429` 地のピル） |
  | `rating` | Rating | 86 | ★5（塗り teal、空 `rgba(255,255,255,.16)`） |
  | `year` | Year | 56 | 年（mono、`#9DA2A8`） |
  | `plays` | Plays | 52 | 再生回数（mono dim） |
  | `time` | Time | 56 | 再生時間（mono dim） |
  | `energy` | Energy | 64 | 5本バー（点灯数=energy、色=BPM カラー） |
- 既定の表示列: `[key, bpm, album, genre, rating]`。
- 挙動: ①選択中フィールドは**ドラッグで並べ替え**（HTML5 drag、`dragover` で配列を入替）。
  ②タップで表示/非表示トグル。③「Available」見出し下に未選択フィールド。
  ④フッターに **Row height スライダー(32–64px)** と **Artwork セグメント(なし/豆/小)**、Reset。
  ⑤列ヘッダーと全行は選択状態に**即時反映**。⑥外側クリック（スクリム）で閉じる。
- 参照: `dirB3.jsx`（`FIELD_DEFS` / `ALL_FIELDS` / `CrateboxLive`）。

### 関連モーダル（既存仕様、別方向の暫定スタイル）
仕様書には Rip CD（CD リッピング進捗）, Playlist Rules（YAML 2ペイン）, Track Info（メタ編集）,
ColumnPicker, Albums/Artists ビューがあります。Rip / Rules / Track Info / Albums / Now Playing パネルの
ビジュアル探索は別ファイル（`secondaryModals.jsx` / `secondaryViews.jsx`、本バンドルには未同梱）に
**violet トークン**で存在しますが、**Cratebox の teal トークンに再スキンが必要**です。必要なら追加で出力します。

---

## インタラクション & 挙動
- **List ⇄ Covers**: ツールバーのセグメントで切替。
- **選曲フロー**: 行/カードの＋ → Staging Crate に追加（投入済みはチェック表示）。クレート内はドラッグ並べ替え・×削除。
  「Save as Playlist」でプレイリスト化。仕様の「現在のプレイリスト」概念と接続。
- **ColumnPicker**: 上記。状態は即時反映。**列構成・行高・カバーサイズはユーザー設定として永続化すべき**
  （localStorage 相当 / アプリ設定）。プロトタイプは未永続。
- **検索**: 曲名・アーティスト・アルバムに対する**インクリメンタル検索**（ピンイン併記は不要との要望で除外）。
- **フィルタチップ**: Key（ハーモニック）, BPM レンジ, Rating, Genre 等。
- **再生中**: 行ハイライト＋プレイヤー同期。波形シークは経過部 teal。
- ホバー状態: 行 `#13171A`、＋ボタンの出現、カードの teal アウトライン。

## 状態管理（List 周辺の最小セット）
- `fields: string[]` — 表示列の id 配列（順序＝表示順）。
- `rowH: number` — 行高 px（32–64）。
- `coverSize: 0 | 20 | 28` — アートワーク（なし/豆/小）。
- `viewMode: 'list' | 'covers'`。
- `crate: Track[]` — Staging Crate の中身（順序保持）。
- `nowPlaying`, `queue: Track[]`（Up Next）。
- `selection`, `sort`（キー＋昇降）, `filters`（key/bpm/rating/genre…）, `search`。
- 永続化対象: `fields`, `rowH`, `coverSize`, `viewMode`, ソート/フィルタ、列プリセット。

## デザイントークン

### 色
| 用途 | 値 |
|---|---|
| ベース背景 | `#0E1113` |
| サイドバー/レール背景 | `#0A0D0F` |
| パネル/カード bg3 | `#1E2429` |
| 入力/sub bg2 | `#161A1D` |
| ボーダー | `#22272B`（濃いめ `#2C3338`） |
| アクセント teal | `#27D2BC` |
| アクセント濃 | `#0E6B62` |
| アクセント上の文字 | `#06211E` |
| テキスト primary | `#E4E7EA` / 強 `#F2F4F5` |
| テキスト secondary | `#9DA2A8` / `#A7ADB3` |
| ミュート | `#737A80` |
| 半透明 teal（行/チップ地） | `rgba(39,210,188,.09 / .045 / .13 / .16)` |

### BPM カラー（`bpmColor(bpm)`、値帯で色分け＝DJ のエネルギー感）
`<90 → #5BA8E0` / `<115 → #46C28A` / `<135 → #E0C24A` / `<160 → #E08A3C` / `それ以上 → #E0573C`

### タイポグラフィ
- 基本: `-apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", "Noto Sans CJK SC", sans-serif`
- 数値/メタ: `ui-monospace, "SF Mono", Menlo, monospace`（Key/BPM/時間/年）
- 代表サイズ: 曲名 14.5–15 / 600–650、アーティスト 12、メタ 11–12.5、見出しラベル 10–10.5（大文字・letter-spacing 0.6–1.4px）。

### 角丸・余白・影
- 角丸: カード 13–14、ジャケ 8–10、ボタン 9–11、ピル/チップ 14（小タグ 5–6）。
- 影: カード `0 8px 24px rgba(0,0,0,.42)`、Now ジャケ `0 14px 40px rgba(0,0,0,.5)`、ポップオーバー `0 24px 60px rgba(0,0,0,.6)`。
- 行パディング横 18–20px。サイドバー 202px / 右レール 348px。

## アセット
- **アイコン**: ライン系（Lucide 互換）のインライン SVG セット（`icons.jsx` の `ICON_PATHS`）。実装側の
  アイコンライブラリ（Lucide 等）に差し替え可。`Stars` は★レーティング描画ヘルパー。
- **アートワーク**: 実装では実ジャケ（仕様の Cover Art Archive / 埋め込みアート想定）を使用。
  プレースホルダは `data.jsx` の `artGradient(seed)`（アルバム名→2色グラデ）＋曲名先頭文字。
- 絵文字アイコンは**不使用**（現状 UI の絵文字を全廃する方針）。

## ファイル一覧（`prototype/`）
- `Cratebox アートワーク主導.html` — エントリ。design_canvas 上に List / Covers / ColumnPicker を配置。
- `dirB2.jsx` — `CrateboxArt`：List + Covers のフルシェル（サイドバー/レール/プレイヤー込み）。
- `dirB3.jsx` — `CrateboxLive`：動く ColumnPicker 付き List（`FIELD_DEFS`, `ALL_FIELDS`）。
- `icons.jsx` — `Icon` / `Stars` / `ICON_PATHS`。
- `data.jsx` — モックデータ（`CTRACKS` 中華圏トラック, `TRACKS`, `PLAYLISTS`, `ALBUMS`）＋ `artGradient` / `bpmColor`。
- `design-canvas.jsx` — 比較用ビューア（実装不要）。

### ローカルで開く
`prototype/Cratebox アートワーク主導.html` をブラウザで開くだけで動きます（React/Babel は CDN 読み込み・要ネット接続）。
オフラインが必要なら単一 HTML へのバンドル版を別途出力できます。
