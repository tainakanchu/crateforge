use std::path::Path;

/// Cover Art Archive のフロント画像 URL (500px) を返す。
pub fn front_url(release_mbid: &str) -> String {
    format!(
        "https://coverartarchive.org/release/{}/front-500",
        release_mbid
    )
}

/// Cover Art Archive から画像をダウンロードしてファイルに保存する。
/// 現状は URL を React 側に渡すだけで使っていないが、ローカルキャッシュを
/// 実装する際に使う想定で残してある。
#[allow(dead_code)]
pub async fn download(release_mbid: &str, output_path: &Path) -> Result<(), String> {
    let url = front_url(release_mbid);
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Cover art request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Cover art not found: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read cover art: {}", e))?;
    std::fs::write(output_path, &bytes).map_err(|e| format!("Failed to write cover art: {}", e))?;
    Ok(())
}
