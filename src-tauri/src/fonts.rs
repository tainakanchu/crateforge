//! フォント列挙 + Noto Sans CJK のオンデマンドDL/キャッシュ/配信。

use std::collections::BTreeSet;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

pub const CJK_FONT_URL: &str = "https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/Variable/OTF/NotoSansCJKjp-VF.otf";
pub const CJK_FONT_FILE: &str = "NotoSansCJKjp-VF.otf";

/// システムにインストールされているフォントファミリー名を列挙する。
/// 重複除去・ソートして返す。
pub fn list_families() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut set = BTreeSet::new();
    for face in db.faces() {
        // English 名を優先し、なければ最初の名前を使う。
        let name = face
            .families
            .iter()
            .find(|(_, lang)| *lang == fontdb::Language::English_UnitedStates)
            .or_else(|| face.families.first())
            .map(|(name, _)| name.clone());
        if let Some(n) = name {
            set.insert(n);
        }
    }
    set.into_iter().collect()
}

/// CJK フォントのキャッシュパス `<app_local_data>/fonts/NotoSansCJKjp-VF.otf`。
pub fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()?
        .join("fonts")
        .join(CJK_FONT_FILE)
        .into()
}

/// キャッシュにフォントファイルが存在し、サイズが 0 より大きければ true。
pub fn is_installed(app: &AppHandle) -> bool {
    cache_path(app)
        .map(|p| p.exists() && p.metadata().map(|m| m.len() > 0).unwrap_or(false))
        .unwrap_or(false)
}

/// `cjk-font-progress` イベントのペイロード。
#[derive(serde::Serialize, Clone)]
pub struct CjkFontProgress {
    pub downloaded: u64,
    pub total: u64,
}

/// CJK フォントを CJK_FONT_URL からダウンロードしてキャッシュへ保存する。
/// 進捗は `cjk-font-progress` イベント `{ downloaded, total }` で配信する。
/// .part ファイルに書き出し、完了後に rename する。失敗時は .part を削除する。
pub async fn download(app: tauri::AppHandle) -> Result<PathBuf, String> {
    let dest = cache_path(&app).ok_or("キャッシュ先を解決できませんでした")?;
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("フォルダ作成に失敗: {e}"))?;
    }

    let part = dest.with_extension("part");

    let run = async {
        let client = reqwest::Client::builder()
            .user_agent("Crateforge")
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client
            .get(CJK_FONT_URL)
            .send()
            .await
            .map_err(|e| format!("ダウンロード開始に失敗: {e}"))?
            .error_for_status()
            .map_err(|e| format!("ダウンロードに失敗: {e}"))?;

        let total = resp.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;

        use std::io::Write;
        let mut file =
            std::fs::File::create(&part).map_err(|e| format!(".part ファイル作成に失敗: {e}"))?;

        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("ダウンロード中にエラー: {e}"))?
        {
            file.write_all(&chunk)
                .map_err(|e| format!("書き込みに失敗: {e}"))?;
            downloaded += chunk.len() as u64;
            let _ = app.emit("cjk-font-progress", CjkFontProgress { downloaded, total });
        }

        drop(file);
        std::fs::rename(&part, &dest).map_err(|e| format!("保存に失敗: {e}"))?;
        Ok::<PathBuf, String>(dest.clone())
    };

    match run.await {
        Ok(p) => Ok(p),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn list_families_does_not_panic() {
        let _ = super::list_families();
    }
}
