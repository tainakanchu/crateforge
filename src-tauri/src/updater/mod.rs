//! GitHub Releases ベースの軽量アップデートチェック。
//!
//! `tauri-plugin-updater` を使わない単純版: 起動時に `GET /repos/.../releases/latest`
//! を叩き、`tag_name` を `Cargo.toml` のバージョンと比較する。利用可能なら
//! HTML URL とタグ名を返し、フロントが「アップデートする / あとで」ダイアログを出す。

use serde::Serialize;

const RELEASES_API: &str = "https://api.github.com/repos/tainakanchu/crateforge/releases/latest";
const USER_AGENT: &str = concat!("Crateforge/", env!("CARGO_PKG_VERSION"), " (update-check)");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub release_notes: String,
    pub published_at: Option<String>,
    /// この OS 向けの直接ダウンロード URL (見つからなければ None)。
    /// ポータブル運用なら portable zip、そうでなければインストーラを指す。
    pub download_url: Option<String>,
    /// ポータブル運用（exe の隣に portable.txt がある）か。
    pub portable: bool,
    /// 選んだ更新がインストーラ無しの exe その場差し替え（再起動のみ）か。
    pub self_replace: bool,
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
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, serde::Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// 実行ファイルの隣に `portable.txt` があればポータブル運用とみなす。
pub fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("portable.txt")))
        .map(|m| m.exists())
        .unwrap_or(false)
}

/// その URL がポータブル zip を指すか（自己差し替え対象か）。
pub fn is_portable_zip_url(url: &str) -> bool {
    let u = url.to_lowercase();
    u.ends_with("_portable.zip") || (u.contains("portable") && u.ends_with(".zip"))
}

/// リリース body に `[installer-required]` マーカーがあれば true。
/// その版は exe 単純差し替えでは不足するため、インストーラ経由に強制する安全弁
/// （将来 exe 以外の同梱物が増えた版で立てる運用）。
fn body_requires_installer(body: Option<&str>) -> bool {
    body.map(|b| b.to_lowercase().contains("[installer-required]"))
        .unwrap_or(false)
}

/// Windows 向けの資産選択（純粋関数・クロスプラットフォームでテスト可能）。
/// ポータブル運用、または installer 必須でない通常更新は `*_portable.zip` を優先
/// （= その場で exe 差し替え・インストーラ不要）。zip が無い / installer 必須なら
/// インストーラ（setup → msi → exe）にフォールバックする。
fn select_windows_asset(
    assets: &[GhAsset],
    portable: bool,
    installer_required: bool,
) -> Option<String> {
    let find = |pred: &dyn Fn(&str) -> bool| {
        assets
            .iter()
            .find(|a| pred(&a.name.to_lowercase()))
            .map(|a| a.browser_download_url.clone())
    };
    if portable || !installer_required {
        if let Some(z) = find(&|n| is_portable_zip_url(n)) {
            return Some(z);
        }
    }
    find(&|n| n.ends_with("-setup.exe") || n.contains("setup"))
        .or_else(|| find(&|n| n.ends_with(".msi")))
        .or_else(|| find(&|n| n.ends_with(".exe")))
}

/// この OS 向けのダウンロード資産を選ぶ。Windows のみ対応。
fn pick_asset(assets: &[GhAsset], portable: bool, installer_required: bool) -> Option<String> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    select_windows_asset(assets, portable, installer_required)
}

pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let portable = is_portable();
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
            download_url: None,
            portable,
            self_replace: false,
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
            download_url: None,
            portable,
            self_replace: false,
        });
    }

    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest_clean = rel.tag_name.trim_start_matches('v').to_string();
    let available = is_newer(&latest_clean, &current);
    let installer_required = body_requires_installer(rel.body.as_deref());
    let download_url = pick_asset(&rel.assets, portable, installer_required);
    let self_replace = download_url
        .as_deref()
        .map(is_portable_zip_url)
        .unwrap_or(false);

    Ok(UpdateInfo {
        available,
        current_version: current,
        latest_version: rel.tag_name,
        release_url: rel.html_url,
        release_notes: rel.name.unwrap_or_default() + "\n\n" + &rel.body.unwrap_or_default(),
        published_at: rel.published_at,
        download_url,
        portable,
        self_replace,
    })
}

/// インストーラ資産をダウンロードして一時ファイルに保存し、起動する。
/// 戻り値は保存先パス。Windows のみ対応 (download_url も Windows でしか返らない)。
pub async fn download_and_run(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download returned {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Reading download failed: {}", e))?;

    // ポータブル zip なら exe を自己差し替えして再起動する。
    if is_portable_zip_url(url) {
        #[cfg(target_os = "windows")]
        {
            return apply_portable_update(&bytes);
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err("Portable self-update is only supported on Windows".to_string());
        }
    }

    let fname = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("crateforge-setup.exe");
    let path = std::env::temp_dir().join(fname);
    std::fs::write(&path, &bytes).map_err(|e| format!("Saving installer failed: {}", e))?;

    launch_installer(&path)?;
    Ok(path.to_string_lossy().to_string())
}

/// ポータブル運用の自己アップデート。zip から `crateforge.exe` を取り出し、
/// 実行中の exe を `.old` へ退避してから差し替え、新しい exe を起動する。
/// （実行中の exe はリネーム可能。`.old` は次回起動時に掃除する。）
#[cfg(target_os = "windows")]
fn apply_portable_update(zip_bytes: &[u8]) -> Result<String, String> {
    use std::io::Read;

    let cur =
        std::env::current_exe().map_err(|e| format!("現在の実行ファイルを取得できません: {e}"))?;
    let dir = cur
        .parent()
        .ok_or("実行ファイルのフォルダを取得できません")?;

    // zip から crateforge.exe を取り出す。
    let reader = std::io::Cursor::new(zip_bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("zip を開けません: {e}"))?;
    let mut idx = None;
    for i in 0..zip.len() {
        let name = {
            let f = zip.by_index(i).map_err(|e| e.to_string())?;
            f.name().replace('\\', "/").to_lowercase()
        };
        if name.ends_with("crateforge.exe") {
            idx = Some(i);
            break;
        }
    }
    let i = idx.ok_or("zip 内に crateforge.exe が見つかりません")?;
    let mut new_bytes = Vec::new();
    zip.by_index(i)
        .map_err(|e| e.to_string())?
        .read_to_end(&mut new_bytes)
        .map_err(|e| e.to_string())?;

    let new_exe = dir.join("crateforge.new.exe");
    let old_exe = dir.join("crateforge.old.exe");
    std::fs::write(&new_exe, &new_bytes)
        .map_err(|e| format!("新しい実行ファイルの書き込みに失敗: {e}"))?;

    let _ = std::fs::remove_file(&old_exe);
    std::fs::rename(&cur, &old_exe).map_err(|e| format!("旧 exe の退避に失敗: {e}"))?;
    if let Err(e) = std::fs::rename(&new_exe, &cur) {
        // 失敗時はロールバックして整合性を保つ。
        let _ = std::fs::rename(&old_exe, &cur);
        return Err(format!("差し替えに失敗: {e}"));
    }

    // 新しい exe を起動（現プロセスは呼び出し側で終了する）。
    std::process::Command::new(&cur)
        .spawn()
        .map_err(|e| format!("再起動に失敗: {e}"))?;
    Ok(cur.to_string_lossy().to_string())
}

/// 起動時に、前回のポータブル更新で残った `crateforge.old.exe` を掃除する。
#[cfg(target_os = "windows")]
pub fn cleanup_stale() {
    if let Ok(cur) = std::env::current_exe() {
        if let Some(dir) = cur.parent() {
            let _ = std::fs::remove_file(dir.join("crateforge.old.exe"));
            let _ = std::fs::remove_file(dir.join("crateforge.new.exe"));
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn cleanup_stale() {}

#[cfg(target_os = "windows")]
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let spawn = if ext == "msi" {
        std::process::Command::new("msiexec")
            .arg("/i")
            .arg(path)
            .spawn()
    } else {
        std::process::Command::new(path).spawn()
    };
    spawn
        .map(|_| ())
        .map_err(|e| format!("Launching installer failed: {}", e))
}

#[cfg(not(target_os = "windows"))]
fn launch_installer(_path: &std::path::Path) -> Result<(), String> {
    Err("Direct install is only supported on Windows".to_string())
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

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.test/{name}"),
        }
    }

    #[test]
    fn select_prefers_portable_zip_for_installed() {
        let assets = vec![
            asset("Crateforge_0.6.3_x64-setup.exe"),
            asset("Crateforge_0.6.3_x64_portable.zip"),
            asset("Crateforge_0.6.3_x64_en-US.msi"),
        ];
        let url = select_windows_asset(&assets, false, false).unwrap();
        assert!(url.ends_with("_portable.zip"), "got {url}");
    }

    #[test]
    fn select_forces_installer_when_required() {
        let assets = vec![
            asset("Crateforge_0.6.3_x64-setup.exe"),
            asset("Crateforge_0.6.3_x64_portable.zip"),
        ];
        let url = select_windows_asset(&assets, false, true).unwrap();
        assert!(url.contains("setup"), "got {url}");
    }

    #[test]
    fn select_portable_prefers_zip_even_if_installer_required() {
        let assets = vec![
            asset("Crateforge_0.6.3_x64-setup.exe"),
            asset("Crateforge_0.6.3_x64_portable.zip"),
        ];
        let url = select_windows_asset(&assets, true, true).unwrap();
        assert!(url.ends_with("_portable.zip"), "got {url}");
    }

    #[test]
    fn select_falls_back_to_installer_when_no_zip() {
        let assets = vec![
            asset("Crateforge_0.6.3_x64-setup.exe"),
            asset("Crateforge_0.6.3_x64_en-US.msi"),
        ];
        let url = select_windows_asset(&assets, false, false).unwrap();
        assert!(url.contains("setup"), "got {url}");
    }

    #[test]
    fn body_marker_detected() {
        assert!(body_requires_installer(Some(
            "notes...\n[installer-required]\nx"
        )));
        assert!(body_requires_installer(Some("[Installer-Required]")));
        assert!(!body_requires_installer(Some("normal notes")));
        assert!(!body_requires_installer(None));
    }
}
