//! GitHub Releases ベースの軽量アップデートチェック。
//!
//! `tauri-plugin-updater` を使わない単純版: 起動時に `GET /repos/.../releases/latest`
//! を叩き、`tag_name` を `Cargo.toml` のバージョンと比較する。利用可能なら
//! HTML URL とタグ名を返し、フロントが「アップデートする / あとで」ダイアログを出す。

use serde::Serialize;

const RELEASES_API: &str =
    "https://api.github.com/repos/tainakanchu/itunes-playlist-viewer/releases/latest";
const USER_AGENT: &str = concat!(
    "iTunes-Playlist-Viewer/",
    env!("CARGO_PKG_VERSION"),
    " (update-check)"
);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub release_notes: String,
    pub published_at: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;

    let resp = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Release check request failed: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateInfo {
            available: false,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: String::new(),
            release_url: String::new(),
            release_notes: String::new(),
            published_at: None,
        });
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    let rel: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("Invalid release JSON: {}", e))?;

    if rel.draft || rel.prerelease {
        return Ok(UpdateInfo {
            available: false,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: rel.tag_name,
            release_url: rel.html_url,
            release_notes: rel.body.unwrap_or_default(),
            published_at: rel.published_at,
        });
    }

    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest_clean = rel.tag_name.trim_start_matches('v').to_string();
    let available = is_newer(&latest_clean, &current);

    Ok(UpdateInfo {
        available,
        current_version: current,
        latest_version: rel.tag_name,
        release_url: rel.html_url,
        release_notes: rel.name.unwrap_or_default() + "\n\n" + &rel.body.unwrap_or_default(),
        published_at: rel.published_at,
    })
}

/// `a > b` を SemVer 風の比較で判定 (suffix は無視)。
fn is_newer(a: &str, b: &str) -> bool {
    let pa = parse_semver(a);
    let pb = parse_semver(b);
    pa > pb
}

fn parse_semver(s: &str) -> (u64, u64, u64) {
    // Strip pre-release / build metadata after a '-' or '+' (e.g. "0.2.0-beta.1").
    let base = s.split(|c| c == '-' || c == '+').next().unwrap_or(s);
    let mut parts = base.split('.');
    let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compares() {
        assert!(is_newer("0.0.2", "0.0.1"));
        assert!(is_newer("0.1.0", "0.0.99"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.0.1", "0.0.1"));
        assert!(!is_newer("0.0.0", "0.0.1"));
    }

    #[test]
    fn ignores_prerelease_suffix() {
        // "0.2.0-beta.1" is parsed as 0.2.0, so equal to "0.2.0".
        assert!(!is_newer("0.2.0-beta.1", "0.2.0"));
    }
}
