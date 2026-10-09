//! NML のキュー / グリッド → rbx-cli の汎用 `cues` / `beatGrid`。
//!
//! | Traktor `CUE_V2@TYPE` | 変換先 |
//! |---|---|
//! | 4 (grid marker) | `beatGrid.anchors` (BPM は `TEMPO@BPM`、マーカーごとに 1 アンカー)。ホットキュー枠に入っていればホットキューにもする |
//! | 0 cue / 1 fade-in / 2 fade-out / 3 load | キューポイント |
//! | 5 loop | ループ (`loopEndMs = START + LEN`) |
//!
//! `HOTCUE` 0..7 → ホットキュー A..H、-1 → メモリーキュー。プロトコル上限 (A–P) を超える枠は捨てる。
//! 名前はキューのコメントへ (Traktor 既定の `n.n.` は無名扱い)。
//!
//! MP3 のオフセット: Traktor と rekordbox / CDJ は MP3 のデコード開始位置 (エンコーダ遅延・
//! LAME ヘッダの扱い) が異なり、キュー / グリッドが数十 ms ずれることがある。ここでは
//! コーデック別のオフセット (ms) を足すフックだけ用意し、既定は全コーデック 0 ms。
//! 正しい値は実機で校正が必要 (推測値は入れない)。

use crate::usb_export::wire::{BeatAnchor, BeatGridInput, CueInput, CueKind};

use super::NmlEntry;

/// rbx-cli のビートグリッドが持てる最大 BPM (デバイスフォーマットの上限)。
const MAX_GRID_BPM: f64 = 655.35;
/// ホットキュー枠の上限 (プロトコルは A–P = 16 枠)。
const MAX_HOT_SLOTS: i32 = 16;

/// コーデック別のキュー / グリッド補正 (ms)。正の値で後ろへずらす。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CodecOffsets {
    pub mp3_ms: f64,
}

impl CodecOffsets {
    /// ファイル拡張子からその曲に掛けるオフセットを返す (未対応コーデックは 0)。
    pub fn for_path(&self, path: &str) -> f64 {
        let ext = path
            .rsplit('.')
            .next()
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let v = match ext.as_str() {
            "mp3" => self.mp3_ms,
            _ => 0.0,
        };
        if v.is_finite() {
            v
        } else {
            0.0
        }
    }
}

/// 1 曲分の変換結果。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MappedCues {
    pub cues: Vec<CueInput>,
    pub grid: Option<BeatGridInput>,
}

fn cue_name(name: &str) -> Option<String> {
    let t = name.trim();
    if t.is_empty() || t == "n.n." {
        None
    } else {
        Some(t.to_string())
    }
}

fn slot_letter(hotcue: i32) -> Option<String> {
    if (0..MAX_HOT_SLOTS).contains(&hotcue) {
        let c = (b'A' + hotcue as u8) as char;
        Some(c.to_string())
    } else {
        None
    }
}

/// 負の位置 (Traktor はトラック先頭より前にグリッドマーカーを置ける) を、拍単位で
/// 前へ送って 0 以上にする。テンポ位相は保たれる。
fn first_non_negative_beat(time_ms: f64, bpm: f64) -> f64 {
    if time_ms >= 0.0 {
        return time_ms;
    }
    let period = 60_000.0 / bpm;
    let beats = (-time_ms / period).ceil();
    let t = time_ms + beats * period;
    if t < 0.0 {
        0.0
    } else {
        t
    }
}

/// 1 曲の NML エントリを、`offset_ms` を足しつつ cues / beatGrid に変換する。
pub fn map_entry(entry: &NmlEntry, offset_ms: f64) -> MappedCues {
    let offset = if offset_ms.is_finite() {
        offset_ms
    } else {
        0.0
    };

    // --- beat grid ---
    let grid = entry
        .bpm
        .filter(|b| b.is_finite() && *b > 0.0 && *b <= MAX_GRID_BPM)
        .and_then(|bpm| {
            let mut times: Vec<f64> = entry
                .cues
                .iter()
                .filter(|c| c.kind == 4)
                .map(|c| first_non_negative_beat(c.start_ms + offset, bpm))
                .collect();
            times.sort_by(|a, b| a.total_cmp(b));
            // rbx-cli はミリ秒に丸めた時刻が厳密に増加することを要求する。
            times.dedup_by(|b, a| b.round() <= a.round());
            if times.is_empty() {
                None
            } else {
                Some(BeatGridInput {
                    anchors: times
                        .into_iter()
                        .map(|time_ms| BeatAnchor { time_ms, bpm })
                        .collect(),
                })
            }
        });

    // --- cues ---
    let mut hot: Vec<(i32, CueInput)> = Vec::new();
    let mut memory: Vec<CueInput> = Vec::new();
    for c in &entry.cues {
        let time_ms = (c.start_ms + offset).max(0.0);
        let loop_end_ms = match c.kind {
            0..=4 => None,
            5 => {
                let end = c.start_ms + offset + c.len_ms;
                // 丸めると長さ 0 になるループは通常のキューにする。
                (c.len_ms > 0.0 && end.round() > time_ms.round()).then_some(end)
            }
            _ => continue, // 未知の種類は送らない
        };
        if c.kind == 4 && c.hotcue < 0 {
            continue; // ホットキュー枠に無いグリッドマーカーはグリッド専用
        }
        let comment = cue_name(&c.name);
        if c.hotcue >= 0 {
            let Some(slot) = slot_letter(c.hotcue) else {
                continue; // プロトコルの枠 (A–P) を超える
            };
            if hot.iter().any(|(h, _)| *h == c.hotcue) {
                continue; // 同じ枠の 2 個目以降は捨てる
            }
            hot.push((
                c.hotcue,
                CueInput {
                    kind: CueKind::Hot,
                    slot: Some(slot),
                    time_ms,
                    loop_end_ms,
                    comment,
                },
            ));
        } else {
            memory.push(CueInput {
                kind: CueKind::Memory,
                slot: None,
                time_ms,
                loop_end_ms,
                comment,
            });
        }
    }
    hot.sort_by_key(|(h, _)| *h);
    memory.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    let mut cues: Vec<CueInput> = hot.into_iter().map(|(_, c)| c).collect();
    cues.extend(memory);
    MappedCues { cues, grid }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traktor_nml::NmlCue;

    fn cue(kind: i32, start: f64, len: f64, hotcue: i32, name: &str) -> NmlCue {
        NmlCue {
            name: name.into(),
            kind,
            start_ms: start,
            len_ms: len,
            hotcue,
        }
    }

    fn entry(bpm: Option<f64>, cues: Vec<NmlCue>) -> NmlEntry {
        NmlEntry {
            file: "a.mp3".into(),
            bpm,
            cues,
            ..Default::default()
        }
    }

    #[test]
    fn maps_the_sample_collection_entry() {
        let entries = crate::traktor_nml::parse_str(crate::traktor_nml::tests::SAMPLE).unwrap();
        let m = map_entry(&entries[0], 0.0);
        assert_eq!(
            m.grid,
            Some(BeatGridInput {
                anchors: vec![BeatAnchor {
                    time_ms: 35.123,
                    bpm: 124.0
                }]
            })
        );
        assert_eq!(
            m.cues,
            vec![
                // AutoGrid がホットキュー 1 (A) にも入っている。
                CueInput {
                    kind: CueKind::Hot,
                    slot: Some("A".into()),
                    time_ms: 35.123,
                    loop_end_ms: None,
                    comment: Some("AutoGrid".into())
                },
                CueInput {
                    kind: CueKind::Hot,
                    slot: Some("B".into()),
                    time_ms: 60000.5,
                    loop_end_ms: None,
                    comment: Some("Drop".into())
                },
                CueInput {
                    kind: CueKind::Memory,
                    slot: None,
                    time_ms: 90000.0,
                    loop_end_ms: Some(97741.9),
                    comment: None
                },
            ]
        );
        // キューもグリッドも無い曲 → 空のキュー列 (USB 上のキューは消える) / グリッドなし。
        let none = map_entry(&entries[1], 0.0);
        assert!(none.cues.is_empty());
        assert_eq!(none.grid, None);
    }

    #[test]
    fn cue_types_map_to_hot_memory_and_loops() {
        let m = map_entry(
            &entry(
                Some(128.0),
                vec![
                    cue(0, 1000.0, 0.0, -1, "Intro"),
                    cue(1, 2000.0, 0.0, -1, ""),
                    cue(2, 3000.0, 0.0, 7, "Out"),
                    cue(3, 0.0, 0.0, -1, "n.n."),
                    cue(5, 4000.0, 1875.0, 2, "Loop"),
                    cue(9, 5000.0, 0.0, -1, "unknown type"),
                    cue(4, 500.0, 0.0, -1, "grid only"),
                ],
            ),
            0.0,
        );
        let kinds: Vec<(CueKind, Option<&str>, f64, Option<f64>)> = m
            .cues
            .iter()
            .map(|c| (c.kind, c.slot.as_deref(), c.time_ms, c.loop_end_ms))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (CueKind::Hot, Some("C"), 4000.0, Some(5875.0)),
                (CueKind::Hot, Some("H"), 3000.0, None),
                (CueKind::Memory, None, 0.0, None),
                (CueKind::Memory, None, 1000.0, None),
                (CueKind::Memory, None, 2000.0, None),
            ]
        );
        assert_eq!(m.cues[0].comment.as_deref(), Some("Loop"));
        assert_eq!(m.cues[2].comment, None, "n.n. is Traktor's unnamed cue");
        assert_eq!(m.grid.unwrap().anchors.len(), 1);
    }

    #[test]
    fn hot_slots_beyond_the_protocol_and_duplicates_are_dropped() {
        let m = map_entry(
            &entry(
                None,
                vec![
                    cue(0, 1.0, 0.0, 0, "first"),
                    cue(0, 2.0, 0.0, 0, "duplicate slot"),
                    cue(0, 3.0, 0.0, 16, "slot Q"),
                    cue(0, 4.0, 0.0, 15, "slot P"),
                ],
            ),
            0.0,
        );
        let slots: Vec<&str> = m.cues.iter().filter_map(|c| c.slot.as_deref()).collect();
        assert_eq!(slots, vec!["A", "P"]);
        assert_eq!(m.cues[0].comment.as_deref(), Some("first"));
    }

    #[test]
    fn multiple_grid_markers_become_sorted_unique_anchors() {
        let m = map_entry(
            &entry(
                Some(120.0),
                vec![
                    cue(4, 60_000.0, 0.0, -1, ""),
                    cue(4, 100.0, 0.0, -1, ""),
                    cue(4, 100.2, 0.0, -1, ""), // 丸めると同じ ms → 捨てる
                ],
            ),
            0.0,
        );
        let anchors = m.grid.unwrap().anchors;
        assert_eq!(
            anchors.iter().map(|a| a.time_ms).collect::<Vec<_>>(),
            vec![100.0, 60_000.0]
        );
        assert!(anchors.iter().all(|a| a.bpm == 120.0));
    }

    #[test]
    fn negative_grid_markers_are_moved_forward_by_whole_beats() {
        // 120 BPM = 500 ms/拍。-120 ms → 380 ms。
        let m = map_entry(&entry(Some(120.0), vec![cue(4, -120.0, 0.0, -1, "")]), 0.0);
        let a = &m.grid.unwrap().anchors[0];
        assert!((a.time_ms - 380.0).abs() < 1e-9, "{}", a.time_ms);
    }

    #[test]
    fn grid_needs_a_valid_bpm() {
        assert_eq!(
            map_entry(&entry(None, vec![cue(4, 10.0, 0.0, -1, "")]), 0.0).grid,
            None
        );
        assert_eq!(
            map_entry(&entry(Some(700.0), vec![cue(4, 10.0, 0.0, -1, "")]), 0.0).grid,
            None
        );
        assert_eq!(map_entry(&entry(Some(128.0), vec![]), 0.0).grid, None);
    }

    #[test]
    fn offset_shifts_cues_and_grid_and_clamps_at_zero() {
        let e = entry(
            Some(120.0),
            vec![
                cue(4, 100.0, 0.0, -1, ""),
                cue(0, 10.0, 0.0, 0, ""),
                cue(5, 1000.0, 500.0, -1, ""),
            ],
        );
        let m = map_entry(&e, 25.0);
        assert_eq!(m.grid.as_ref().unwrap().anchors[0].time_ms, 125.0);
        assert_eq!(m.cues[0].time_ms, 35.0);
        assert_eq!(m.cues[1].time_ms, 1025.0);
        assert_eq!(m.cues[1].loop_end_ms, Some(1525.0));
        let neg = map_entry(&e, -50.0);
        assert_eq!(
            neg.cues[0].time_ms, 0.0,
            "clamped at the start of the track"
        );
        assert_eq!(neg.grid.unwrap().anchors[0].time_ms, 50.0);
    }

    #[test]
    fn zero_length_loops_become_plain_cues() {
        let m = map_entry(&entry(None, vec![cue(5, 1000.0, 0.2, -1, "")]), 0.0);
        assert_eq!(m.cues[0].loop_end_ms, None);
    }

    #[test]
    fn codec_offsets_apply_to_mp3_only() {
        let o = CodecOffsets { mp3_ms: 26.0 };
        assert_eq!(o.for_path("/m/a.MP3"), 26.0);
        assert_eq!(o.for_path("/m/a.flac"), 0.0);
        assert_eq!(o.for_path("/m/noext"), 0.0);
        assert_eq!(CodecOffsets::default().for_path("/m/a.mp3"), 0.0);
        assert_eq!(CodecOffsets { mp3_ms: f64::NAN }.for_path("a.mp3"), 0.0);
    }
}
