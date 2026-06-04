# ファイル自動整理機能 仕様書

> 取り込んだ音声ファイルを、メタデータ（アーティスト / アルバム）に基づいて
> **`<ライブラリルート>/<AlbumArtist>/<Album>/<ファイル名>`** のディレクトリ構造へ
> 物理的に配置・再配置する機能の仕様。
>
> ステータス: 設計確定（未実装）。本書をもとにローカルで実装する。
> 対象ブランチ: `claude/directory-org-feature-status-reJK0`

---

## 1. ゴールと決定事項

ユーザー確認済みの方針:

| 項目 | 決定 |
|------|------|
| **再配置トリガー** | メタデータ編集時に**自動**で実行（TrackEditor の Save 押下時） |
| **ファイルの扱い** | 原則**移動 (move)**。ただし**外部からのインポート / ドラッグ&ドロップ時はコピー**（元ファイルを残す） |
| **タグ書き戻し** | する（`lofty` でファイル本体のタグを更新） |

ゴール:
- 外から取り込んだ雑多なファイルが、編集後に `AlbumArtist/Album/` 配下へ整然と並ぶ。
- DB の `location_path` と実ファイルの場所が常に一致する。
- 音声ファイル本体のタグも DB と同期し、他アプリ（rekordbox 等）でも正しく見える。

---

## 2. 現状（実装の出発点）

調査で確認した現コードの挙動。**いずれも本機能の前提として変更が必要。**

| 操作 | 現挙動 | 該当箇所 |
|------|--------|----------|
| ローカルファイル取り込み | その場参照のみ。`location_path` に絶対パスを保存するだけで**コピー/移動なし** | `src-tauri/src/importer/mod.rs:92-110` |
| メタデータ編集 | **DB のみ更新**。タグ書き戻し・ファイル移動なし | `src-tauri/src/db/tracks.rs:310-379`, `src-tauri/src/commands/library.rs:89-93` |
| フォルダ整理 | CD リッピング出力時のみ（フラット） | `src-tauri/src/cd_ripper/ripper.rs:83-87` |
| ファイル名サニタイズ | `sanitize_filename()` 既存（リッパー専用） | `src-tauri/src/cd_ripper/ripper.rs:158-164` |
| 設定保存層 | `app_state` テーブルに key/value。`set_state` / `get_state` 完備 | `src-tauri/src/db/stats.rs:29-47` |
| `lofty` | 読み取りのみ使用。書き込みは未使用 | `Cargo.toml:35`（`lofty = "0.21"`） |

補足:
- `import_files` は `importer::import_files(&db, &paths)` を呼ぶ。取り込みは「タグ読み取り → `db.add_imported_track(...)`」のみ。
- `update_track` は `db.update_track(track_id, &edits)` のみ。`edits` は `TrackEdit`（`src-tauri/src/models.rs:98-121`）。
- トラックの場所は `tracks.location_path`（解決済み絶対パス）と `tracks.location_raw`（`file://` URI）の 2 本。`path_to_file_url()`（`itunes_xml/writer.rs`）で URI 生成。

---

## 3. 設定（ライブラリルート）

物理整理には**基準ディレクトリ（ライブラリルート）**が必須。`app_state` に保存する。

| key | 値 | 用途 |
|-----|----|------|
| `library_root` | 絶対パス文字列。未設定（None / 空）なら機能オフ | 整理先のルート |
| `organize_enabled` | `"1"` / `"0"`（任意。デフォルト `"1"`） | 整理を一時無効化したい場合のトグル |

**ガード方針**: `library_root` が未設定なら、取り込み・編集時の整理処理は**完全にスキップ**し、従来どおり（その場参照 / DB のみ更新）に振る舞う。これにより既存ユーザーの挙動を壊さない。

> 推奨デフォルト: 初回は未設定。設定 UI でユーザーに 1 度だけ選んでもらう（例 `~/Music/MyLibrary`）。
> OS の Music ディレクトリを初期候補として提示すると親切。

---

## 4. フォルダ構造の規則

### 4.1 ターゲットパス生成

```
<library_root>/<artist_component>/<album_component>/<file_name>
```

- `artist_component`:
  1. `album_artist` が非空ならそれ
  2. なければ `artist`
  3. どちらも空なら `"Unknown Artist"`
- `album_component`:
  1. `album` が非空ならそれ
  2. 空なら `"Unknown Album"`
- `file_name`: **元ファイル名をそのまま維持**（拡張子含む）。
  - 理由: ファイル名リネームまでやると差分が大きくスコープが膨らむ。まずはフォルダ振り分けに限定。
  - （将来拡張）`NN - Title.ext` 形式へのリネームはオプションで追加検討。

### 4.2 サニタイズ

各パスコンポーネント（artist / album）に適用。`cd_ripper::ripper::sanitize_filename` と同じ除去ルールを共通化して使う。

- 除去文字: `/ \ : * ? " < > |`
- 前後空白トリム
- 追加考慮（手元実装時に推奨）:
  - 末尾のドット `.` / 空白は Windows で不可 → トリム
  - 予約名（`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`）は末尾に `_` を付与
  - サニタイズ結果が空になったら `"_"` などのプレースホルダにフォールバック

> 実装メモ: `sanitize_filename` を `cd_ripper` から共通モジュール（後述 `organizer`）へ移すか、`organizer` 側に同等関数を用意し、リッパー側もそれを使うよう統一すると保守が楽。

### 4.3 衝突回避

ターゲットに既に**別の**ファイルが存在する場合:
- `name.ext` → `name (2).ext` → `name (3).ext` … と連番を付与して回避。
- ターゲットが**移動元と同一ファイル**（パス一致）の場合は no-op。

---

## 5. トリガーと挙動

### 5.1 インポート / ドラッグ&ドロップ時（コピー）

`import_files`（`importer/mod.rs`）を拡張。

1. 従来どおり `lofty` でタグ読み取り、フォールバック（親=album, 祖父=artist）も維持。
2. `library_root` が設定済み かつ `organize_enabled != "0"` の場合:
   - §4 の規則でターゲットパスを算出。
   - **コピー**（`fs::copy`）でルート配下に複製。元ファイルは残す。
   - DB に登録する `location_path` / `location_url` は**コピー先**のパスにする。
3. 未設定の場合: 従来どおり元パスをそのまま登録。

> 取り込み時はタグ書き戻し不要（読み取った内容をそのままコピーするだけ）。
> ただしフォールバックで補完した album/artist を**コピー後にタグへ反映したい**なら §5.2 の `write_tags` を流用してもよい（任意）。

### 5.2 メタデータ編集時（タグ書き戻し + 移動）

`update_track`（`commands/library.rs` + `db/tracks.rs`）を拡張。**処理順序が重要。**

```
1. 編集前のトラックを取得（旧 location_path を保持）
   └ db.get_track_by_track_id(track_id)
2. DB を更新（既存の db.update_track）
3. library_root 未設定 or organize_enabled=="0" or location_path が無い/ファイル非存在
   → ここで終了（従来挙動）
4. 更新後の最終的な artist/album/album_artist 等を確定
   （edits で来た値 + 来なかった項目は旧値）
5. lofty で実ファイルのタグを書き戻す（write_tags）
6. §4 で新ターゲットパスを算出
7. 旧パス == 新パス なら終了（タグだけ更新済み）
8. ファイルを移動（relocate: move）。衝突回避適用。
9. DB の location_path / location_raw を新パスへ更新
   └ 新規メソッド db.set_track_location(track_id, &new_path, &new_url)
```

**エラー方針**: タグ書き戻し / 移動が失敗しても DB 更新（手順 2）は確定済み。
失敗時は `Err` を返さずログ出力＋警告に留めるか、`update_track` の戻り値を
`Result<UpdateTrackOutcome, String>` 的に拡張して UI に「整理失敗」を通知するか、いずれか選択。
**推奨**: DB 更新は成功させ、整理失敗は警告として UI に表示（編集自体は成功扱い）。

---

## 6. Rust 実装詳細

### 6.1 新モジュール `organizer`

`src-tauri/src/organizer/mod.rs` を新設し、`lib.rs` に `mod organizer;` を追加。

責務:
- パスコンポーネントのサニタイズ
- ターゲットパス生成
- 衝突回避付き relocate（move / copy）
- lofty タグ書き戻し

```rust
//! 取り込みファイルを <root>/<AlbumArtist>/<Album>/ へ物理整理する。
use std::path::{Path, PathBuf};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag, TagExt};

/// パスコンポーネント用サニタイズ（cd_ripper と同ルール）。
pub fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "_".to_string()
    } else {
        cleaned
    }
}

fn pick(artist: Option<&str>, album_artist: Option<&str>) -> String {
    let aa = album_artist.map(str::trim).filter(|s| !s.is_empty());
    let a = artist.map(str::trim).filter(|s| !s.is_empty());
    aa.or(a).unwrap_or("Unknown Artist").to_string()
}

/// <root>/<artist>/<album>/<元ファイル名> を組み立てる。
pub fn target_path(
    root: &Path,
    artist: Option<&str>,
    album_artist: Option<&str>,
    album: Option<&str>,
    source: &Path,
) -> PathBuf {
    let artist_dir = sanitize_component(&pick(artist, album_artist));
    let album_dir = sanitize_component(
        album.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Unknown Album"),
    );
    let file_name = source
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "track".to_string());
    root.join(artist_dir).join(album_dir).join(file_name)
}

/// 既存の別ファイルと衝突する場合 " (2)" などを付けて回避。
fn resolve_collision(target: &Path, source: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    // 同一ファイルなら衝突ではない
    if let (Ok(a), Ok(b)) = (target.canonicalize(), source.canonicalize()) {
        if a == b {
            return target.to_path_buf();
        }
    }
    let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = target.extension().map(|s| s.to_string_lossy().to_string());
    let dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
    for i in 2..10_000 {
        let name = match &ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None => format!("{stem} ({i})"),
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    target.to_path_buf()
}

#[derive(Clone, Copy)]
pub enum Mode { Move, Copy }

/// ファイルを relocate。戻り値は実際の配置先パス。
pub fn relocate(source: &Path, target: &Path, mode: Mode) -> Result<PathBuf, String> {
    // 同一パスなら何もしない
    if source == target {
        return Ok(target.to_path_buf());
    }
    let final_target = resolve_collision(target, source);
    if final_target == source {
        return Ok(final_target);
    }
    if let Some(parent) = final_target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    match mode {
        Mode::Copy => {
            std::fs::copy(source, &final_target).map_err(|e| format!("copy failed: {e}"))?;
        }
        Mode::Move => {
            // rename は同一デバイス内のみ。失敗したら copy + remove にフォールバック。
            if std::fs::rename(source, &final_target).is_err() {
                std::fs::copy(source, &final_target).map_err(|e| format!("copy failed: {e}"))?;
                std::fs::remove_file(source).map_err(|e| format!("remove failed: {e}"))?;
            }
        }
    }
    Ok(final_target)
}

/// 書き戻すタグ値（None=触らない / Some(None)=クリア / Some(Some)=設定 は呼び出し側で組み立て済み）。
pub struct TagWrite<'a> {
    pub title: Option<&'a str>,
    pub artist: Option<&'a str>,
    pub album_artist: Option<&'a str>,
    pub album: Option<&'a str>,
    pub genre: Option<&'a str>,
    pub year: Option<i64>,
    pub track_number: Option<i64>,
    pub track_count: Option<i64>,
    pub disc_number: Option<i64>,
    pub disc_count: Option<i64>,
}

/// lofty で実ファイルのプライマリタグを更新して保存する。
pub fn write_tags(path: &Path, w: &TagWrite) -> Result<(), String> {
    let mut tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {e}"))?
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;

    // プライマリタグが無ければファイル種別に応じて新規作成。
    if tagged.primary_tag_mut().is_none() {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.primary_tag_mut().ok_or("no primary tag")?;

    if let Some(v) = w.title { tag.set_title(v.to_string()); }
    if let Some(v) = w.artist { tag.set_artist(v.to_string()); }
    if let Some(v) = w.album { tag.set_album(v.to_string()); }
    if let Some(v) = w.genre { tag.set_genre(v.to_string()); }
    if let Some(v) = w.album_artist {
        // Accessor に album_artist が無いので ItemKey で直接挿入。
        tag.insert_text(ItemKey::AlbumArtist, v.to_string());
    }
    match w.year {
        Some(y) if y > 0 => tag.set_year(y as u32),
        _ => {}
    }
    match w.track_number {
        Some(n) if n > 0 => tag.set_track(n as u32),
        _ => {}
    }
    match w.track_count {
        Some(n) if n > 0 => tag.set_track_total(n as u32),
        _ => {}
    }
    match w.disc_number {
        Some(n) if n > 0 => tag.set_disk(n as u32),
        _ => {}
    }
    match w.disc_count {
        Some(n) if n > 0 => tag.set_disk_total(n as u32),
        _ => {}
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("save tags failed: {e}"))?;
    Ok(())
}
```

> **lofty 0.21.1 API は実ソースで確認済み**（registry の `lofty-0.21.1`）。
> - import: `lofty::probe::Probe`, `lofty::file::{AudioFile, TaggedFileExt}`,
>   `lofty::tag::{Accessor, ItemKey, Tag, TagExt}`, `lofty::config::WriteOptions`
> - `Tag::new(TagType)` / `TaggedFileExt::primary_tag_type()` / `primary_tag_mut()` / `insert_tag()`
> - Accessor: `set_title/set_artist/set_album/set_genre/set_year(u32)/set_track(u32)/set_track_total(u32)/set_disk(u32)/set_disk_total(u32)`
>   と対応する `remove_*`
> - album artist は Accessor に無い → `Tag::insert_text(ItemKey::AlbumArtist, String)`
> - 保存は `AudioFile::save_to_path(path, WriteOptions::default())`

### 6.2 設定コマンド

`src-tauri/src/commands/library.rs` に追加（または新 `commands/settings.rs`）:

```rust
#[tauri::command]
pub fn get_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let db = get_db(&app)?;
    db.get_state("library_root").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_library_root(app: AppHandle, path: String) -> Result<(), String> {
    let db = get_db(&app)?;
    db.set_state("library_root", &path).map_err(|e| e.to_string())
}
```

`lib.rs` の `invoke_handler!` に `get_library_root`, `set_library_root` を登録。

> `db.get_state` は現在 `#[allow(dead_code)]` 付き。実利用するので属性は外してよい。

### 6.3 `importer` の変更（コピー対応）

`importer::import_files` のシグネチャを `library_root: Option<&Path>` を受けるよう拡張、
または `import_files` 内で `db.get_state("library_root")` を読む。
`read_and_insert` 内、DB 挿入前に:

```rust
let mut location_path = path.to_string_lossy().to_string();
if let Some(root) = library_root {
    let target = organizer::target_path(
        root,
        artist.as_deref(),
        album_artist.as_deref().or(artist.as_deref()),
        album.as_deref(),
        path,
    );
    match organizer::relocate(path, &target, organizer::Mode::Copy) {
        Ok(dest) => location_path = dest.to_string_lossy().to_string(),
        Err(e) => eprintln!("organize on import failed: {e}"), // 元パスのまま続行
    }
}
let location_url = path_to_file_url(&location_path);
```

### 6.4 `update_track` の変更（タグ + 移動）

`commands/library.rs::update_track` を拡張:

```rust
#[tauri::command]
pub fn update_track(app: AppHandle, track_id: i64, edits: TrackEdit) -> Result<(), String> {
    let db = get_db(&app)?;

    // 1. 旧トラック取得
    let before = db.get_track_by_track_id(track_id).map_err(|e| e.to_string())?;

    // 2. DB 更新（既存）
    db.update_track(track_id, &edits).map_err(|e| e.to_string())?;

    // 3. ガード
    let root = match db.get_state("library_root").map_err(|e| e.to_string())? {
        Some(r) if !r.is_empty() => r,
        _ => return Ok(()),
    };
    let Some(before) = before else { return Ok(()) };
    let Some(loc) = before.location_path.clone() else { return Ok(()) };
    let src = std::path::Path::new(&loc);
    if !src.exists() { return Ok(()); }

    // 4. 最終値（edits 優先、無ければ旧値）
    let artist = edits.artist.clone().or(before.artist.clone());
    let album_artist = edits.album_artist.clone().or(before.album_artist.clone());
    let album = edits.album.clone().or(before.album.clone());
    let title = edits.name.clone().or(before.name.clone());
    // year/track/disc も同様（Option<Option<i64>> の二重 Option に注意）
    // edits.year: Some(Some(v)) で設定値、Some(None) でクリア、None で旧値…を解決する

    // 5. タグ書き戻し
    let w = organizer::TagWrite { /* 上記の値を詰める */ };
    if let Err(e) = organizer::write_tags(src, &w) {
        eprintln!("write_tags failed: {e}"); // 整理失敗は警告に留める
    }

    // 6-8. 移動
    let target = organizer::target_path(
        std::path::Path::new(&root),
        artist.as_deref(), album_artist.as_deref().or(artist.as_deref()),
        album.as_deref(), src,
    );
    match organizer::relocate(src, &target, organizer::Mode::Move) {
        Ok(dest) if dest != src => {
            let url = crate::itunes_xml::writer::path_to_file_url(&dest.to_string_lossy());
            // 9. DB のパス更新
            db.set_track_location(track_id, &dest.to_string_lossy(), &url)
                .map_err(|e| e.to_string())?;
        }
        Ok(_) => {}
        Err(e) => eprintln!("relocate failed: {e}"),
    }
    Ok(())
}
```

> `edits.year` などの二重 Option（`Option<Option<i64>>`）は、`Some(Some(v))`=設定 /
> `Some(None)`=クリア / `None`=変更なし。タグ書き戻しの値決定でこれを解決すること。
> （`models.rs:108-120` 参照）

### 6.5 DB に location 更新メソッド追加

`src-tauri/src/db/tracks.rs` に:

```rust
pub fn set_track_location(&self, track_id: i64, path: &str, url: &str) -> Result<()> {
    self.conn.execute(
        "UPDATE tracks SET location_path = ?1, location_raw = ?2 WHERE track_id = ?3",
        params![path, url, track_id],
    )?;
    Ok(())
}
```

### 6.6 変更ファイル一覧（Rust）

| ファイル | 変更 |
|----------|------|
| `src-tauri/src/organizer/mod.rs` | **新規**。§6.1 全体 |
| `src-tauri/src/lib.rs` | `mod organizer;` 追加 / コマンド 2 つ登録 |
| `src-tauri/src/commands/library.rs` | `update_track` 拡張 / `get_library_root` / `set_library_root` 追加 |
| `src-tauri/src/importer/mod.rs` | コピー対応（§6.3） |
| `src-tauri/src/db/tracks.rs` | `set_track_location` 追加 |
| `src-tauri/src/db/stats.rs` | `get_state` の `#[allow(dead_code)]` 除去（任意） |
| `src-tauri/src/cd_ripper/ripper.rs` | （任意）`sanitize_filename` を `organizer::sanitize_component` に統一 |

---

## 7. フロントエンド実装詳細

### 7.1 型・API

`src/types/`（`Track` 等の定義場所）に変更不要。`src/api/library.ts` に追加:

```ts
export async function getLibraryRoot(): Promise<string | null> {
  return invoke("get_library_root");
}
export async function setLibraryRoot(path: string): Promise<void> {
  return invoke("set_library_root", { path });
}
```

### 7.2 設定 UI

ライブラリルートを選択する導線を追加（Toolbar かメニュー）。
ディレクトリ選択は既存パターンを流用:

```ts
import { open } from "@tauri-apps/plugin-dialog";
const dir = await open({ directory: true, multiple: false });
if (typeof dir === "string") await libraryApi.setLibraryRoot(dir);
```

（`RipDialog.tsx:105` の `open({ directory: true })` と同型）

- 表示: 現在の `library_root`（未設定なら「未設定（整理オフ）」）。
- 設定/変更ボタン。

### 7.3 TrackEditor の挙動

- ロジック変更は基本不要（`update_track` がバックエンドで整理まで実施）。
- Save 後、`onSaved()` 経由でトラック一覧を再取得すれば、更新後の `locationPath`（移動後パス）が反映される。
- Location 欄は引き続き読み取り専用でよい（`TrackEditor.tsx:217-221`）。整理後の新パスが表示されるようになる。
- （任意 UX）整理が走った旨のトースト表示。

### 7.4 インポート UI

- `handleImportFiles`（`Toolbar.tsx:133-`）は変更不要（バックエンドがコピー判断）。
- （任意）`library_root` 未設定時に「整理先が未設定です。設定しますか？」と促す。

---

## 8. エッジケース / 注意点

1. **ライブラリ外の既存ファイル**: 編集時、ルート外にあるファイルもルート配下へ**移動**される（=整理の意図どおり）。これを望まないなら「ルート配下のファイルのみ移動する」ガードを追加検討。
2. **クロスデバイス移動**: `fs::rename` は別ボリュームで失敗 → copy+remove フォールバック実装済み（§6.1）。
3. **ファイル使用中（再生中）**: 再生中トラックを移動すると `rodio` のファイルハンドルと競合し得る。再生停止中のみ整理する、または移動失敗を警告に留める。
4. **タグ書き戻し非対応形式**: WAV 等は書き込み制約あり。`write_tags` 失敗は警告に留め、移動は継続。
5. **空フォルダの掃除**: 移動後、元の親ディレクトリが空になっても**削除しない**方針（誤削除リスク回避）。必要なら別途。
6. **大文字小文字のみ異なるパス**: 一部 FS で同一視される。canonicalize 比較で概ね吸収。
7. **大量編集**: 1 件ずつ移動。バッチ整理コマンドが欲しくなったら別途追加（本仕様の対象外）。

---

## 9. テスト観点

`organizer` モジュールは tauri 非依存なので**単体テスト可能**（`#[cfg(test)]`）。

- `sanitize_component`: 禁止文字除去 / 空→`_` / 末尾ドット除去。
- `target_path`: album_artist 優先 / artist フォールバック / Unknown 補完 / 元ファイル名維持。
- `resolve_collision`: 既存衝突で連番 / 同一ファイルは no-op。
- `relocate(Move/Copy)`: tempdir で実ファイル移動・コピー、親ディレクトリ自動生成。
- `write_tags`: tempdir に小さな mp3/flac を置き、書き戻し→読み直しで値一致を確認。

> 注: 本リポジトリのフル `cargo build` は Linux で `webkit2gtk-4.1` を要するため、
> GUI を含むビルドは Nix 環境（`nix develop`）で行うこと。`organizer` の単体テストは
> `cargo test --lib` で実行できるが、これも crate 全体のコンパイルが必要なため
> Nix 環境推奨。

---

## 10. 実装チェックリスト

- [ ] `src-tauri/src/organizer/mod.rs` 作成（sanitize / target_path / relocate / write_tags + tests）
- [ ] `lib.rs` に `mod organizer;` と 2 コマンド登録
- [ ] `commands/library.rs`: `get_library_root` / `set_library_root` 追加
- [ ] `commands/library.rs`: `update_track` を「DB更新→タグ書戻し→移動→パス更新」に拡張
- [ ] `importer/mod.rs`: ルート設定時はコピーして配置、`location_path` をコピー先に
- [ ] `db/tracks.rs`: `set_track_location` 追加
- [ ] `db/stats.rs`: `get_state` の `#[allow(dead_code)]` 除去（任意）
- [ ] `src/api/library.ts`: `getLibraryRoot` / `setLibraryRoot`
- [ ] 設定 UI（ルート選択）
- [ ] `nix develop` 下で `cargo test --lib`（organizer）/ `pnpm tauri dev` 動作確認
- [ ] 実機: 取り込み→コピー配置 / 編集→タグ更新＋移動 / DB パス追従 を確認
