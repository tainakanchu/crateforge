//! ドラッグ＆ドロップ取り込みの前処理: ドロップされた zip を展開して、
//! 取り込み (`plan_import` / `import_with_actions`) に渡すパスへ置き換える。
//! 展開の仕様は `importer::zip_extract` を参照。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::commands::library::open_db;
use crate::importer::zip_extract::{self, PreparedDrop};

/// 整理 ON のときの一時展開先 (`<app cache>/import-staging`)。
pub(crate) fn staging_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join(zip_extract::STAGING_DIR_NAME))
        .map_err(|e| format!("キャッシュフォルダを取得できません: {e}"))
}

/// ドロップされたパスのうち zip を展開し、展開先フォルダに置き換えて返す。
/// zip 以外のパスはそのまま返す。整理 ON (ライブラリルート設定済み) なら一時フォルダへ、
/// OFF なら zip の隣へ展開する。
#[tauri::command]
pub async fn prepare_drop_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<PreparedDrop, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // zip が無ければ DB も開かずにそのまま返す。
        if !paths.iter().any(|p| zip_extract::is_zip_file(Path::new(p))) {
            return Ok(PreparedDrop {
                paths,
                ..Default::default()
            });
        }
        let organize = open_db(&app)?.organize_root().is_some();
        let root = staging_root(&app)?;
        Ok(zip_extract::prepare_drop_paths(
            &paths,
            organize,
            &root,
            zip_extract::MAX_TOTAL_UNCOMPRESSED_BYTES,
        ))
    })
    .await
    .map_err(|e| format!("zip extract panicked: {e}"))?
}

/// `prepare_drop_paths` が作った一時フォルダを消す (取り込み完了 / キャンセル後)。
#[tauri::command]
pub async fn cleanup_import_staging(app: AppHandle, staging: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = staging_root(&app)?;
        zip_extract::cleanup_staging(&root, Path::new(&staging))
    })
    .await
    .map_err(|e| format!("staging cleanup panicked: {e}"))?
}
