# Crateforge

爆速 iTunes 風音楽管理デスクトップアプリ。Tauri 2 + React 19 + Vite 6 + Rust 製。
DJ 向けの解析（BPM / Key(Camelot) / Energy）・類似度選曲・フォーマット変換・スマートプレイリストまで備えます。

`iTunes Library.xml` のインポート/エクスポート、CD リッピング (MusicBrainz 連携)、ローカルファイル取り込み、プレイリスト編集、ローカル再生まで **このアプリ単体で完結** します。

## 特徴

- 🚀 **爆速**: SQLite (WAL) + 索引で 10,000+ トラックでも快適。React 側は `@tanstack/react-virtual` で行を仮想化。
- 📥📤 **iTunes Library.xml 互換**: 入出力とも Apple plist 形式 — rekordbox / Serato / Traktor などが読み取れる出力。
- 💿 **CD リッピング**: cdparanoia + flac/lame/ffmpeg。**MusicBrainz** で曲情報を自動取得、**Cover Art Archive** でジャケットも。
- 🎵 **ファイル取り込み**: FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF などのタグを `lofty` で読み取り。
- 📋 **プレイリスト編集**: 作成・名前変更・削除・フォルダ階層・複数選択追加・並び替え。
- ▶ **ローカル再生**: `rodio` (symphonia) で各種フォーマットを直接デコード。
- 📦 **Nix 完結**: `flake.nix` で Rust/Node/GTK/WebKit/CD ツール/エンコーダ全部を宣言。
- 🤖 **AI 選曲**: ローカル HTTP API を内蔵し、Claude Code プラグイン `dj-curator` から「インプット → コンセプト → DJ 選曲の叩き台」を生成（下記）。

## クイックスタート

### 前提

- [Nix](https://nixos.org/) (flakes 有効) — toolchain と全ライブラリは Nix が用意します
- それ以外は不要 (Node.js / Rust / GTK / WebKit / dbus / ALSA / cdparanoia / flac / lame / ffmpeg / libdiscid / libclang を flake から提供)

### 起動

```bash
nix develop                # dev shell に入る
pnpm install               # 初回のみ
pnpm tauri dev             # デスクトップアプリを起動
```

### リリースビルド

```bash
nix develop
pnpm tauri build           # OS ネイティブパッケージを生成
```

### Windows ビルド (.exe / .msi / .nsis)

Tauri は **OS 上で直接ビルドする方式が前提** です (Windows ビルドは Windows、macOS ビルドは macOS で)。
このリポジトリには `.github/workflows/build-windows.yml` が入っているので、GitHub にリポジトリを push すると Windows runner で自動ビルドされます。

```bash
# 初回
git remote add origin git@github.com:<you>/itunes-playlist-viewer.git
git push -u origin main
# ↑ push すると Actions が走り、artifacts に下記が上がります:
#   - crateforge-windows-exe         (単体 .exe)
#   - crateforge-windows-installers  (.msi + setup .exe)

# リリースを作りたいとき
git tag v0.1.0 && git push --tags
# ↑ tag を push すると GitHub Release も自動作成 (artifacts 同梱)
```

ローカル Windows で直接ビルドしたい場合:

```powershell
# 必要: Node 20+, pnpm, Rust stable, MSVC Build Tools, WebView2 (Win11 は標準)
winget install --id=Microsoft.WebView2Runtime  # 念のため
winget install --id=Microsoft.VisualStudio.2022.BuildTools
# Rust + Node はそれぞれ rustup / nvm-windows などで

pnpm install
pnpm tauri build
# 成果物:
#   src-tauri\target\release\crateforge.exe
#   src-tauri\target\release\bundle\msi\*.msi
#   src-tauri\target\release\bundle\nsis\*-setup.exe
```

**注意**: Windows ビルドでは `discid` クレートを外しているため、**CD リッピング機能 (TOC 自動取得) は無効**になります (`compute_disc_id` で TOC を手動入力すれば MusicBrainz 検索はできます)。物理 CD リッピングを使うには Linux / macOS でビルドした版を使ってください。

### Nix を使わない場合

参考までに必要なシステム依存:

- 共通: Node.js 20+, Rust stable, pkg-config, libclang (bindgen 用)
- Linux: `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libdbus-1-dev`, `libasound2-dev`, `librsvg2-dev`, `libdiscid-dev`, `cdparanoia`, `flac`, `lame`, `ffmpeg`
- macOS: 不要 (Xcode CLT + `brew install libdiscid cdparanoia flac lame ffmpeg`)
- Windows: WebView2 + cdparanoia/flac/lame/ffmpeg を別途 PATH に

## 使い方

### ライブラリ操作

| 操作 | 方法 |
|---|---|
| iTunes XML を取り込む | ツールバー「📥 Import XML」 |
| 既存の音楽ファイルを取り込む | ツールバー「🎵 Add Files」(複数選択可) |
| CD から取り込む | ツールバー「💿 Rip CD」(下記参照) |
| iTunes XML を書き出す | ツールバー「📤 Export XML」 |

### 検索 / 再生

- `/` で検索フォーカス、タイトル/アーティスト/アルバム/ジャンル/コメントを部分一致
- トラックダブルクリックで再生、`Space` で再生/一時停止
- `Ctrl/Cmd+クリック`、`Shift+クリック` で複数選択

### プレイリスト

- サイドバー右の `＋` / `📁＋` で新規作成
- ダブルクリックで名前変更、右クリックで削除
- トラックを右クリック → 「Add to playlist」(複数選択時はまとめて追加)
- プレイリスト表示中は右クリックメニューから「Remove from this playlist」も可

### CD リッピング (💿 Rip CD)

1. **Drive** を入力して「🔍 Detect Disc」
   - Linux: `/dev/cdrom` / `/dev/sr0`、macOS: `disk1`、Windows: `D:`
2. TOC が読まれ、自動的に MusicBrainz を引いて候補アルバムを表示
3. 必要に応じてリリースを選び直し、トラックを選択
4. **Format** を選択 (FLAC / ALAC / MP3 / WAV)
5. **Output** フォルダを指定して「▶ Start Ripping」
6. 進捗が下部にライブ表示。完了後は自動的にライブラリに追加 (`Add ripped tracks to library` ON 時)

#### WSL2 で物理 CD を使うには

WSL2 はデフォルトでは USB CD ドライブを認識しません。Windows 側で:

```powershell
# Install usbipd-win
winget install --interactive --exact dorssel.usbipd-win

# List devices and attach to WSL2
usbipd list
usbipd bind --busid <id>
usbipd attach --wsl --busid <id>
```

WSL2 側で `/dev/sr0` などが見えれば OK。

## プラグイン (AI 選曲 / Claude Code)

Crateforge は **ローカル HTTP API サーバー** を内蔵しており、Claude Code プラグイン **`dj-curator`** から
「何らかのインプット（イベントのフライヤー / テーマ・ムード / 参照曲）→ コンセプトのヒアリング → DJ 選曲の叩き台」
を生成できます。AI は **候補プールの選定に集中**し、**曲順は GUI で人間が詰める** 方針です。
選曲は **メタデータ主体**（レーティング / ジャンル / 年代）で、BPM/Key/Energy はあれば使うボーナス扱い。

### 1. API サーバーを有効化

アプリの **設定 → 「AI 連携 / API」** で API サーバーを有効化します（既定 `127.0.0.1:8787`、デフォルトは OFF）。
ループバックのみで待受するローカル API です。

### 2. プラグインを導入

このリポジトリ自体が plugin marketplace になっています。Claude Code で:

```
/plugin marketplace add tainakanchu/itunes-playlist-viewer
/plugin install dj-curator@crateforge
```

### 3. 選曲ワークスペースで使う

選曲の方針・嗜好（レーティング基準・好み・避ける曲・DJ の色など）は、各自で運用する
「選曲ワークスペース repo」の `CLAUDE.md` / `rules/` に置きます
（ひな形: `plugins/dj-curator/skills/build-set/workspace-template/`）。
そのディレクトリで Claude Code を開き:

```
/dj-curator:build-set inputs/flyer.png
/dj-curator:build-set 夏の夕暮れの chill house、90分、ゆるめスタート
```

コンセプトをヒアリングした上で、ライブラリから候補を選んで **新規プレイリストを作成**し、
各曲の選定根拠レポート（Markdown）を返します。曲順はアプリの GUI で詰めてください。

詳細は [`plugins/dj-curator/README.md`](plugins/dj-curator/README.md) を参照。

## 構成

```
crateforge/
├── flake.nix                          # Nix dev shell (toolchain + libs + encoders)
├── package.json                       # Node deps & scripts
├── vite.config.ts
├── index.html
├── tsconfig.json
│
├── src/                               # === React frontend ===
│   ├── main.tsx / App.tsx / styles.css / env.d.ts
│   ├── types/                         # 機能別 TS 型定義
│   │   ├── index.ts (re-export)
│   │   ├── track.ts / playlist.ts / playback.ts
│   │   ├── library.ts / ripper.ts
│   ├── api/                           # Tauri command 薄ラッパ
│   │   ├── library.ts                 #   import/export/files/search/stats
│   │   ├── playlists.ts               #   CRUD + tracks
│   │   ├── playback.ts                #   play/pause/seek/recent
│   │   └── ripper.ts                  #   detect/lookup/rip + progress event
│   ├── store/useStore.ts              # zustand store
│   └── components/
│       ├── Toolbar.tsx                #   Import/Add/Rip/Export
│       ├── Sidebar.tsx                #   Library + Playlist tree (CRUD)
│       ├── SearchBar.tsx              #   debounced search
│       ├── TrackTable.tsx             #   virtualized + context menu
│       ├── PlayerBar.tsx              #   transport controls
│       └── ripper/RipDialog.tsx       #   TOC → MB → encode → progress
│
└── src-tauri/                         # === Rust backend ===
    ├── Cargo.toml / build.rs / tauri.conf.json
    ├── capabilities/default.json
    ├── icons/
    └── src/
        ├── main.rs / lib.rs           # entry + module wiring
        ├── models.rs                  # 全共有型 (Track/Playlist/DiscToc/...)
        │
        ├── db/                        # SQLite (WAL)
        │   ├── mod.rs                 #   Database::open
        │   ├── schema.rs              #   CREATE TABLE
        │   ├── tracks.rs              #   trackテーブル CRUD + import
        │   ├── playlists.rs           #   playlist + playlist_tracks CRUD
        │   └── stats.rs               #   library stats + app_state
        │
        ├── itunes_xml/                # iTunes Library.xml ⇄ DB
        │   ├── parser.rs              #   streaming SAX parser
        │   └── writer.rs              #   plist XML serializer
        │
        ├── audio/                     # rodio + position tracking
        │   └── mod.rs
        │
        ├── importer/                  # 音声ファイル → DB (lofty)
        │   └── mod.rs
        │
        ├── metadata/                  # MusicBrainz + Cover Art Archive
        │   ├── mod.rs
        │   ├── disc_id.rs             #   MB disc-id 自前計算 (テスト付き)
        │   ├── musicbrainz.rs         #   /ws/2/discid REST
        │   └── cover_art.rs           #   coverartarchive.org
        │
        ├── cd_ripper/                 # CD → ファイル + DB
        │   ├── mod.rs
        │   ├── toc.rs                 #   libdiscid 経由で TOC + MB id
        │   ├── encoder.rs             #   flac/lame/ffmpeg/wav ディスパッチ
        │   └── ripper.rs              #   cdparanoia → encode → DB → event
        │
        └── commands/                  # tauri::command 群 (機能別)
            ├── mod.rs
            ├── library.rs             #   import/export/files/tracks/stats
            ├── playlists.rs           #   CRUD
            ├── playback.rs            #   play/pause/seek/recent
            └── ripping.rs             #   detect/lookup/compute/rip
```

## アーキテクチャ

```
┌──────────────────────┐  invoke / event   ┌──────────────────────────┐
│  React (Vite, 1420)  │ ────────────────▶ │  Rust (tauri)            │
│  - zustand store     │                   │  ├ db (SQLite + WAL)     │
│  - virtualized list  │                   │  ├ itunes_xml (R/W)      │
│  - RipDialog UI      │                   │  ├ audio (rodio)         │
└──────────────────────┘                   │  ├ importer (lofty)      │
                                           │  ├ metadata (MusicBrainz)│
                                           │  └ cd_ripper             │
                                           │      ↓ subprocess        │
                                           │   cdparanoia / flac /    │
                                           │   lame / ffmpeg          │
                                           └──────────────────────────┘
```

- フロントは表示と編集 UI のみ。状態の真実は SQLite に常駐。
- リッピング進捗は Rust → React へ `rip-progress` イベントで逐次配信。
- MusicBrainz は `User-Agent` 必須・1 req/sec の rate limit に従って実装。

## 出力 XML 互換性

- `Major/Minor Version` / `Date` / `Application Version` / `Library Persistent ID` ヘッダ
- `Tracks` 辞書 (Track ID キー、全フィールド埋め)
- `Playlists` 配列 (Persistent ID / Parent Persistent ID でフォルダ階層、`Playlist Items` で trackId 参照)
- 文字列は `&` `<` `>` を数値文字参照でエスケープ
- ファイルパスは `file://` URL に percent-encode

DJ ソフトで読み取れない症状があれば issue に XML 断片を添えて報告してください。

## 制約 / 今後

- スマートプレイリストの判定条件は v1 では編集不可 (`Smart Info` は読み込み・書き出しともに保持しません)。
- ライブラリ全体の置換のみ対応 (既存 XML への差分マージは未実装)。
- ドラッグ&ドロップでのプレイリスト追加は未実装 (右クリックメニューで代替)。
- WSL2 では物理 CD が直接見えないため usbipd 必須。
- CD リッピング進捗の % 表示は cdparanoia の標準出力を解析していないため、現状はトラック単位の表示のみ。

## ライセンス

[MIT License](LICENSE) © 2026 tainakanchu

サードパーティ: `dj-curator` プラグインに同梱の字体変換データ (`src-tauri/src/text_fold/gen/`) は [OpenCC](https://github.com/BYVoid/OpenCC) (Apache-2.0) 由来です。
