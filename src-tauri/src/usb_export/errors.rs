//! rbx-cli のエラーコード → 利用者向けの日本語メッセージ。
//!
//! `conflict` の理由は `details.reason` (rbx-cli 0.1.1 以降、capability
//! `usb.export.conflictReasons`。安定した snake_case の列挙で、未知の値は `other` 扱い) で
//! 判定する。メッセージ本文 (rbxport の英文) は表示・調査用にだけ使い、判定には使わない。
//! crateforge は互換性確認でこの capability を必須にしているので (`crate::rbx_cli`)、
//! `details.reason` の無い古い rbx-cli は起動前に弾かれる。

use serde::Serialize;

use super::wire::{ConflictDetails, ErrorLine, TrackInput};

/// UI に渡すエラー。`message` は日本語、`detail` は rbx-cli の原文 (調査用)。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsbExportError {
    pub code: String,
    pub message: String,
    pub detail: String,
    /// CDJ 等で USB 上のキュー / グリッドが変わったための競合
    /// (`cues_or_grid_changed_on_device`)。「CDJ の変更を優先」(`onDeviceChanges: keepDevice`)
    /// での再試行で解決できる。
    pub cue_conflict: bool,
    /// `conflict` の理由と対象の曲 (UI には平たく `reason` / `conflictTracks` として渡る。
    /// エラー型を小さく保つため箱に入れる)。
    #[serde(flatten)]
    pub conflict: Box<ConflictInfo>,
}

/// `conflict` の詳細 (表示用)。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    /// `conflict` の理由 (`details.reason`)。`conflict` 以外は None。
    pub reason: Option<String>,
    /// 競合に関係する曲 (rbx-cli が挙げた曲を crateforge の曲名に対応付けたもの)。
    pub conflict_tracks: Vec<ConflictTrackInfo>,
}

/// 競合に関係する曲 (表示用)。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictTrackInfo {
    /// リクエストの `tracks` の添字。
    pub index: usize,
    /// 曲名 (crateforge のライブラリの値。無ければファイル名)。
    pub title: String,
    pub artist: Option<String>,
    pub path: Option<String>,
}

/// `conflict` の理由 (`details.reason`)。`conflict` 以外は None、未知の値・欠落は `other`。
pub fn conflict_reason(e: &ErrorLine) -> Option<String> {
    if e.code != "conflict" {
        return None;
    }
    Some(
        ConflictDetails::from_error(e)
            .map(|d| d.reason)
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "other".to_string()),
    )
}

/// rbx-cli の `conflict` が「USB 上のキュー / グリッドが CDJ 等で変更された」ことによるもので、
/// `onDeviceChanges: keepDevice` で解決できるか。
pub fn is_cue_conflict(e: &ErrorLine) -> bool {
    conflict_reason(e).as_deref() == Some("cues_or_grid_changed_on_device")
}

fn gb(bytes: u64) -> String {
    format!("{:.2} GB", bytes as f64 / 1_000_000_000.0)
}

/// エラー行を日本語にする。
pub fn user_message(e: &ErrorLine) -> String {
    let raw = e.message.trim();
    match e.code.as_str() {
        "cancelled" => "書き出しを中止しました。USB には以前の内容がそのまま残っています。".into(),
        "conflict" => conflict_message(e),
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

/// エラー行から UI 向けのエラーを作る (曲の対応付けなし)。
#[cfg(test)]
pub fn from_error_line(e: &ErrorLine) -> UsbExportError {
    from_error_line_for(e, &[])
}

/// 「USB は変更されていません」(conflict は rbx-cli が何も書かずに止まる)。
const UNCHANGED: &str = "（USB は変更されていません）";

/// `conflict` の日本語メッセージ (`details.reason` ごと。似たものはまとめる)。
fn conflict_message(e: &ErrorLine) -> String {
    let details = ConflictDetails::from_error(e).unwrap_or_default();
    let reason = if details.reason.is_empty() {
        "other"
    } else {
        details.reason.as_str()
    };
    let name = details
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let quoted = name.map(|n| format!("「{n}」")).unwrap_or_default();
    match reason {
        "cues_or_grid_changed_on_device" => format!(
            "前回の書き出しの後に、CDJ などで USB 上のキューやビートグリッドが変更されています。今回の内容（Traktor のキュー/グリッド）で上書きするとそれが失われるため、書き出しを中止しました{UNCHANGED}。「CDJ の変更を優先」で再試行すると、変更された曲だけ USB 上のキュー/グリッドを残して書き出します。"
        ),
        "onelibrary_cues_changed_on_device" => format!(
            "前回の書き出しの後に、USB の OneLibrary（exportLibrary.db。新しい CDJ / rekordbox が使うデータベース）のキューが変更されています。上書きするとそれが失われるため、書き出しを中止しました{UNCHANGED}。この変更は「CDJ の変更を優先」でも残せません。rekordbox で USB からキューを取り込むか、別の（空の）USB に書き出してください。"
        ),
        "track_changed_on_device"
        | "playlist_changed_on_device"
        | "my_tags_changed_on_device"
        | "deleted_on_device" => {
            let what = match reason {
                "track_changed_on_device" => format!("曲{quoted}の情報が変更"),
                "playlist_changed_on_device" => format!("プレイリスト{quoted}が変更"),
                "my_tags_changed_on_device" => format!("My Tag{quoted}が変更"),
                _ => "曲やプレイリストが削除".to_string(),
            };
            format!(
                "前回の書き出しの後に、rekordbox や CDJ などで USB 上の{what}されています。上書きするとその変更が失われるため、書き出しを中止しました{UNCHANGED}。USB 上の変更を残したい場合は rekordbox で取り込んでください。不要なら、別の（空の）USB に書き出せます。"
            )
        }
        "device_only_track" | "device_only_playlist" => format!(
            "USB に、Crateforge 以外（rekordbox など）で書き出した{}{quoted}があり、今回の書き出しでそれが失われるため中止しました{UNCHANGED}。rekordbox で使っている USB とは別の USB に書き出してください。",
            if reason == "device_only_track" { "曲" } else { "プレイリスト" }
        ),
        "history_references_track" => format!(
            "USB から消そうとしている曲が、USB の再生履歴（CDJ のヒストリー）に残っているため、書き出しを中止しました{UNCHANGED}。「USB から消す」をオフにして書き出してください。"
        ),
        "source_unavailable" => format!(
            "ソースファイルが見つからない曲{quoted}が以前 USB に書き出されています（外付けドライブ未接続など）。USB 上の曲を消さないよう、書き出しを中止しました{UNCHANGED}。ドライブを接続するか、曲の場所を直してから書き出してください。"
        ),
        "ownership"
        | "identities_changed"
        | "libraries_disagree"
        | "both_roots"
        | "unreadable_library"
        | "unsupported_onelibrary"
        | "invalid_device_path"
        | "inconsistent_device_library" => {
            let why = match reason {
                "ownership" => "別のライブラリ（rekordbox など）で書き出された USB です",
                "identities_changed" => "rekordbox が USB 上の曲の ID を変更しています",
                "libraries_disagree" => {
                    "USB 上の 2 つのデータベース（export.pdb と exportLibrary.db）の内容が一致しません"
                }
                "both_roots" => "USB の PIONEER と .PIONEER の両方にライブラリがあります",
                "unreadable_library" => "USB 上のデータベースが読めないか、壊れています",
                "unsupported_onelibrary" => {
                    "USB の exportLibrary.db が対応していないバージョンです"
                }
                "invalid_device_path" => "USB 上のライブラリに不正なパスがあります",
                _ => "USB 上のプレイリストや再生履歴が、USB に無い曲を指しています",
            };
            format!(
                "{why}。このまま書き出すと USB 上の内容を壊すおそれがあるため、中止しました{UNCHANGED}。rekordbox で管理している USB なら、別の（空の）USB に書き出してください。"
            )
        }
        "device_changed_during_sync" => format!(
            "書き出し中に別のアプリが USB を変更したため、中止しました{UNCHANGED}。USB を使っている他のアプリを閉じて、もう一度書き出してください。"
        ),
        "staged_verification_failed" => format!(
            "書き込んだ内容を反映前に検証したところ一致しなかったため、中止しました{UNCHANGED}。もう一度書き出してください。繰り返す場合は USB の故障の可能性があります。"
        ),
        "inconsistent_request" => format!(
            "Crateforge が作った書き出し内容に矛盾があります（同じ曲やファイルの重複など。Crateforge の不具合の可能性があります）{UNCHANGED}。"
        ),
        _ => format!(
            "USB 上のライブラリと今回の内容が食い違っているため、書き出しを中止しました{UNCHANGED}。（{}）",
            e.message.trim()
        ),
    }
}

/// エラー行から UI 向けのエラーを作る。`tracks` はそのリクエストの曲 (競合した曲の表示に使う。
/// 分からなければ空)。
pub fn from_error_line_for(e: &ErrorLine, tracks: &[TrackInput]) -> UsbExportError {
    let details = ConflictDetails::from_error(e);
    let mut conflict_tracks: Vec<ConflictTrackInfo> = Vec::new();
    for ct in details.iter().flat_map(|d| d.tracks.iter()) {
        // 添字で引き、ref が食い違うときは ref で探し直す (どちらも無ければ出さない)。
        let by_index = tracks.get(ct.index).filter(|t| {
            ct.reference.is_none() || t.reference.as_deref() == ct.reference.as_deref()
        });
        let found = by_index.map(|t| (ct.index, t)).or_else(|| {
            let r = ct.reference.as_deref()?;
            tracks
                .iter()
                .enumerate()
                .find(|(_, t)| t.reference.as_deref() == Some(r))
        });
        let Some((index, t)) = found else {
            continue;
        };
        if conflict_tracks.iter().any(|c| c.index == index) {
            continue;
        }
        let file_name = std::path::Path::new(&t.path)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| t.path.clone());
        conflict_tracks.push(ConflictTrackInfo {
            index,
            title: t
                .title
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(file_name),
            artist: t.artist.clone(),
            path: Some(t.path.clone()).filter(|p| !p.is_empty()),
        });
    }
    UsbExportError {
        code: e.code.clone(),
        message: user_message(e),
        detail: e.message.clone(),
        cue_conflict: is_cue_conflict(e),
        conflict: Box::new(ConflictInfo {
            reason: conflict_reason(e),
            conflict_tracks,
        }),
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
        conflict: Box::default(),
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

    fn with_reason(message: &str, reason: &str) -> ErrorLine {
        let mut e = err("conflict", message);
        e.details = Some(serde_json::json!({ "reason": reason, "name": "x" }));
        e
    }

    /// rbx-cli 0.1.1 の docs/protocol.md「Conflict reasons」の表。
    const DOCUMENTED_REASONS: &[&str] = &[
        "cues_or_grid_changed_on_device",
        "onelibrary_cues_changed_on_device",
        "track_changed_on_device",
        "playlist_changed_on_device",
        "my_tags_changed_on_device",
        "deleted_on_device",
        "device_only_track",
        "device_only_playlist",
        "history_references_track",
        "source_unavailable",
        "ownership",
        "identities_changed",
        "libraries_disagree",
        "both_roots",
        "unreadable_library",
        "unsupported_onelibrary",
        "device_changed_during_sync",
        "staged_verification_failed",
        "invalid_device_path",
        "inconsistent_device_library",
        "inconsistent_request",
    ];

    #[test]
    fn conflicts_are_classified_by_details_reason_only() {
        let e = with_reason(
            "USB sync conflict: USB cues or beat grids changed since the last sync. Import the USB cues/grids before exporting.",
            "cues_or_grid_changed_on_device",
        );
        assert!(is_cue_conflict(&e));
        assert_eq!(
            conflict_reason(&e).as_deref(),
            Some("cues_or_grid_changed_on_device")
        );
        let mapped = from_error_line(&e);
        assert!(mapped.cue_conflict);
        assert!(
            mapped.message.contains("CDJ の変更を優先"),
            "{}",
            mapped.message
        );
        assert_eq!(mapped.detail, e.message);
        assert_eq!(
            mapped.conflict.reason.as_deref(),
            Some("cues_or_grid_changed_on_device")
        );

        // OneLibrary だけのキュー変更は keepDevice でも残せない → 再試行の対象外。
        let onelib = with_reason("x", "onelibrary_cues_changed_on_device");
        assert!(!is_cue_conflict(&onelib));
        assert!(user_message(&onelib).contains("でも残せません"));

        // 決まり文句そのままでも reason が無ければ判定しない (0.1.0 の文言照合は廃止)。
        let legacy = err(
            "conflict",
            "USB sync conflict: USB cues or beat grids changed since the last sync. Import the USB cues/grids before exporting.",
        );
        assert!(!is_cue_conflict(&legacy));
        assert_eq!(conflict_reason(&legacy).as_deref(), Some("other"));
        assert!(user_message(&legacy).contains("食い違って"));

        // reason が別なら文言に関係なく reason に従う。
        let e = with_reason(
            "USB sync conflict: USB cues or beat grids changed since the last sync. Import the USB cues/grids before exporting.",
            "playlist_changed_on_device",
        );
        assert!(!is_cue_conflict(&e));
        assert!(user_message(&e).contains("プレイリスト「x」が変更"));

        // 未知の reason は汎用。conflict 以外は対象外。
        let e = with_reason("raw text", "some_future_reason");
        assert_eq!(conflict_reason(&e).as_deref(), Some("some_future_reason"));
        assert!(user_message(&e).contains("食い違って"));
        assert!(user_message(&e).contains("raw text"));
        assert_eq!(conflict_reason(&err("io", "cue file")), None);
        assert!(!is_cue_conflict(&err("io", "cue file")));
    }

    #[test]
    fn every_documented_reason_has_its_own_message() {
        for reason in DOCUMENTED_REASONS {
            let m = user_message(&with_reason("raw", reason));
            assert!(!m.contains("食い違って"), "{reason} fell through: {m}");
            assert!(m.contains("USB は変更されていません"), "{reason}: {m}");
            assert_eq!(
                is_cue_conflict(&with_reason("raw", reason)),
                *reason == "cues_or_grid_changed_on_device"
            );
        }
        let source = with_reason("raw", "source_unavailable");
        assert!(user_message(&source).contains("ソースファイルが見つからない曲「x」"));
        assert!(
            user_message(&with_reason("raw", "history_references_track"))
                .contains("「USB から消す」をオフ")
        );
    }

    #[test]
    fn conflict_tracks_are_mapped_back_to_request_titles() {
        let tracks = vec![
            TrackInput {
                path: "/m/a.wav".into(),
                reference: Some("A1".into()),
                title: Some("Alpha".into()),
                artist: Some("Artist".into()),
                ..Default::default()
            },
            TrackInput {
                path: "/m/untitled.wav".into(),
                reference: Some("B2".into()),
                ..Default::default()
            },
        ];
        let mut e = err("conflict", "USB sync conflict: ...");
        e.details = Some(serde_json::json!({
            "reason": "cues_or_grid_changed_on_device",
            "tracks": [
                { "index": 0, "ref": "A1", "deviceId": 3 },
                { "index": 5, "ref": "B2", "deviceId": null },
                { "index": 0, "ref": "A1" },
                { "index": 9, "ref": "nope" }
            ]
        }));
        let mapped = from_error_line_for(&e, &tracks);
        assert!(mapped.cue_conflict);
        assert_eq!(
            mapped.conflict.conflict_tracks,
            vec![
                ConflictTrackInfo {
                    index: 0,
                    title: "Alpha".into(),
                    artist: Some("Artist".into()),
                    path: Some("/m/a.wav".into()),
                },
                // 添字が合わなくても ref で引ける。曲名が無ければファイル名。
                ConflictTrackInfo {
                    index: 1,
                    title: "untitled.wav".into(),
                    artist: None,
                    path: Some("/m/untitled.wav".into()),
                },
            ]
        );
        // details が無い / 曲が分からなければ空。
        assert!(from_error_line(&e).conflict.conflict_tracks.is_empty());
        assert!(from_error_line_for(&err("io", "x"), &tracks)
            .conflict
            .conflict_tracks
            .is_empty());
        // UI へは平たく渡る。
        let v = serde_json::to_value(&mapped).unwrap();
        assert_eq!(v["reason"], "cues_or_grid_changed_on_device");
        assert_eq!(v["cueConflict"], true);
        assert_eq!(v["conflictTracks"][0]["title"], "Alpha");
        assert_eq!(v["conflictTracks"][1]["artist"], serde_json::Value::Null);
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
