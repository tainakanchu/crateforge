---
title: ライブラリ取り込み
description: iTunes / Music の Library.xml 取り込み、フォルダ・ファイル取り込み、iTunes 互換 XML の自動エクスポート。
---

Crateforge へのライブラリ取り込みは、**iTunes / Music の `Library.xml`** か、**手元の音楽ファイル** のどちらからでも行えます。

> 画像は後日追加

## iTunes / Music の Library.xml を取り込む

ツールバーの **「📥 Import XML」** から `iTunes Library.xml`（Apple plist 形式）を選びます。

- ストリーミング SAX パーサで読み込むため、大きなライブラリでも高速です。
- 取り込みはストリーミング解析で、トラック・プレイリスト・**フォルダ階層**（Persistent ID / Parent Persistent ID）を再現します。
- 取り込みは **ライブラリ全体の置換** として行われます（既存 XML への差分マージは未対応）。

:::note
スマートプレイリストの判定条件（`Smart Info`）は読み込み・書き出しともに **保持しません**。
取り込んだスマートプレイリストは、Crateforge の[スマートプレイリスト](../smart-playlists/)機能で作り直せます。
:::

### Library.xml の場所

- **macOS** — 「ミュージック」アプリの環境設定で「XML を共有」を有効化すると書き出されます（古い iTunes では `~/Music/iTunes/iTunes Library.xml`）。
- **Windows** — 通常は `%USERPROFILE%\Music\iTunes\iTunes Library.xml`。

## 音楽ファイルを取り込む

ツールバーの **「🎵 Add Files」** で、手元の音楽ファイルを直接取り込めます（複数選択可）。

- 対応形式: **FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF** など。
- タグ（タイトル / アーティスト / アルバム / ジャンル / 年 など）を `lofty` で読み取ります。
- 取り込み時に **BPM タグ**（TBPM / tmpo / Vorbis BPM）も読み取ります。

## フォルダごと取り込む（Add Folder / ドラッグ＆ドロップ）

ツールバーの **「Add Folder」**（狭い幅では ⋯ メニューの中）でフォルダを選ぶと、**サブフォルダも再帰的に走査** して
対応形式のファイルをまとめて取り込みます。ウィンドウへの **ドラッグ＆ドロップ** も同じ経路で、
ファイルとフォルダを混ぜて落とせます。

- 対応拡張子のファイルだけを取り込みます（それ以外は無視されます）。
- **隠しファイル / 隠しフォルダ（`.` 始まり）はスキップ** します（`.DS_Store` など）。
  ただし自分で明示的に指定したファイルは隠しでも取り込みます。
- **すでにライブラリにあるファイル（同じパス）はスキップ** します。同じフォルダを何度落としても二重登録されません。
- シンボリックリンクのループは検出して打ち切ります。読めないフォルダは飛ばして続行します。
- 結果は「取り込んだ件数 / 取り込み済みでスキップした件数 / 失敗した件数」でトースト表示されます。
- 取り込んだ曲はサイドバーの **Inbox** に溜まるので、そこから[レーティングや Crate 追加](../playback/)を進められます。

### 整理先フォルダ（自動整理）

設定で「整理先（ライブラリルート）」を指定すると、取り込み・編集時にファイルを
`<整理先>/<アルバムアーティスト>/<アルバム>/` へ iTunes 準拠のリネームで配置します。

設定の **「自動検出」** を使うと、既存の曲のパスから整理先を推定して設定できます。

## タグのファイル書き戻し

曲を編集（Get Info / `Ctrl + I`）すると、DB の更新に加えて **実ファイルのタグ（ID3 / Vorbis / MP4）へ書き戻します**。
整理先フォルダの設定は不要で、**未設定でもタグは書き戻されます**（整理先が設定されているときだけ、あわせてフォルダ移動 + リネームを行います）。

書き戻す内容には次も含まれます。

- **BPM** — TBPM（ID3v2）/ tmpo（MP4）/ `BPM`（Vorbis Comments）へ整数で書きます。
  曲自身の BPM を優先し、未設定なら[解析](../dj-analysis/)結果を使います。
- **Key** — **InitialKey**（ID3v2 TKEY / MP4 initialkey / Vorbis INITIALKEY）へ、
  Camelot ではなく音楽表記（`Am` / `F#m` / `C` など）で書きます。rekordbox / Serato / Traktor が読むのはこの表記です。

:::note
iTunes 互換 XML には Key を書き出しません（Apple の plist スキーマにキーを表す標準要素が無いため）。
Key はファイルタグの InitialKey 経由で他のソフトへ渡ります。BPM は XML にも含まれます。
:::

## ライブラリから曲を削除する / ファイルの場所を開く

トラックを右クリックすると、次の操作ができます。

- **「Finder / エクスプローラで表示」** — その曲のファイルを OS のファイルマネージャで開きます
  （macOS は Finder で選択状態、Windows はエクスプローラで選択状態、Linux は親フォルダを開きます）。
- **「ライブラリから削除…」** — 選択した曲をライブラリ（DB）から削除します。確認ダイアログで
  **「ファイルも削除する」** を選ぶと、実ファイルも削除できます。
  再生中・キューに入っていた曲は、再生を止めてキューからも外します。

:::caution
実ファイルの削除は **整理先フォルダ（ライブラリルート）の中にあるファイルに限られます**。ゴミ箱へは送られず、直接削除されます。

- 整理先フォルダが未設定のときは「ファイルも削除する」を選べません（DB からの削除だけになります）。
- 選択の中に整理先フォルダの外のファイルが 1 つでもあると、**1 件もファイルを削除せず** エラーになります。
  その場合はチェックを外して、ライブラリ（DB）からの削除だけを行ってください。
:::

## iTunes 互換 XML を書き出す

ツールバーの **「📤 Export XML」** で `iTunes Library.xml`（Apple plist 形式）を書き出せます。
rekordbox / Serato / Traktor など、iTunes XML を読み取る DJ ソフトに渡せます。

書き出される XML には次が含まれます。

- `Major/Minor Version` / `Date` / `Application Version` / `Library Persistent ID` ヘッダ
- `Tracks` 辞書（Track ID キー、全フィールド）
- `Playlists` 配列（Persistent ID / Parent Persistent ID によるフォルダ階層、`Playlist Items` で trackId 参照）
- 文字列は `&` `<` `>` を数値文字参照でエスケープ、ファイルパスは `file://` URL に percent-encode

### 自動エクスポート

ツールバーの **🕐 トグル** を ON にすると、**変更があったときだけ・約 30 分間隔＋終了時** に
Library XML を自動で書き出します。DJ ソフト側に最新のライブラリを常に渡しておきたいときに便利です。

自動エクスポートが成功したときは、あわせて `library.db` も自動バックアップされます
（設定の[ライブラリのバックアップ](../install/)で切り替えられます）。

## CD から取り込む（リッピング）

ツールバーの **「💿 Rip CD」** から、物理 CD を取り込めます（MusicBrainz で曲情報、Cover Art Archive でジャケットを自動取得）。

1. **Drive** を入力して「🔍 Detect Disc」（既定は Linux: `/dev/cdrom`、macOS: `disk1`、Windows: `D:`。Linux では `/dev/sr0` 等も手入力できます）
2. TOC が読まれ、自動的に MusicBrainz の候補アルバムを表示
3. 必要に応じてリリースを選び直し、トラックを選択
4. **Format**（FLAC / ALAC / MP3 / WAV）と **Output** フォルダを指定して「▶ Start Ripping」
5. 完了後は自動的にライブラリに追加（オプション ON 時）

:::caution
WSL2 では物理 CD が直接見えないため、`usbipd-win` でドライブを WSL2 に attach する必要があります。
Windows ビルドでは `discid`（libdiscid）を同梱しませんが、TOC は OS の IOCTL から直接読み取り MusicBrainz Disc ID を自前計算するため、Detect Disc は動作します。libdiscid も IOCTL も使えない環境では、TOC を手動入力して MusicBrainz 検索できます。
:::
