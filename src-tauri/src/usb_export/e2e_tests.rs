//! 実物の rbx-cli を使う結合テスト (既定では実行しない)。
//!
//! ```sh
//! RBX_CLI_BIN=/path/to/rbx-cli cargo test -- --ignored usb_export::e2e
//! ```
//!
//! インメモリ DB + 生成した WAV + 生成した collection.nml から `build_request` でリクエストを
//! 作り、rbx-cli の dry-run → 書き出し → `usb inspect --cues` → 2 回目の書き出し (再利用) →
//! 中止 (`cancel` 行 / stdin を閉じる) → 元ファイル不在の競合 → CDJ でのグリッド変更の競合と
//! `onDeviceChanges: keepDevice` までを、crateforge と同じ NDJSON パーサ・引数で確認する。
//!
//! CDJ での変更は、USB 上の `.DAT` の `PQTZ` (ビートグリッド) の拍の位置をずらして再現する
//! (プレーヤーがグリッドを編集したときと同じく解析ファイルが書き換わる)。ANLZ の形式は公開の
//! 解析資料 (Deep Symmetry の crate-digger 等) に沿って、テスト内で最小限だけ読み書きする。

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

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}

/// ANLZ ファイルの `PQTZ` (ビートグリッド) の各拍の時刻 (ms) の位置 (バイトオフセット)。
/// 構造: ファイルヘッダ (`PMAI`, ヘッダ長, ファイル長) の後に、各セクションが
/// (タグ 4, ヘッダ長 u32, セクション長 u32, ...) で並ぶ。`PQTZ` のヘッダは
/// (…, 不明 u32, 不明 u32, 拍数 u32) の 24 バイトで、拍は (拍番号 u16, テンポ×100 u16,
/// 時刻 ms u32) の 8 バイト。すべてビッグエンディアン。
fn pqtz_time_offsets(bytes: &[u8]) -> Vec<usize> {
    assert_eq!(&bytes[0..4], b"PMAI", "not an ANLZ file");
    let mut pos = be32(bytes, 4) as usize;
    while pos + 12 <= bytes.len() {
        let header = be32(bytes, pos + 4) as usize;
        let len = be32(bytes, pos + 8) as usize;
        if &bytes[pos..pos + 4] == b"PQTZ" {
            let beats = be32(bytes, pos + 20) as usize;
            return (0..beats).map(|i| pos + header + i * 8 + 4).collect();
        }
        if len == 0 {
            break;
        }
        pos += len;
    }
    Vec::new()
}

/// 曲の `.DAT` (書き出し結果の `analysisDir` から)。
fn dat_path(stick: &Path, result: &ExportResult, title: &str) -> PathBuf {
    let item = result
        .items
        .iter()
        .find(|i| i.title == title)
        .unwrap_or_else(|| panic!("{title} not in the result"));
    let dir = item.analysis_dir.as_deref().expect("analysisDir");
    stick.join(dir.trim_start_matches('/')).join("ANLZ0000.DAT")
}

fn first_beat_ms(dat: &Path) -> u32 {
    let bytes = std::fs::read(dat).unwrap();
    let offsets = pqtz_time_offsets(&bytes);
    assert!(!offsets.is_empty(), "no beat grid in {}", dat.display());
    be32(&bytes, offsets[0])
}

/// CDJ でビートグリッドを動かしたときのように、USB 上の `.DAT` の全拍を `by_ms` 後ろへずらす。
fn shift_grid_like_a_player(dat: &Path, by_ms: u32) -> u32 {
    let mut bytes = std::fs::read(dat).unwrap();
    let offsets = pqtz_time_offsets(&bytes);
    assert!(!offsets.is_empty());
    for at in &offsets {
        let t = be32(&bytes, *at) + by_ms;
        bytes[*at..*at + 4].copy_from_slice(&t.to_be_bytes());
    }
    std::fs::write(dat, &bytes).unwrap();
    be32(&bytes, offsets[0])
}

/// 実行中に何をするか。
#[derive(Clone, Copy, PartialEq)]
enum Interrupt {
    None,
    /// 最初の progress で stdin に `cancel` を書く (UI の「中止」)。
    CancelLine,
    /// 最初の progress で stdin を閉じる (crateforge が異常終了したとき)。
    CloseStdin,
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
    interrupt: Interrupt,
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
                    if matches!(ev, UsbExportProgress::Phase { .. }) {
                        match interrupt {
                            Interrupt::None => {}
                            Interrupt::CancelLine => {
                                if let Some(s) = stdin.as_mut() {
                                    let _ = s.write_all(b"cancel\n");
                                    let _ = s.flush();
                                }
                            }
                            Interrupt::CloseStdin => drop(stdin.take()),
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
            // アプリと同じ: `cancel` 行 + stdin の終端で中止 (stdin は終わるまで開いたまま)。
            "--cancel-on-stdin-eof".into(),
        ];
        v.extend(extra.iter().map(|s| s.to_string()));
        v
    };

    // 1. dry-run
    let v = base(&["--dry-run"]);
    let (events, out) = run(&exe, &args(&v), Interrupt::None);
    let plan: ExportResult = serde_json::from_value(out.expect("dry-run failed")).unwrap();
    assert!(plan.dry_run);
    assert_eq!(plan.tracks.requested, 2);
    assert!(
        plan.items.iter().all(|i| i.analysis == "generate"),
        "{:?}",
        plan.items
    );
    assert!(plan.bytes.to_copy > 0);
    // 普通のフォルダでも空き容量が返る (rbx-cli 0.1.1)。計画画面の容量チェックに使う。
    assert!(plan.bytes.free.is_some_and(|f| f > 0), "{:?}", plan.bytes);
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
    let (events, out) = run(&exe, &args(&v), Interrupt::None);
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
        Interrupt::None,
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
    let (_, out) = run(&exe, &args(&base(&[])), Interrupt::None);
    let again: ExportResult = serde_json::from_value(out.expect("re-export failed")).unwrap();
    assert_eq!(again.tracks.copied, 0, "{:?}", again.tracks);
    assert_eq!(again.analysis.generated, 0, "{:?}", again.analysis);
    eprintln!(
        "re-export: tracks={:?} analysis={:?} timings={:?}",
        again.tracks, again.analysis, again.timings
    );

    // 5. 中止: 最初の progress で `cancel` を送る → cancelled、USB は前のまま。
    let (_, out) = run(&exe, &args(&base(&[])), Interrupt::CancelLine);
    let err = out.expect_err("cancel should end with an error line");
    assert_eq!(err.code, "cancelled");
    let msg = super::errors::user_message(&err);
    assert!(msg.contains("中止"));
    let (_, out) = run(
        &exe,
        &["usb", "verify", &stick.to_string_lossy()],
        Interrupt::None,
    );
    assert_eq!(out.expect("verify after cancel")["ok"], true);

    // 5b. 親が落ちた: stdin が閉じる → `--cancel-on-stdin-eof` で cancelled、USB は前のまま。
    let (_, out) = run(&exe, &args(&base(&[])), Interrupt::CloseStdin);
    let err = out.expect_err("closing stdin should cancel");
    assert_eq!(err.code, "cancelled", "{err:?}");
    let (_, out) = run(
        &exe,
        &["usb", "verify", &stick.to_string_lossy()],
        Interrupt::None,
    );
    assert_eq!(out.expect("verify after stdin EOF")["ok"], true);

    // 6. 元ファイルが見つからない (外付けドライブ未接続など): 曲は落とさずに送り、rbx-cli が
    //    USB を変更せずに conflict で止める (prune がオンでも USB の曲は消えない)。
    let moved = tmp.path().join("bravo.moved");
    std::fs::rename(&b, &moved).unwrap();
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
    assert_eq!(
        built.request.tracks.len(),
        2,
        "the missing track is still sent"
    );
    assert_eq!(built.report.missing, 1);
    assert!(opts.prune);
    std::fs::write(&req_path, serde_json::to_vec(&built.request).unwrap()).unwrap();
    let (_, out) = run(&exe, &args(&base(&[])), Interrupt::None);
    let err = out.expect_err("a missing, previously exported source must stop the export");
    assert_eq!(err.code, "conflict", "{err:?}");
    let mapped = super::errors::from_error_line_for(&err, &built.request.tracks);
    assert!(!mapped.cue_conflict);
    assert_eq!(
        mapped.conflict.reason.as_deref(),
        Some("source_unavailable")
    );
    assert_eq!(
        mapped
            .conflict
            .conflict_tracks
            .iter()
            .map(|t| t.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Bravo"],
        "{mapped:?}"
    );
    assert!(
        mapped
            .message
            .contains("ソースファイルが見つからない曲「Bravo」が以前 USB に書き出されています"),
        "{}",
        mapped.message
    );
    let (_, out) = run(
        &exe,
        &["usb", "inspect", &stick.to_string_lossy()],
        Interrupt::None,
    );
    assert_eq!(
        out.expect("inspect after conflict")["tracks"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "the stick still holds both tracks"
    );
    std::fs::rename(&moved, &b).unwrap();

    // 7. CDJ でグリッドを変更した曲 (Alpha、Traktor のキュー/グリッドを送っている曲)。
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
    std::fs::write(&req_path, serde_json::to_vec(&built.request).unwrap()).unwrap();
    let alpha_dat = dat_path(&stick, &again, "Alpha");
    let traktor_first_beat = first_beat_ms(&alpha_dat);
    let player_first_beat = shift_grid_like_a_player(&alpha_dat, 7);
    assert_ne!(traktor_first_beat, player_first_beat);

    // 7a. 既定 (fail): cues_or_grid_changed_on_device で止まり、Alpha が対象として挙がる。
    let (_, out) = run(&exe, &args(&base(&[])), Interrupt::None);
    let err = out.expect_err("a grid changed on the stick must stop the export");
    assert_eq!(err.code, "conflict", "{err:?}");
    let mapped = super::errors::from_error_line_for(&err, &built.request.tracks);
    assert_eq!(
        mapped.conflict.reason.as_deref(),
        Some("cues_or_grid_changed_on_device"),
        "{err:?}"
    );
    assert!(mapped.cue_conflict);
    assert_eq!(
        mapped
            .conflict
            .conflict_tracks
            .iter()
            .map(|t| t.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Alpha"],
        "{mapped:?}"
    );
    assert_eq!(
        first_beat_ms(&alpha_dat),
        player_first_beat,
        "USB unchanged"
    );

    // 7b. 「CDJ の変更を優先」で再試行: 同じリクエスト (Traktor のキュー + グリッド込み) に
    //     onDeviceChanges: keepDevice を付ける。
    let keep_opts = UsbExportOptions {
        keep_device_changes: true,
        ..opts.clone()
    };
    let keep = build_request(
        &db,
        &keep_opts,
        Some(TraktorInput {
            nml_path: "inline".into(),
            index: &index,
        }),
        &size,
    )
    .unwrap();
    assert_eq!(keep.request.tracks, built.request.tracks);
    std::fs::write(&req_path, serde_json::to_vec(&keep.request).unwrap()).unwrap();
    let (_, out) = run(&exe, &args(&base(&["--dry-run"])), Interrupt::None);
    let plan: ExportResult = serde_json::from_value(out.expect("keepDevice dry-run")).unwrap();
    assert_eq!(plan.tracks.device_changes_kept, 1, "{:?}", plan.tracks);
    let kept_titles = |r: &ExportResult| -> Vec<String> {
        r.items
            .iter()
            .filter(|i| i.device_changes_kept)
            .map(|i| i.title.clone())
            .collect()
    };
    assert_eq!(kept_titles(&plan), vec!["Alpha".to_string()]);

    let (_, out) = run(&exe, &args(&base(&[])), Interrupt::None);
    let kept: ExportResult = serde_json::from_value(out.expect("keepDevice export")).unwrap();
    assert_eq!(kept.tracks.device_changes_kept, 1, "{:?}", kept.tracks);
    assert_eq!(kept_titles(&kept), vec!["Alpha".to_string()]);
    assert_eq!(kept.verified, Some(true));
    let alpha_dat = dat_path(&stick, &kept, "Alpha");
    assert_eq!(
        first_beat_ms(&alpha_dat),
        player_first_beat,
        "the player's grid is kept"
    );
    let (_, out) = run(
        &exe,
        &["usb", "verify", &stick.to_string_lossy()],
        Interrupt::None,
    );
    assert_eq!(out.expect("verify after keepDevice")["ok"], true);
    eprintln!("keepDevice: tracks={:?}", kept.tracks);

    // 7c. その後 USB 上で何も変わらなければ、次の同期では Traktor のグリッドが再び書かれる
    //     (keepDevice はその 1 回だけ。ガイドに書いている制限)。
    let (_, out) = run(&exe, &args(&base(&[])), Interrupt::None);
    let next: ExportResult = serde_json::from_value(out.expect("next sync")).unwrap();
    assert_eq!(next.tracks.device_changes_kept, 0, "{:?}", next.tracks);
    assert_eq!(
        first_beat_ms(&dat_path(&stick, &next, "Alpha")),
        traktor_first_beat,
        "Traktor's grid applies again"
    );
}
