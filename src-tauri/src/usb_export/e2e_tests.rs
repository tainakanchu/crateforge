//! 実物の rbx-cli を使う結合テスト (既定では実行しない)。
//!
//! ```sh
//! RBX_CLI_BIN=/path/to/rbx-cli cargo test -- --ignored usb_export::e2e
//! ```
//!
//! インメモリ DB + 生成した WAV + 生成した collection.nml から `build_request` でリクエストを
//! 作り、rbx-cli の dry-run → 書き出し → `usb inspect --cues` → 2 回目の書き出し (再利用) →
//! 中止 (`cancel` 行) までを、crateforge と同じ NDJSON パーサで確認する。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::request::{build_request, TraktorInput, UsbExportOptions};
use super::wire::{self, Envelope, ExportResult};
use super::{envelope_to_event, JobKind, UsbExportProgress};
use crate::db::Database;
use crate::traktor_nml::{self, path::PathStyle, NmlIndex};

fn args(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

fn rbx_cli() -> Option<PathBuf> {
    std::env::var_os("RBX_CLI_BIN").map(PathBuf::from)
}

/// 44.1 kHz / 16 bit / mono の WAV。`bpm` ごとにクリックを入れる (解析が拍を拾えるように)。
fn write_wav(path: &Path, seconds: u32, bpm: f64) {
    let rate = 44_100u32;
    let n = rate * seconds;
    let period = (60.0 / bpm * rate as f64) as u32;
    let mut data = Vec::with_capacity(n as usize * 2);
    for i in 0..n {
        let t = i as f64 / rate as f64;
        let in_click = i % period < 600;
        let s = if in_click {
            (t * 2.0 * std::f64::consts::PI * 60.0).sin() * 0.9
        } else {
            (t * 2.0 * std::f64::consts::PI * 440.0).sin() * 0.05
        };
        data.extend_from_slice(&((s * i16::MAX as f64) as i16).to_le_bytes());
    }
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(b"RIFF").unwrap();
    f.write_all(&(36 + data.len() as u32).to_le_bytes())
        .unwrap();
    f.write_all(b"WAVEfmt ").unwrap();
    f.write_all(&16u32.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
    f.write_all(&1u16.to_le_bytes()).unwrap(); // mono
    f.write_all(&rate.to_le_bytes()).unwrap();
    f.write_all(&(rate * 2).to_le_bytes()).unwrap();
    f.write_all(&2u16.to_le_bytes()).unwrap();
    f.write_all(&16u16.to_le_bytes()).unwrap();
    f.write_all(b"data").unwrap();
    f.write_all(&(data.len() as u32).to_le_bytes()).unwrap();
    f.write_all(&data).unwrap();
}

/// rbx-cli を実行し、NDJSON を crateforge のパーサで読む。
fn run(
    exe: &Path,
    args: &[&str],
    cancel_after_first_progress: bool,
) -> (
    Vec<UsbExportProgress>,
    Result<serde_json::Value, wire::ErrorLine>,
) {
    let mut child = Command::new(exe)
        .arg("--json")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let mut events = Vec::new();
    let mut terminal = None;
    use std::io::BufRead;
    for line in std::io::BufReader::new(stdout).lines() {
        let line = line.unwrap();
        match wire::parse_line(&line) {
            Some(Envelope::Result(d)) => terminal = Some(Ok(d)),
            Some(Envelope::Error(e)) => terminal = Some(Err(e)),
            Some(other) => {
                if let Some(ev) = envelope_to_event(&other, JobKind::Export) {
                    if cancel_after_first_progress && matches!(ev, UsbExportProgress::Phase { .. })
                    {
                        if let Some(s) = stdin.as_mut() {
                            let _ = s.write_all(b"cancel\n");
                            let _ = s.flush();
                        }
                    }
                    events.push(ev);
                }
            }
            None => {}
        }
    }
    drop(stdin);
    child.wait().unwrap();
    (events, terminal.expect("rbx-cli wrote no terminal line"))
}

#[test]
#[ignore = "needs RBX_CLI_BIN pointing at an rbx-cli binary"]
fn e2e_dry_run_export_inspect_resync_and_cancel() {
    let Some(exe) = rbx_cli() else {
        eprintln!("RBX_CLI_BIN not set; skipping");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let music = tmp.path().join("music");
    let stick = tmp.path().join("stick");
    std::fs::create_dir_all(&music).unwrap();
    std::fs::create_dir_all(&stick).unwrap();
    let a = music.join("alpha.wav");
    let b = music.join("bravo.wav");
    write_wav(&a, 20, 120.0);
    write_wav(&b, 20, 128.0);

    let db = Database::open_memory().unwrap();
    let add = |name: &str, p: &Path| {
        db.add_imported_track(
            Some(name),
            Some("Generated"),
            None,
            Some("E2E"),
            Some("Test"),
            Some(2026),
            Some(1),
            None,
            None,
            None,
            Some(20_000),
            &p.to_string_lossy(),
            &format!("file://{}", p.display()),
        )
        .unwrap()
    };
    let ta = add("Alpha", &a);
    let tb = add("Bravo", &b);
    db.set_rating(ta, 80).unwrap();
    let folder = db.create_playlist("E2E Folder", None, true).unwrap();
    let pl = db
        .create_playlist("Set", folder.persistent_id.as_deref(), false)
        .unwrap();
    db.add_tracks_to_playlist(pl.playlist_id, &[ta, tb, ta])
        .unwrap();

    // Alpha だけ Traktor にキュー / グリッドがある NML。
    let dir_nml = |p: &Path| {
        let parent = p.parent().unwrap();
        let mut d = String::new();
        for c in parent.components().skip(1) {
            d.push_str("/:");
            d.push_str(&c.as_os_str().to_string_lossy());
        }
        d.push_str("/:");
        d
    };
    let nml_text = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><COLLECTION ENTRIES="1">
<ENTRY TITLE="Alpha"><LOCATION DIR="{}" FILE="alpha.wav" VOLUME=""></LOCATION>
<TEMPO BPM="120.000000"></TEMPO>
<CUE_V2 NAME="AutoGrid" TYPE="4" START="0.000" LEN="0" HOTCUE="0"></CUE_V2>
<CUE_V2 NAME="Drop" TYPE="0" START="4000.0" LEN="0" HOTCUE="1"></CUE_V2>
<CUE_V2 NAME="n.n." TYPE="5" START="8000.0" LEN="2000.0" HOTCUE="-1"></CUE_V2>
</ENTRY></COLLECTION></NML>"#,
        dir_nml(&a)
    );
    let index = NmlIndex::new(traktor_nml::parse_str(&nml_text).unwrap(), PathStyle::Unix);
    let opts = UsbExportOptions {
        playlist_ids: vec![folder.playlist_id],
        destination: stick.to_string_lossy().into_owned(),
        use_traktor: true,
        device_name: Some("E2E STICK".into()),
        ..Default::default()
    };
    let size = |p: &str| std::fs::metadata(p).ok().map(|m| m.len());
    let built = build_request(
        &db,
        &opts,
        Some(TraktorInput {
            nml_path: "inline".into(),
            index: &index,
        }),
        &size,
    )
    .unwrap();
    assert_eq!(built.request.tracks.len(), 2);
    let rep = built.report.traktor.as_ref().unwrap();
    assert_eq!((rep.matched, rep.unmatched), (1, 1));
    let req_path = tmp.path().join("request.json");
    std::fs::write(&req_path, serde_json::to_vec(&built.request).unwrap()).unwrap();
    let cache = tmp.path().join("cache");
    let base = |extra: &[&str]| -> Vec<String> {
        let mut v: Vec<String> = vec![
            "usb".into(),
            "export".into(),
            "--input".into(),
            req_path.to_string_lossy().into_owned(),
            "--to".into(),
            stick.to_string_lossy().into_owned(),
            "--cache-dir".into(),
            cache.to_string_lossy().into_owned(),
            "--stdin-control".into(),
        ];
        v.extend(extra.iter().map(|s| s.to_string()));
        v
    };

    // 1. dry-run
    let v = base(&["--dry-run"]);
    let (events, out) = run(&exe, &args(&v), false);
    let plan: ExportResult = serde_json::from_value(out.expect("dry-run failed")).unwrap();
    assert!(plan.dry_run);
    assert_eq!(plan.tracks.requested, 2);
    assert!(
        plan.items.iter().all(|i| i.analysis == "generate"),
        "{:?}",
        plan.items
    );
    assert!(plan.bytes.to_copy > 0);
    assert!(plan
        .items
        .iter()
        .all(|i| i.audio.as_deref() == Some("copy")));
    assert!(events
        .iter()
        .any(|e| matches!(e, UsbExportProgress::Phase { .. })));
    assert!(
        std::fs::read_dir(&stick).unwrap().next().is_none(),
        "dry-run writes nothing"
    );
    eprintln!("dry-run: {:?} bytes={:?}", plan.analysis, plan.bytes);

    // 2. export
    let v = base(&[]);
    let (events, out) = run(&exe, &args(&v), false);
    let done: ExportResult = serde_json::from_value(out.expect("export failed")).unwrap();
    assert!(!done.dry_run);
    assert_eq!(done.tracks.exported, 2);
    assert_eq!(done.verified, Some(true));
    assert_eq!(done.analysis.cue_overrides, 1);
    assert_eq!(done.analysis.grid_overrides, 1);
    let phases: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            UsbExportProgress::Phase { phase, .. } => Some(phase.clone()),
            _ => None,
        })
        .collect();
    for p in ["plan", "analyze", "copy", "database", "publish"] {
        assert!(
            phases.iter().any(|x| x == p),
            "phase {p} missing: {phases:?}"
        );
    }
    eprintln!(
        "export: tracks={:?} timings={:?}",
        done.tracks, done.timings
    );

    // 3. inspect --cues: Traktor のキューが USB に載っている。
    let (_, out) = run(
        &exe,
        &["usb", "inspect", &stick.to_string_lossy(), "--cues"],
        false,
    );
    let inspect = out.expect("inspect failed");
    let tracks = inspect["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 2);
    let alpha = tracks
        .iter()
        .find(|t| t["title"] == "Alpha")
        .expect("Alpha on the stick");
    let cues = alpha["cues"].as_array().unwrap();
    eprintln!("alpha cues on stick: {cues:?}");
    assert!(cues
        .iter()
        .any(|c| c["type"] == "hot" && c["slot"] == "B" && c["timeMs"].as_f64() == Some(4000.0)));
    assert!(cues
        .iter()
        .any(|c| c["type"] == "memory" && c["loopEndMs"].as_f64() == Some(10000.0)));
    assert_eq!(
        inspect["playlistCount"].as_u64(),
        Some(2),
        "folder + playlist"
    );

    // 4. 2 回目: 変更なし → 音声は再利用、解析はキャッシュ。
    let (_, out) = run(&exe, &args(&base(&[])), false);
    let again: ExportResult = serde_json::from_value(out.expect("re-export failed")).unwrap();
    assert_eq!(again.tracks.copied, 0, "{:?}", again.tracks);
    assert_eq!(again.analysis.generated, 0, "{:?}", again.analysis);
    eprintln!(
        "re-export: tracks={:?} analysis={:?} timings={:?}",
        again.tracks, again.analysis, again.timings
    );

    // 5. 中止: 最初の progress で `cancel` を送る → cancelled、USB は前のまま。
    let (_, out) = run(&exe, &args(&base(&[])), true);
    let err = out.expect_err("cancel should end with an error line");
    assert_eq!(err.code, "cancelled");
    let msg = super::errors::user_message(&err);
    assert!(msg.contains("中止"));
    let (_, out) = run(&exe, &["usb", "verify", &stick.to_string_lossy()], false);
    assert_eq!(out.expect("verify after cancel")["ok"], true);
}
