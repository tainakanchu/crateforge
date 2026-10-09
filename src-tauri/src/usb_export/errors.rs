//! rbx-cli のエラーコード → 利用者向けの日本語メッセージ。
//!
//! `conflict` は理由がメッセージ文字列にしか無い (rbx-cli protocol 1 には `details.reason`
//! のような構造化された区別が無い) ため、キュー / グリッドの競合だけは英文の決まり文句で
//! 判定する。判定できなくても汎用の競合メッセージになるだけで安全側。

use serde::Serialize;

use super::wire::ErrorLine;

/// UI に渡すエラー。`message` は日本語、`detail` は rbx-cli の原文 (調査用)。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsbExportError {
    pub code: String,
    pub message: String,
    pub detail: String,
    /// CDJ 等で USB 上のキュー / グリッドが変わったための競合か
    /// (「USB 上のキューを優先」で再試行を提案する)。
    pub cue_conflict: bool,
}

/// rbx-cli の `conflict` が「USB 上のキュー / グリッドが変更された」ことによるものか。
pub fn is_cue_conflict(e: &ErrorLine) -> bool {
    if e.code != "conflict" {
        return false;
    }
    let m = e.message.to_ascii_lowercase();
    (m.contains("cue") || m.contains("beat grid")) && !m.contains("source unavailable")
}

fn gb(bytes: u64) -> String {
    format!("{:.2} GB", bytes as f64 / 1_000_000_000.0)
}

/// エラー行を日本語にする。
pub fn user_message(e: &ErrorLine) -> String {
    let raw = e.message.trim();
    match e.code.as_str() {
        "cancelled" => "書き出しを中止しました。USB には以前の内容がそのまま残っています。".into(),
        "conflict" if is_cue_conflict(e) => {
            "前回の書き出しの後に、CDJ などで USB 上のキューやビートグリッドが変更されています。\
             Traktor のキューで上書きするとそれが失われるため、書き出しを中止しました（USB は変更されていません）。"
                .into()
        }
        "conflict" if raw.to_ascii_lowercase().contains("source unavailable") => format!(
            "ソースファイルが見つからない曲が以前 USB に書き出されています（外付けドライブ未接続など）。USB 上の曲を消さないよう、書き出しを中止しました（USB は変更されていません）。ドライブを接続するか、曲の場所を直してから書き出してください。（{raw}）"
        ),
        "conflict" => format!(
            "USB 上のライブラリと今回の内容が食い違っているため、書き出しを中止しました（USB は変更されていません）。（{raw}）"
        ),
        "insufficient_space" => {
            let details = e.details.as_ref();
            let free = details.and_then(|d| d.get("freeBytes")).and_then(|v| v.as_u64());
            let need = details.and_then(|d| d.get("bytesToCopy")).and_then(|v| v.as_u64());
            match (free, need) {
                (Some(f), Some(n)) => format!(
                    "USB の空き容量が足りません（空き {} / 必要 約 {}）。曲を減らすか、空きのある USB を使ってください。",
                    gb(f),
                    gb(n)
                ),
                _ => "USB の空き容量が足りません。曲を減らすか、空きのある USB を使ってください。".into(),
            }
        }
        "verification_failed" => {
            "書き込んだ内容の検証に失敗しました。USB を挿し直してもう一度書き出してください。繰り返す場合は USB の故障の可能性があります。"
                .into()
        }
        "device_gone" => {
            "書き込み中に USB が取り外されました。挿し直してもう一度書き出してください（以前の内容は次回の書き出しで復旧されます）。"
                .into()
        }
        "rekordbox_running" => {
            "rekordbox が起動しています。同じ USB に書き込む可能性があるため、rekordbox を終了してから書き出してください。"
                .into()
        }
        "not_found" => format!("書き出し先またはファイルが見つかりません。（{raw}）"),
        "unsupported" => {
            "rbx-cli のバージョンが古く、このリクエストを処理できません。設定から rbx-cli を更新してください。".into()
        }
        "invalid_request" | "usage" => format!(
            "rbx-cli へのリクエストが不正です（Crateforge の不具合の可能性があります）。（{raw}）"
        ),
        "io" => format!("読み書きでエラーが発生しました。（{raw}）"),
        "internal" => format!("rbx-cli の内部エラーです。（{raw}）"),
        other => format!("書き出しに失敗しました [{other}]。（{raw}）"),
    }
}

/// エラー行から UI 向けのエラーを作る。
pub fn from_error_line(e: &ErrorLine) -> UsbExportError {
    UsbExportError {
        code: e.code.clone(),
        message: user_message(e),
        detail: e.message.clone(),
        cue_conflict: is_cue_conflict(e),
    }
}

/// rbx-cli 以外 (起動失敗・異常終了・リクエスト作成失敗など) のエラー。
pub fn local(code: &str, message: impl Into<String>) -> UsbExportError {
    let message = message.into();
    UsbExportError {
        code: code.to_string(),
        detail: message.clone(),
        message,
        cue_conflict: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(code: &str, message: &str) -> ErrorLine {
        ErrorLine {
            code: code.into(),
            message: message.into(),
            exit_code: 1,
            details: None,
        }
    }

    #[test]
    fn cue_conflicts_are_recognised() {
        let e = err(
            "conflict",
            "USB sync conflict: USB cues or beat grids changed since the last sync. Import the USB cues/grids before exporting.",
        );
        assert!(is_cue_conflict(&e));
        let mapped = from_error_line(&e);
        assert!(mapped.cue_conflict);
        assert!(mapped.message.contains("CDJ"));
        assert_eq!(mapped.detail, e.message);

        let onelib = err(
            "conflict",
            "USB sync conflict: OneLibrary contains cue records that this export would replace. Import the cues in rekordbox first.",
        );
        assert!(is_cue_conflict(&onelib));

        let source = err(
            "conflict",
            "USB sync conflict: Source unavailable for 'Cue Song'. Reconnect or relocate it before syncing; the USB has not been changed.",
        );
        assert!(!is_cue_conflict(&source));
        assert!(user_message(&source)
            .contains("ソースファイルが見つからない曲が以前 USB に書き出されています"));

        let other = err(
            "conflict",
            "USB sync conflict: Both PIONEER and .PIONEER contain libraries.",
        );
        assert!(!is_cue_conflict(&other));
        assert!(user_message(&other).contains("食い違って"));
        // conflict 以外は cue_conflict にならない。
        assert!(!is_cue_conflict(&err("io", "cue file")));
    }

    #[test]
    fn every_documented_code_has_a_japanese_message() {
        for code in [
            "usage",
            "invalid_request",
            "unsupported",
            "not_found",
            "conflict",
            "device_gone",
            "rekordbox_running",
            "insufficient_space",
            "verification_failed",
            "cancelled",
            "io",
            "internal",
        ] {
            let m = user_message(&err(code, "raw"));
            assert!(!m.is_empty());
            assert!(
                !m.starts_with("書き出しに失敗しました ["),
                "{code} fell through: {m}"
            );
        }
        assert!(user_message(&err("brand_new_code", "raw")).contains("brand_new_code"));
        assert!(user_message(&err("cancelled", "")).contains("中止"));
    }

    #[test]
    fn insufficient_space_reports_sizes() {
        let mut e = err("insufficient_space", "no room");
        e.details = Some(
            serde_json::json!({ "freeBytes": 1_000_000_000u64, "bytesToCopy": 2_500_000_000u64 }),
        );
        let m = user_message(&e);
        assert!(m.contains("1.00 GB") && m.contains("2.50 GB"), "{m}");
        e.details = None;
        assert!(user_message(&e).contains("空き容量"));
    }
}
