//! 接続されている CD ドライブの列挙。
//!
//! Windows は `win_cd.rs` と同じ方針で、追加 crate を入れず `kernel32` を生 FFI で呼ぶ
//! (`GetLogicalDrives` + `GetDriveTypeW == DRIVE_CDROM`)。
//! どのプラットフォームでも panic せず、失敗時は空 Vec を返す。

/// `GetLogicalDrives` のビットマスク (bit0 = A:, bit1 = B: ...) を `"A:"` 形式の
/// ドライブ名リストに変換する。プラットフォーム非依存の純関数 (テスト用に分離)。
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn drive_letters_from_mask(mask: u32) -> Vec<String> {
    (0u8..26)
        .filter(|i| mask & (1u32 << i) != 0)
        .map(|i| format!("{}:", (b'A' + i) as char))
        .collect()
}

#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(lp_root_path_name: *const u16) -> u32;
    }

    const DRIVE_CDROM: u32 = 5;

    pub fn list() -> Vec<String> {
        // SAFETY: 引数なし、戻り値はビットマスク (失敗時 0)。
        let mask = unsafe { GetLogicalDrives() };
        super::drive_letters_from_mask(mask)
            .into_iter()
            .filter(|drive| {
                // ルートパスは "E:\" 形式の NUL 終端ワイド文字列で渡す。
                let root = format!("{}\\", drive);
                let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                // SAFETY: wide は NUL 終端済みで、呼び出し中は生存している。
                let ty = unsafe { GetDriveTypeW(wide.as_ptr()) };
                ty == DRIVE_CDROM
            })
            .collect()
    }
}

/// CD ドライブとして使えそうなデバイス名を返す。
/// - Windows: `["E:"]` のようなドライブ文字
/// - Linux: 存在する `/dev/sr*` と `/dev/cdrom`
/// - macOS: 既定の `"disk1"` (従来挙動)
pub fn list_cd_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        win::list()
    }
    #[cfg(target_os = "linux")]
    {
        let mut out: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/dev") {
            let mut srs: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| {
                    name.strip_prefix("sr")
                        .map(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
                        .unwrap_or(false)
                })
                .map(|name| format!("/dev/{}", name))
                .collect();
            srs.sort();
            out.extend(srs);
        }
        if std::path::Path::new("/dev/cdrom").exists() {
            out.push("/dev/cdrom".to_string());
        }
        out
    }
    #[cfg(target_os = "macos")]
    {
        vec!["disk1".to_string()]
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::drive_letters_from_mask;

    #[test]
    fn mask_to_letters() {
        assert!(drive_letters_from_mask(0).is_empty());
        assert_eq!(drive_letters_from_mask(0b1), vec!["A:"]);
        // C: (bit2) と E: (bit4)
        assert_eq!(drive_letters_from_mask(0b10100), vec!["C:", "E:"]);
        // 26 ビットより上は無視する
        assert_eq!(drive_letters_from_mask(1 << 25 | 1 << 26 | 1 << 31), vec!["Z:"]);
    }
}
