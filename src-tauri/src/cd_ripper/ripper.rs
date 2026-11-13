use std::path::PathBuf;
#[cfg(not(windows))]
use std::process::Command;

use tauri::{AppHandle, Emitter};

use crate::cd_ripper::encoder::{self, EncodeMeta};
use crate::db::Database;
use crate::itunes_xml::writer::path_to_file_url;
use crate::library_match::replace::{self, NewFile, OldFileDisposition};
use crate::models::{EncodeFormat, ItemAction, RipProgress, RipRequest, RipStage};
use crate::organizer;

/// CD を取り込む。
///
/// `ffmpeg` は Windows でのみ Some（自動 DL 済みパス）。FLAC/MP3/ALAC のエンコードに使う。
/// Unix では None で、従来どおり cdparanoia + flac/lame を使う。
pub fn rip_cd(
    app: &AppHandle,
    db: &Database,
    req: RipRequest,
    ffmpeg: Option<PathBuf>,
) -> Result<(), String> {
    // 出力先ディレクトリの決定とオーガナイザー使用判定。
    let organize_root = db.organize_root();
    let output_dir_given = req.output_dir.as_ref().filter(|d| !d.is_empty());
    let use_organizer = output_dir_given.is_none() && organize_root.is_some();

    let (output_dir, is_temp) = if let Some(given) = output_dir_given {
        // 明示的な出力先が指定されている: 従来パス。
        let p = PathBuf::from(given);
        std::fs::create_dir_all(&p).map_err(|e| format!("Failed to create output dir: {}", e))?;
        (p, false)
    } else if use_organizer {
        // 出力先なし + organize 有効: temp へ rip して後で整理。
        let p = std::env::temp_dir().join(format!("crateforge-rip-{}", std::process::id()));
        std::fs::create_dir_all(&p).map_err(|e| format!("Failed to create temp dir: {}", e))?;
        (p, true)
    } else {
        return Err(
            "Output directory not specified and library organization is not configured. \
             Please set a library root in Settings or provide an output directory."
                .to_string(),
        );
    };

    // temp dir を使った場合、関数がどこで return しても必ず後始末する。
    struct TempDirGuard<'a> {
        dir: &'a std::path::Path,
        active: bool,
    }
    impl Drop for TempDirGuard<'_> {
        fn drop(&mut self) {
            if self.active {
                let _ = std::fs::remove_dir_all(self.dir);
            }
        }
    }
    let _temp_guard = TempDirGuard {
        dir: &output_dir,
        active: is_temp,
    };

    // Windows はドライブを 1 回開いて TOC を読み、以降ループ内で CDDA を直接読む。
    #[cfg(windows)]
    let (drive, win_toc) = {
        let d = crate::cd_ripper::win_cd::open_drive(&req.device)?;
        let t = d.read_toc()?;
        (d, t)
    };

    let mut written_files: Vec<String> = Vec::new();
    let mut added_tracks = 0usize;
    let mut replaced_tracks = 0usize;
    let mut moved_old_files: Vec<String> = Vec::new();
    let mut replace_errors: Vec<String> = Vec::new();
    let library_root = crate::importer::library_media_root(db);

    // トラックごとの扱い (取り込み済み検出の結果)。指定の無いトラックは取り込む。
    let action_of = |pos: usize| -> (ItemAction, Option<i64>) {
        req.track_actions
            .iter()
            .find(|a| a.position == pos)
            .map(|a| (a.action, a.replace_track_id))
            .unwrap_or((ItemAction::Import, None))
    };

    let all_tracks: Vec<usize> = if req.tracks.is_empty() {
        if let Some(ref rel) = req.release {
            (1..=rel.track_count).collect()
        } else {
            return Err("No tracks specified and no release metadata available".to_string());
        }
    } else {
        req.tracks.clone()
    };
    // スキップ指定のトラックはリップ自体をしない。
    let tracks_to_rip: Vec<usize> = all_tracks
        .into_iter()
        .filter(|&n| action_of(n).0 != ItemAction::Skip)
        .collect();

    let total = tracks_to_rip.len();
    let _ = app.emit("rip-progress", RipProgress::Start { total });

    for (idx, &track_num) in tracks_to_rip.iter().enumerate() {
        // 置き換え: 対象の既存曲を先に引く (無ければこのトラックはリップしない)。
        let replace_target = match action_of(track_num) {
            (ItemAction::Replace, Some(id)) => match db.get_track_by_track_id(id) {
                Ok(Some(t)) => Some(t),
                _ => {
                    replace_errors.push(format!(
                        "Track {:02}: 置き換え先の曲が見つかりません (id={})",
                        track_num, id
                    ));
                    continue;
                }
            },
            (ItemAction::Replace, None) => {
                replace_errors.push(format!(
                    "Track {:02}: 置き換え先の曲が指定されていません",
                    track_num
                ));
                continue;
            }
            _ => None,
        };

        let label = req
            .release
            .as_ref()
            .and_then(|r| r.tracks.iter().find(|t| t.position == track_num))
            .map(|t| {
                if t.artist.trim().is_empty() {
                    t.title.clone()
                } else {
                    format!("{} - {}", t.artist, t.title)
                }
            })
            .unwrap_or_else(|| format!("Track {:02}", track_num));

        let _ = app.emit(
            "rip-progress",
            RipProgress::TrackStart {
                index: idx,
                total,
                label: label.clone(),
            },
        );

        // 1. Rip to a temporary WAV.
        let wav_path = output_dir.join(format!(".tmp_track_{:02}.wav", track_num));

        // 読み取り開始 (0%)。Windows はこの後セクタ単位で進捗を送る。
        emit_track_progress(app, idx, 0, RipStage::Reading);

        // Unix: cdparanoia 経由で WAV を取得。
        #[cfg(not(windows))]
        {
            let mut cdp_cmd = Command::new("cdparanoia");
            cdp_cmd
                .arg("-d")
                .arg(&req.device)
                .arg("-w")
                .arg(format!("{}", track_num))
                .arg(&wav_path);
            // Windows でコンソール窓を出さない (課題1)。この経路は non-Windows のみだが
            // 共通ヘルパに揃えておく (no-op)。
            crate::proc::no_window(&mut cdp_cmd);
            let cdp_status = cdp_cmd.status().map_err(|e| {
                format!(
                    "`cdparanoia` not found ({}). Use `nix develop` so the toolchain is in PATH.",
                    e
                )
            })?;
            if !cdp_status.success() {
                return Err(format!(
                    "cdparanoia failed for track {} (device {})",
                    track_num, req.device
                ));
            }
        }

        // Windows: IOCTL で CDDA 生データを読んで WAV を書き出す。
        #[cfg(windows)]
        {
            // 1% 刻みに間引いて送る (1 トラック最大 ~90 イベント)。
            let mut last_pct: u8 = 0;
            let pcm = drive.read_track_pcm(&win_toc, track_num, |done, total_sectors| {
                let pct = reading_percent(done, total_sectors);
                if pct != last_pct {
                    last_pct = pct;
                    emit_track_progress(app, idx, pct, RipStage::Reading);
                }
            })?;
            crate::cd_ripper::win_cd::write_wav(&wav_path, &pcm)?;
        }

        // 2. Determine final output path + metadata.
        let release_track = req
            .release
            .as_ref()
            .and_then(|r| r.tracks.iter().find(|t| t.position == track_num));
        // 空文字 (MusicBrainz にクレジットが無い等) はタグ / DB に書かず None にする。
        let nonempty = |s: &str| !s.trim().is_empty();
        let title = release_track.map(|t| t.title.as_str()).filter(|s| nonempty(s));
        let track_artist = release_track.map(|t| t.artist.as_str()).filter(|s| nonempty(s));
        let album_artist = req.release.as_ref().map(|r| r.artist.as_str()).filter(|s| nonempty(s));
        let album = req.release.as_ref().map(|r| r.title.as_str()).filter(|s| nonempty(s));
        let date = req.release.as_ref().and_then(|r| r.date.as_deref());
        let track_count_meta = req.release.as_ref().map(|r| r.track_count as u32);

        let file_stem = match (release_track, req.release.as_ref()) {
            (Some(t), _) => format!("{:02} - {}", track_num, sanitize_filename(&t.title)),
            (None, _) => format!("Track {:02}", track_num),
        };
        let mut out_path = output_dir.join(format!("{}.{}", file_stem, req.format.extension()));
        // 置き換えでは既存ファイルを決して上書きしない (出力先に旧ファイルがある場合など)。
        let desired_out = out_path.clone();
        if replace_target.is_some() {
            out_path = organizer::resolve_collision(&out_path, &wav_path);
        }

        // 3. Encode (or copy WAV).
        emit_track_progress(app, idx, READ_SHARE_PERCENT, RipStage::Encoding);
        encoder::encode(
            req.format,
            &wav_path,
            &out_path,
            &EncodeMeta {
                title,
                artist: track_artist,
                album,
                album_artist,
                track_number: Some(track_num as u32),
                track_count: track_count_meta,
                date,
            },
            ffmpeg.as_deref(),
        )?;

        if req.format != EncodeFormat::Wav {
            std::fs::remove_file(&wav_path).ok();
        }

        // 置き換え: 既存行のメタデータで決まる場所へ置き、既存行を付け替える。
        if let Some(existing) = replace_target {
            let (path, desired) = if use_organizer {
                let root_path = PathBuf::from(organize_root.as_ref().unwrap());
                let target = replace::target_for_track(&root_path, &existing, &out_path);
                match organizer::relocate(&out_path, &target, organizer::Mode::Move) {
                    Ok(p) => (p, Some(target)),
                    Err(e) => {
                        std::fs::remove_file(&out_path).ok();
                        replace_errors.push(format!("Track {:02}: organize failed: {}", track_num, e));
                        continue;
                    }
                }
            } else {
                (out_path.clone(), Some(desired_out))
            };
            match replace::finalize_replacement(
                db,
                existing.track_id,
                NewFile {
                    path,
                    owned: true,
                    desired,
                    library_root: library_root.as_deref(),
                    old_policy: replace::OldFilePolicy::MoveToReplaced,
                },
            ) {
                Ok(out) => {
                    replaced_tracks += 1;
                    if let OldFileDisposition::Moved { to } = out.old_file {
                        moved_old_files.push(to);
                    }
                    written_files.push(out.new_path.clone());
                    let _ = app.emit(
                        "rip-progress",
                        RipProgress::TrackDone {
                            index: idx,
                            output_path: out.new_path,
                        },
                    );
                }
                Err(e) => {
                    replace_errors.push(format!("Track {:02}: {}", track_num, e));
                }
            }
            continue;
        }

        // 5. organize 有効時: ファイルをライブラリルート配下へ移動。
        let final_path_str = if use_organizer {
            let root_path = PathBuf::from(organize_root.as_ref().unwrap());
            let org_meta = organizer::TrackMeta {
                title,
                artist: track_artist,
                album_artist,
                album,
                compilation: album_artist
                    .map(|a| a.eq_ignore_ascii_case("various artists"))
                    .unwrap_or(false),
                track_number: Some(track_num as i64),
                disc_number: Some(1),
                disc_count: Some(1),
            };
            let target = organizer::target_path(&root_path, &org_meta, &out_path);
            let final_path = organizer::relocate(&out_path, &target, organizer::Mode::Move)
                .map_err(|e| format!("organize failed: {}", e))?;
            final_path.to_string_lossy().to_string()
        } else {
            out_path.to_string_lossy().to_string()
        };

        written_files.push(final_path_str.clone());

        // 6. Optionally add to library DB.
        if req.add_to_library {
            let location_url = path_to_file_url(&final_path_str);
            let length_ms = release_track.and_then(|t| t.length_ms).map(|x| x as i64);
            let year = date
                .and_then(|d| d.split('-').next())
                .and_then(|y| y.parse::<i64>().ok());

            let new_track_id = db
                .add_imported_track(
                    title,
                    track_artist,
                    album_artist,
                    album,
                    None,
                    year,
                    Some(track_num as i64),
                    req.release.as_ref().map(|r| r.track_count as i64),
                    Some(1),
                    Some(1),
                    length_ms,
                    &final_path_str,
                    &location_url,
                )
                .map_err(|e| format!("DB insert failed: {}", e))?;
            // 技術メタデータ (#171) はエンコード後のファイルから読む (失敗しても取り込みは続行)。
            if let Err(e) = crate::importer::refresh_tech_meta_from_file(
                db,
                new_track_id,
                std::path::Path::new(&final_path_str),
            ) {
                eprintln!("rip: tech meta read failed ({})", e);
            }
            added_tracks += 1;
        }

        let _ = app.emit(
            "rip-progress",
            RipProgress::TrackDone {
                index: idx,
                output_path: final_path_str,
            },
        );
    }

    if replaced_tracks > 0 {
        // 置き換えた曲は埋め込みアートワークが変わりうるので WebView に取り直させる。
        let _ = app.emit(
            "library-changed",
            serde_json::json!({ "playlistId": null, "artworkChanged": true }),
        );
    }
    let _ = app.emit(
        "rip-progress",
        RipProgress::Done {
            written_files,
            added_tracks,
            replaced_tracks,
            moved_old_files,
            replace_errors,
        },
    );
    Ok(())
}

/// 1 トラックの進捗のうち読み取りに割り当てる割合 (%)。残りをエンコード以降に充てる。
/// CD の読み取り (等倍〜数十倍速) はエンコードより桁違いに遅いので大半を読み取りに配分する。
const READ_SHARE_PERCENT: u8 = 90;

/// 読み取り済みセクタ数をトラック全体の進捗 (0..=READ_SHARE_PERCENT) に換算する。
#[cfg_attr(not(windows), allow(dead_code))]
fn reading_percent(done: u32, total: u32) -> u8 {
    if total == 0 {
        return 0;
    }
    let done = done.min(total) as u64;
    (done * READ_SHARE_PERCENT as u64 / total as u64) as u8
}

fn emit_track_progress(app: &AppHandle, index: usize, percent: u8, stage: RipStage) {
    let _ = app.emit(
        "rip-progress",
        RipProgress::TrackProgress {
            index,
            percent,
            stage,
        },
    );
}

pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_percent_maps_into_read_share() {
        assert_eq!(reading_percent(0, 1000), 0);
        assert_eq!(reading_percent(500, 1000), 45);
        assert_eq!(reading_percent(1000, 1000), READ_SHARE_PERCENT);
        // 範囲外・ゼロ除算でも暴れない。
        assert_eq!(reading_percent(2000, 1000), READ_SHARE_PERCENT);
        assert_eq!(reading_percent(10, 0), 0);
    }

    #[test]
    fn track_progress_serializes_for_frontend() {
        let v = serde_json::to_value(RipProgress::TrackProgress {
            index: 2,
            percent: 45,
            stage: RipStage::Encoding,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "trackProgress",
                "index": 2,
                "percent": 45,
                "stage": "encoding"
            })
        );
    }

    #[test]
    fn track_done_serializes_fields_in_camel_case() {
        let v = serde_json::to_value(RipProgress::TrackDone {
            index: 3,
            output_path: "C:/Music/01 - Intro.flac".to_string(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "trackDone",
                "index": 3,
                "outputPath": "C:/Music/01 - Intro.flac"
            })
        );
    }

    #[test]
    fn done_serializes_fields_in_camel_case() {
        let v = serde_json::to_value(RipProgress::Done {
            written_files: vec!["a.flac".to_string(), "b.flac".to_string()],
            added_tracks: 2,
            replaced_tracks: 1,
            moved_old_files: vec!["/m/_replaced/20261110/x.mp3".to_string()],
            replace_errors: vec![],
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "done",
                "writtenFiles": ["a.flac", "b.flac"],
                "addedTracks": 2,
                "replacedTracks": 1,
                "movedOldFiles": ["/m/_replaced/20261110/x.mp3"],
                "replaceErrors": []
            })
        );
    }
}
