//! rbx-cli とやり取りする JSON の型 (crateforge 側の独自定義)。
//!
//! rbx-cli の公開プロトコル (`docs/protocol.md` / `schema/*.json`, protocol 1) の
//! **ドキュメントから** 書き起こした型で、rbx-cli のソースや型は一切取り込んでいない
//! (rbx-cli は GPL の別プロセスとして起動するだけ。`crate::rbx_cli` の冒頭を参照)。
//!
//! - リクエスト (`usb export --input`) は「送るものだけ」を書く: `None` は省略する。
//!   特に `cues` / `beatGrid` は **省略と空配列で意味が違う** (省略 = USB 上の既存キューを保持)。
//! - 結果・NDJSON 行は前方互換のため寛容に読む (未知フィールドは無視、欠落は既定値)。

use serde::{Deserialize, Serialize};

/// crateforge が話せる rbx-cli のプロトコル番号。`version --json` の `protocol` と一致を要求する。
pub const PROTOCOL_VERSION: u32 = 1;

// ============================================================ request

/// `usb export` のリクエスト。USB に「あるべき状態」全体を表す (エクスポート = 同期)。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub protocol: u32,
    pub options: ExportOptions,
    pub tracks: Vec<TrackInput>,
    pub playlists: Vec<PlaylistInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// `missing`: キャッシュ → USB 上の既存解析 → 生成 の順で使う。
    pub analyze: String,
    pub read_tags: bool,
    pub embedded_artwork: bool,
    pub prune: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// CDJ 等で USB 上のキュー / グリッドが前回の同期後に変わった曲の扱い
    /// (rbx-cli 0.1.1 / capability `usb.export.keepDeviceChanges`)。None なら省略 (= `fail`)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_device_changes: Option<OnDeviceChanges>,
}

/// `options.onDeviceChanges`。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OnDeviceChanges {
    /// 競合 (`cues_or_grid_changed_on_device`) で書き出しを中止する (rbx-cli の既定。
    /// crateforge は送らずに省略する)。
    #[cfg_attr(not(test), allow(dead_code))]
    Fail,
    /// その曲は USB 上のキュー / グリッドを残し、リクエストの `cues` / `beatGrid` を無視する
    /// (その 1 回の同期だけ。次の同期ではリクエストの内容が再び書かれる)。
    KeepDevice,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackInput {
    pub path: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_added: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_number: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc_number: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beat_grid: Option<BeatGridInput>,
    /// `None` = フィールド省略 (USB 上のキューを保持)。`Some(vec![])` = 全消去。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cues: Option<Vec<CueInput>>,
}

/// テンポアンカー列のビートグリッド (`anchors` 形式のみ使う)。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeatGridInput {
    pub anchors: Vec<BeatAnchor>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeatAnchor {
    pub time_ms: f64,
    pub bpm: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CueKind {
    Hot,
    Memory,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CueInput {
    #[serde(rename = "type")]
    pub kind: CueKind,
    /// ホットキューのスロット `A`〜。メモリーキューは None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    pub time_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loop_end_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInput {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub folder: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<PlaylistInput>,
    /// トラックの `ref`。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tracks: Vec<String>,
}

// ============================================================ NDJSON envelopes

/// `--json` の 1 行。未知の `type` は `Unknown`。
#[derive(Debug, Clone, PartialEq)]
pub enum Envelope {
    Progress(Progress),
    Event(EventLine),
    Log(LogLine),
    Result(serde_json::Value),
    Error(ErrorLine),
    Unknown,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Progress {
    pub phase: String,
    pub current: u64,
    pub total: u64,
    pub item: Option<ProgressItem>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProgressItem {
    pub index: Option<usize>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EventLine {
    pub event: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LogLine {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ErrorLine {
    pub code: String,
    pub message: String,
    pub exit_code: i32,
    pub details: Option<serde_json::Value>,
}

/// NDJSON の 1 行を読む。JSON でない行・`type` の無い行は None (読み飛ばす)。
pub fn parse_line(line: &str) -> Option<Envelope> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let kind = value.get("type")?.as_str()?.to_string();
    let env = match kind.as_str() {
        "progress" => Envelope::Progress(serde_json::from_value(value).ok()?),
        "event" => Envelope::Event(serde_json::from_value(value).ok()?),
        "log" => Envelope::Log(serde_json::from_value(value).ok()?),
        "result" => Envelope::Result(value.get("data").cloned().unwrap_or_default()),
        "error" => Envelope::Error(serde_json::from_value(value).ok()?),
        _ => Envelope::Unknown,
    };
    Some(env)
}

// ============================================================ results

/// `version --json` の結果。
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VersionInfo {
    pub name: String,
    pub version: String,
    pub protocol: u32,
    pub rbxport_rev: String,
    pub capabilities: Vec<String>,
    pub target: String,
}

/// `devices list --json` の 1 デバイス。
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceInfo {
    pub name: String,
    pub mount_point: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub file_system: String,
    pub removable: bool,
    pub volume_id: String,
    pub export: Option<DeviceExport>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceExport {
    pub tracks: u64,
    pub playlists: u64,
    pub ours: bool,
    pub written: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DevicesResult {
    pub devices: Vec<DeviceInfo>,
}

/// `usb export` の結果 (dry-run でも同形)。UI に必要な分だけ読む。
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportResult {
    pub destination: String,
    pub root: String,
    pub dry_run: bool,
    pub tracks: TrackCounts,
    pub playlists: PlaylistCounts,
    pub analysis: AnalysisCounts,
    pub bytes: ByteCounts,
    pub verified: Option<bool>,
    pub timings: Timings,
    pub items: Vec<TrackResult>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackCounts {
    pub requested: u64,
    pub exported: u64,
    pub copied: u64,
    pub reused: u64,
    pub skipped: u64,
    pub removed: u64,
    pub kept: u64,
    /// `keepDevice` で USB 上のキュー / グリッドを残した曲 (dry-run では残す見込みの曲)。
    pub device_changes_kept: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaylistCounts {
    pub written: u64,
    pub added: u64,
    pub removed: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AnalysisCounts {
    pub generated: u64,
    pub cache_hits: u64,
    pub device_reuse: u64,
    pub supplied: u64,
    pub none: u64,
    pub failed: u64,
    pub cache_misses: u64,
    pub grid_overrides: u64,
    pub cue_overrides: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ByteCounts {
    pub copied: u64,
    pub reused: u64,
    pub to_copy: u64,
    pub free: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Timings {
    pub plan_ms: u64,
    pub analyze_ms: u64,
    pub export_ms: u64,
    pub verify_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackResult {
    pub index: usize,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub title: String,
    pub status: String,
    pub analysis: String,
    /// dry-run のみ: `copy` / `reuse`。
    pub audio: Option<String>,
    /// `keepDevice` で USB 上のキュー / グリッドを残した (dry-run では残す見込み)。
    pub device_changes_kept: bool,
    /// USB 上の解析ファイルのフォルダ (`/PIONEER/USBANLZ/...`)。
    pub analysis_dir: Option<String>,
    pub warnings: Vec<String>,
}

// ============================================================ conflict details

/// `conflict` エラーの `details` (rbx-cli 0.1.1 / capability `usb.export.conflictReasons`)。
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConflictDetails {
    /// 安定した snake_case の理由。未知の値は `other` と同じに扱う。
    pub reason: String,
    /// `deviceLibrary` (`export.pdb`) / `oneLibrary` (`exportLibrary.db`)。
    pub database: Option<String>,
    /// rbxport が名前を挙げた曲名 / プレイリスト名 / My Tag 名。
    pub name: Option<String>,
    pub device_track_id: Option<u64>,
    /// 関係するリクエストの曲 (分かるときだけ)。
    pub tracks: Vec<ConflictTrack>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConflictTrack {
    /// リクエストの `tracks` の添字。
    pub index: usize,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub device_id: Option<u64>,
}

impl ConflictDetails {
    /// エラー行の `details` を読む (`conflict` 以外・読めないときは None)。
    pub fn from_error(e: &ErrorLine) -> Option<Self> {
        if e.code != "conflict" {
            return None;
        }
        e.details
            .as_ref()
            .and_then(|d| serde_json::from_value(d.clone()).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_omits_absent_cues_but_keeps_empty_ones() {
        let absent = TrackInput {
            path: "/m/a.mp3".into(),
            ..Default::default()
        };
        let v = serde_json::to_value(&absent).unwrap();
        assert_eq!(v, serde_json::json!({ "path": "/m/a.mp3" }));

        let empty = TrackInput {
            path: "/m/a.mp3".into(),
            reference: Some("r1".into()),
            cues: Some(vec![]),
            ..Default::default()
        };
        let v = serde_json::to_value(&empty).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "path": "/m/a.mp3", "ref": "r1", "cues": [] })
        );
    }

    #[test]
    fn request_fields_are_camel_case() {
        let t = TrackInput {
            path: "/m/a.mp3".into(),
            duration_sec: Some(300),
            track_number: Some(2),
            beat_grid: Some(BeatGridInput {
                anchors: vec![BeatAnchor {
                    time_ms: 12.5,
                    bpm: 128.0,
                }],
            }),
            cues: Some(vec![CueInput {
                kind: CueKind::Hot,
                slot: Some("A".into()),
                time_ms: 100.0,
                loop_end_ms: Some(200.0),
                comment: None,
            }]),
            ..Default::default()
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "path": "/m/a.mp3",
                "durationSec": 300,
                "trackNumber": 2,
                "beatGrid": { "anchors": [ { "timeMs": 12.5, "bpm": 128.0 } ] },
                "cues": [ { "type": "hot", "slot": "A", "timeMs": 100.0, "loopEndMs": 200.0 } ]
            })
        );
        let p = PlaylistInput {
            name: "F".into(),
            id: Some(7),
            folder: true,
            children: vec![PlaylistInput {
                name: "P".into(),
                id: None,
                folder: false,
                children: vec![],
                tracks: vec!["r1".into()],
            }],
            tracks: vec![],
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({ "name": "F", "id": 7, "folder": true,
                                "children": [ { "name": "P", "tracks": ["r1"] } ] })
        );
    }

    #[test]
    fn parses_each_envelope_type() {
        let p = parse_line(r#"{"type":"progress","protocol":1,"command":"usb.export","phase":"analyze","current":3,"total":12,"item":{"index":2,"ref":"t3","title":"Track Three"}}"#).unwrap();
        assert_eq!(
            p,
            Envelope::Progress(Progress {
                phase: "analyze".into(),
                current: 3,
                total: 12,
                item: Some(ProgressItem {
                    index: Some(2),
                    reference: Some("t3".into()),
                    title: "Track Three".into()
                })
            })
        );
        let e = parse_line(r#"{"type":"event","protocol":1,"command":"usb.export","event":"track.skipped","data":{"index":5,"ref":null,"path":"/music/gone.mp3","reason":"missing"}}"#).unwrap();
        match e {
            Envelope::Event(ev) => {
                assert_eq!(ev.event, "track.skipped");
                assert_eq!(ev.data["path"], "/music/gone.mp3");
            }
            other => panic!("unexpected {other:?}"),
        }
        let l =
            parse_line(r#"{"type":"log","protocol":1,"level":"warn","message":"m","target":"x"}"#)
                .unwrap();
        assert_eq!(
            l,
            Envelope::Log(LogLine {
                level: "warn".into(),
                message: "m".into()
            })
        );
        let r = parse_line(r#"{"type":"result","protocol":1,"command":"version","data":{"protocol":1,"version":"0.1.0"}}"#).unwrap();
        match r {
            Envelope::Result(data) => {
                let v: VersionInfo = serde_json::from_value(data).unwrap();
                assert_eq!(v.protocol, 1);
                assert_eq!(v.version, "0.1.0");
            }
            other => panic!("unexpected {other:?}"),
        }
        let err = parse_line(r#"{"type":"error","protocol":1,"command":"usb.export","code":"insufficient_space","message":"no room","exitCode":1,"details":{"freeBytes":10,"bytesToCopy":20}}"#).unwrap();
        match err {
            Envelope::Error(e) => {
                assert_eq!(e.code, "insufficient_space");
                assert_eq!(e.exit_code, 1);
                assert_eq!(e.details.unwrap()["bytesToCopy"], 20);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn ignores_garbage_and_unknown_types() {
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line("not json"), None);
        assert_eq!(parse_line(r#"{"no":"type"}"#), None);
        assert_eq!(
            parse_line(r#"{"type":"heartbeat","protocol":1}"#),
            Some(Envelope::Unknown)
        );
    }

    #[test]
    fn export_result_reads_leniently() {
        let data = serde_json::json!({
            "destination": "/Volumes/STICK", "root": "PIONEER", "dryRun": true,
            "tracks": { "requested": 2, "exported": 0, "copied": 0, "reused": 0, "skipped": 1, "removed": 0, "kept": 0 },
            "playlists": { "written": 0, "added": 0, "removed": 0 },
            "analysis": { "generated": 0, "cacheHits": 1, "deviceReuse": 0, "supplied": 0, "none": 0,
                          "failed": 0, "cacheMisses": 1, "gridOverrides": 0, "cueOverrides": 0 },
            "bytes": { "copied": 0, "reused": 0, "toCopy": 1000, "free": null },
            "items": [ { "index": 0, "ref": "a", "title": "A", "status": "planned", "analysis": "generate",
                         "audio": "copy", "gridOverride": false, "cuesOverride": false, "artwork": false,
                         "warnings": [], "someFutureField": 1 } ],
            "futureTopLevel": true
        });
        let r: ExportResult = serde_json::from_value(data).unwrap();
        assert!(r.dry_run);
        assert_eq!(r.tracks.skipped, 1);
        assert_eq!(r.analysis.cache_hits, 1);
        assert_eq!(r.bytes.to_copy, 1000);
        assert_eq!(r.bytes.free, None);
        assert_eq!(r.items[0].audio.as_deref(), Some("copy"));
        // 0.1.1 より前の結果 (deviceChangesKept 無し) も読める。
        assert_eq!(r.tracks.device_changes_kept, 0);
        assert!(!r.items[0].device_changes_kept);
    }

    #[test]
    fn keep_device_results_and_option_round_trip() {
        let data = serde_json::json!({
            "tracks": { "requested": 2, "exported": 2, "deviceChangesKept": 1 },
            "items": [
                { "index": 0, "ref": "a", "title": "A", "status": "exported", "analysis": "cache",
                  "deviceChangesKept": true, "analysisDir": "/PIONEER/USBANLZ/P051/0001470B",
                  "warnings": ["cues ignored: ..."] },
                { "index": 1, "ref": "b", "title": "B", "status": "exported", "analysis": "cache",
                  "deviceChangesKept": false, "warnings": [] }
            ]
        });
        let r: ExportResult = serde_json::from_value(data).unwrap();
        assert_eq!(r.tracks.device_changes_kept, 1);
        assert!(r.items[0].device_changes_kept);
        assert_eq!(
            r.items[0].analysis_dir.as_deref(),
            Some("/PIONEER/USBANLZ/P051/0001470B")
        );
        assert!(!r.items[1].device_changes_kept);
        // UI へはそのまま camelCase で渡る。
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["tracks"]["deviceChangesKept"], 1);
        assert_eq!(v["items"][0]["deviceChangesKept"], true);

        let opts = ExportOptions {
            analyze: "missing".into(),
            read_tags: true,
            embedded_artwork: true,
            prune: true,
            device_name: None,
            on_device_changes: Some(OnDeviceChanges::KeepDevice),
        };
        assert_eq!(
            serde_json::to_value(&opts).unwrap()["onDeviceChanges"],
            "keepDevice"
        );
        assert_eq!(serde_json::to_value(OnDeviceChanges::Fail).unwrap(), "fail");
    }

    #[test]
    fn conflict_details_are_read_from_error_lines() {
        let line = r#"{"type":"error","protocol":1,"command":"usb.export","code":"conflict","message":"USB sync conflict: x","exitCode":1,"details":{"reason":"cues_or_grid_changed_on_device","tracks":[{"index":0,"ref":"a","deviceId":7},{"index":2,"ref":null,"deviceId":null}],"futureField":1}}"#;
        let Some(Envelope::Error(e)) = parse_line(line) else {
            panic!("not an error line");
        };
        let d = ConflictDetails::from_error(&e).unwrap();
        assert_eq!(d.reason, "cues_or_grid_changed_on_device");
        assert_eq!(d.tracks.len(), 2);
        assert_eq!(d.tracks[0].reference.as_deref(), Some("a"));
        assert_eq!(d.tracks[0].device_id, Some(7));
        assert_eq!(d.tracks[1].index, 2);
        assert_eq!(d.tracks[1].reference, None);

        let named = ErrorLine {
            code: "conflict".into(),
            details: Some(serde_json::json!({
                "reason": "track_changed_on_device", "database": "oneLibrary",
                "name": "Song", "deviceTrackId": 12, "tracks": []
            })),
            ..Default::default()
        };
        let d = ConflictDetails::from_error(&named).unwrap();
        assert_eq!(d.database.as_deref(), Some("oneLibrary"));
        assert_eq!(d.name.as_deref(), Some("Song"));
        assert_eq!(d.device_track_id, Some(12));
        // conflict 以外は対象外。
        let other = ErrorLine {
            code: "io".into(),
            details: Some(serde_json::json!({ "reason": "x" })),
            ..Default::default()
        };
        assert_eq!(ConflictDetails::from_error(&other), None);
    }
}
