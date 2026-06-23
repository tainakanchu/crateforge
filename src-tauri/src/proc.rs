//! 子プロセス起動の共通ヘルパ。
//!
//! Windows で外部 CLI (ffmpeg / flac / lame / cdparanoia 等) を起動すると、
//! GUI アプリでも一瞬の空コンソール窓 (黒い窓) が点滅してしまう。
//! `CREATE_NO_WINDOW` (0x0800_0000) を creation_flags に立てることでこれを抑止する。
//! Windows 以外では何もしない (no-op)。
//!
//! `std::process::Command` と `tokio::process::Command` の両方を扱えるよう
//! 2 つのヘルパを用意する (どちらも `creation_flags` を持つ)。

/// `std::process::Command` にコンソール窓非表示フラグを立てる (Windows のみ)。
#[cfg(target_os = "windows")]
pub fn no_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

/// non-Windows では何もしない。
#[cfg(not(target_os = "windows"))]
pub fn no_window(_cmd: &mut std::process::Command) {}

/// `tokio::process::Command` にコンソール窓非表示フラグを立てる (Windows のみ)。
#[cfg(target_os = "windows")]
pub fn no_window_tokio(cmd: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

/// non-Windows では何もしない。
#[cfg(not(target_os = "windows"))]
pub fn no_window_tokio(_cmd: &mut tokio::process::Command) {}
