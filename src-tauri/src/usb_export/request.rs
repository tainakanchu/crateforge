//! 選択プレイリスト → rbx-cli `usb export` リクエスト (純粋関数、DB は読み取りのみ)。
//!
//! マッピングの決定事項 (rbx-cli protocol 1):
//! - **曲の同一性**: `id` は曲の `persistent_id` (16 桁 hex) から導く 53 bit 値、`ref` は
//!   `persistent_id` そのもの。ファイルを移動しても USB 上の同じ曲として扱われる。
//!   プレイリスト / フォルダの `id` も `persistent_id` から同様に導く (改名しても同一)。
//! - **rating**: crateforge の 0–100 (★1 = 20) → 0–5 の星。半星は切り上げ (70 → 4)。
//! - **key**: 実効キー (`key_camelot_user ?? 解析 key_camelot`) を rekordbox の綴り
//!   (`Am`, `F#m`, `Db` — 黒鍵はフラット、F# のみシャープ) に変換して送る。
//!   無ければ省略し、rbx-cli の解析キー (`detectKey`) に任せる。
//! - **BPM は送らない**: rbx-cli は `bpm` 省略時、送ったグリッドの先頭テンポ → 無ければ
//!   自前解析のテンポを表示用 BPM にする。crateforge の BPM (整数・iTunes 由来もある) を
//!   送ると、CDJ の表示 BPM と実際のビートグリッドが食い違い得るため、グリッドと同じ
//!   出どころの値になるよう省略する。
//! - **cues / beatGrid**: Traktor を使わない / 曲が NML に無い → **両方省略** (USB 上の既存
//!   キューを保持し、グリッドは rbx-cli が解析)。Traktor を使い一致した → 送る (キューが無ければ
//!   空配列 = USB のキューを消す)。「USB 上のキューを優先」なら cues だけ省略してグリッドは送る。
//! - **見つからないファイル** も (パスがあれば) そのまま送り、件数と例をレポートする。
//!   以前書き出した曲の元ファイルが無いときに USB を守るのは rbx-cli / rbl-export の役目
//!   (`conflict` / `source_unavailable` で USB を変更せずに止まる)。ここで落とすと
//!   「今回の内容に無い曲」扱いになり、プレイリストから消え、prune で USB からも消える。
//! - メタデータは常に crateforge の DB の値 (NML の値は使わない)。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::models::{Playlist, Track};
use crate::traktor_nml::mapping::{map_entry, CodecOffsets};
use crate::traktor_nml::{Lookup, MatchKind, NmlIndex};

use super::wire::{ExportOptions, ExportRequest, PlaylistInput, TrackInput, PROTOCOL_VERSION};

/// スマートプレイリストを全件評価するための上限 (実質無制限)。
const SMART_LIMIT: i64 = 1_000_000_000;
/// フォルダの入れ子の深さの上限 (壊れた親子関係での無限再帰を防ぐ)。
const MAX_DEPTH: usize = 64;
/// レポートに載せる例の数。
const MAX_EXAMPLES: usize = 10;

/// UI から渡される書き出し設定。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UsbExportOptions {
    /// 書き出すプレイリスト / フォルダ (フォルダは配下を階層ごと)。
    pub playlist_ids: Vec<i64>,
    /// USB のルート (マウントポイント) またはフォルダ。
    pub destination: String,
    /// Traktor のキュー / グリッドを使う。
    pub use_traktor: bool,
    /// この書き出しで使う NML (None なら保存済みの指定 → 自動検出)。
    pub nml_path: Option<String>,
    /// MP3 のキュー / グリッド補正 (ms)。既定 0。
    pub mp3_offset_ms: f64,
    /// 埋め込みアートワークを書き出す。
    pub artwork: bool,
    /// 今回のリクエストに無い曲を USB から消す。
    pub prune: bool,
    /// プレーヤーに表示するデバイス名 (空なら変更しない)。
    pub device_name: Option<String>,
    /// USB 上のキューを優先 (Traktor のキューを送らない、グリッドは送る)。
    pub prefer_device_cues: bool,
}

impl Default for UsbExportOptions {
    fn default() -> Self {
        Self {
            playlist_ids: Vec::new(),
            destination: String::new(),
            use_traktor: false,
            nml_path: None,
            mp3_offset_ms: 0.0,
            artwork: true,
            prune: true,
            device_name: None,
            prefer_device_cues: false,
        }
    }
}

/// Traktor との突き合わせ結果。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TraktorReport {
    pub nml_path: String,
    /// NML の曲数。
    pub entries: usize,
    /// 一致した曲 (パス一致 + 名前/サイズ一致)。
    pub matched: usize,
    /// うちファイル名 + サイズで一致した曲。
    pub matched_by_name: usize,
    /// 一致しなかった曲 (曖昧だった曲を含む)。
    pub unmatched: usize,
    pub unmatched_examples: Vec<String>,
    /// 候補が複数あって決められなかった曲 (クローン / バックアップ用ボリュームに同じパスの
    /// 曲がある、同名・同サイズの曲が複数ある)。
    pub ambiguous: usize,
    pub ambiguous_examples: Vec<String>,
    /// 一致した曲のうち、キュー (1 個以上) / グリッドを送る曲。
    pub with_cues: usize,
    pub with_grid: usize,
    pub mp3_offset_ms: f64,
    /// キューを送るか (false = 「USB 上のキューを優先」)。
    pub cues_sent: bool,
}

/// リクエスト作成のレポート (プラン表示用)。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuildReport {
    pub tracks: usize,
    pub playlists: usize,
    pub folders: usize,
    /// ファイルが見つかった曲 (書き出される見込みの曲)。
    pub found: usize,
    /// ファイルが見つからない曲 (パスの無い曲を含む)。パスのある曲は rbx-cli に渡す。
    pub missing: usize,
    pub missing_examples: Vec<String>,
    pub traktor: Option<TraktorReport>,
    pub warnings: Vec<String>,
}

pub struct Built {
    pub request: ExportRequest,
    pub report: BuildReport,
}

/// Traktor 連携の入力。
pub struct TraktorInput<'a> {
    pub nml_path: String,
    pub index: &'a NmlIndex,
}

// ============================================================ pure helpers

/// 0–100 → 0–5 の星 (半星は切り上げ)。
pub fn rating_to_stars(rating: Option<i64>) -> Option<u8> {
    rating.map(|r| ((r.clamp(0, 100) + 10) / 20) as u8)
}

/// Camelot (`8A`) → rekordbox の綴り (`Am`)。不正なら None。
pub fn camelot_to_rekordbox(key: &str) -> Option<String> {
    // Camelot 1A..12A の短調のトニック (ピッチクラス)。rbxport と同じ円 (A♭m から 5 度ずつ)。
    const MINOR_PITCH: [u8; 12] = [8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1];
    const NAMES: [&str; 12] = [
        "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
    ];
    let t = key.trim();
    if t.len() < 2 {
        return None;
    }
    let (num, letter) = t.split_at(t.len() - 1);
    let minor = match letter {
        "A" | "a" => true,
        "B" | "b" => false,
        _ => return None,
    };
    let n: usize = num.parse().ok()?;
    if !(1..=12).contains(&n) {
        return None;
    }
    let minor_pitch = MINOR_PITCH[n - 1];
    Some(if minor {
        format!("{}m", NAMES[minor_pitch as usize])
    } else {
        NAMES[((minor_pitch + 3) % 12) as usize].to_string()
    })
}

/// `persistent_id` から安定した id (1..2^53-1) を導く。衝突したら次の空きへ。
pub fn stable_id(persistent_id: &str, taken: &mut HashSet<u64>) -> u64 {
    const MASK: u64 = (1 << 53) - 1;
    let base = u64::from_str_radix(persistent_id.trim(), 16)
        .ok()
        .filter(|_| !persistent_id.trim().is_empty())
        .unwrap_or_else(|| {
            // hex でない ID (想定外) は FNV-1a で。
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            for b in persistent_id.as_bytes() {
                h = (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
            }
            h
        });
    let mut id = (base & MASK).max(1);
    while taken.contains(&id) {
        id = if id >= MASK { 1 } else { id + 1 };
    }
    taken.insert(id);
    id
}

/// ISO8601 等の先頭 `YYYY-MM-DD` を取り出す。
pub fn date_ymd(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    let d = s.get(0..10)?;
    let b = d.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    ok.then(|| d.to_string())
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn track_label(t: &Track) -> String {
    let title = non_empty(&t.name).unwrap_or_else(|| "(無題)".into());
    match t.location_path.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => format!("{title} — {p}"),
        None => format!("{title} — (パスなし)"),
    }
}

// ============================================================ tree

/// 内部表現: track_id でトラックを指すプレイリスト木。
#[derive(Debug)]
enum Node {
    Folder {
        name: String,
        id: u64,
        children: Vec<Node>,
    },
    List {
        name: String,
        id: u64,
        tracks: Vec<i64>,
    },
}

struct TreeBuilder<'a> {
    db: &'a Database,
    children: HashMap<String, Vec<&'a Playlist>>,
    playlist_ids: HashSet<u64>,
    /// 初出順のトラック。
    order: Vec<i64>,
    tracks: HashMap<i64, Track>,
    visited: HashSet<i64>,
    folders: usize,
    lists: usize,
}

impl<'a> TreeBuilder<'a> {
    fn add_track(&mut self, t: Track) -> i64 {
        let id = t.track_id;
        if !self.tracks.contains_key(&id) {
            self.order.push(id);
            self.tracks.insert(id, t);
        }
        id
    }

    fn node_id(&mut self, pl: &Playlist) -> u64 {
        let key = pl
            .persistent_id
            .clone()
            .unwrap_or_else(|| format!("playlist:{}", pl.playlist_id));
        stable_id(&key, &mut self.playlist_ids)
    }

    fn build(&mut self, pl: &'a Playlist, depth: usize) -> Result<Option<Node>, String> {
        if depth > MAX_DEPTH || !self.visited.insert(pl.playlist_id) {
            return Ok(None);
        }
        let id = self.node_id(pl);
        if pl.is_folder {
            self.folders += 1;
            let kids: Vec<&Playlist> = pl
                .persistent_id
                .as_ref()
                .and_then(|pid| self.children.get(pid))
                .cloned()
                .unwrap_or_default();
            let mut children = Vec::with_capacity(kids.len());
            for child in kids {
                if let Some(n) = self.build(child, depth + 1)? {
                    children.push(n);
                }
            }
            return Ok(Some(Node::Folder {
                name: pl.name.clone(),
                id,
                children,
            }));
        }
        self.lists += 1;
        let mut ids = Vec::new();
        if pl.is_smart {
            let ts = self
                .db
                .get_smart_playlist_tracks_filtered(
                    pl.playlist_id,
                    None,
                    SMART_LIMIT,
                    0,
                    None,
                    None,
                )
                .map_err(|e| format!("スマートプレイリスト「{}」の評価に失敗: {e}", pl.name))?;
            for t in ts {
                ids.push(self.add_track(t));
            }
        } else {
            let tids = self
                .db
                .get_playlist_track_ids(pl.playlist_id)
                .map_err(|e| format!("プレイリスト「{}」の読み込みに失敗: {e}", pl.name))?;
            for tid in tids {
                if self.tracks.contains_key(&tid) {
                    ids.push(tid);
                    continue;
                }
                if let Some(t) = self
                    .db
                    .get_track_by_track_id(tid)
                    .map_err(|e| format!("曲の読み込みに失敗: {e}"))?
                {
                    ids.push(self.add_track(t));
                }
            }
        }
        Ok(Some(Node::List {
            name: pl.name.clone(),
            id,
            tracks: ids,
        }))
    }
}

fn to_input(node: Node, refs: &HashMap<i64, String>) -> PlaylistInput {
    match node {
        Node::Folder { name, id, children } => PlaylistInput {
            name,
            id: Some(id),
            folder: true,
            children: children.into_iter().map(|c| to_input(c, refs)).collect(),
            tracks: Vec::new(),
        },
        Node::List { name, id, tracks } => PlaylistInput {
            name,
            id: Some(id),
            folder: false,
            children: Vec::new(),
            tracks: tracks
                .into_iter()
                .filter_map(|t| refs.get(&t).cloned())
                .collect(),
        },
    }
}

/// 選択プレイリストから rbx-cli のリクエストを作る。DB は 1 つの読み取りトランザクション内で読む。
/// `file_size` はファイルが存在すればそのサイズを返す (テストで差し替える)。
pub fn build_request(
    db: &Database,
    opts: &UsbExportOptions,
    traktor: Option<TraktorInput<'_>>,
    file_size: &dyn Fn(&str) -> Option<u64>,
) -> Result<Built, String> {
    let snapshot = db
        .read_txn()
        .map_err(|e| format!("ライブラリの読み取りに失敗: {e}"))?;

    let playlists = db
        .get_playlists()
        .map_err(|e| format!("プレイリストの読み込みに失敗: {e}"))?;
    let by_pid: HashMap<&str, &Playlist> = playlists
        .iter()
        .filter_map(|p| p.persistent_id.as_deref().map(|pid| (pid, p)))
        .collect();
    let mut children: HashMap<String, Vec<&Playlist>> = HashMap::new();
    for p in &playlists {
        if let Some(parent) = p.parent_persistent_id.as_deref().filter(|s| !s.is_empty()) {
            children.entry(parent.to_string()).or_default().push(p);
        }
    }

    // 選択の正規化: 祖先が選ばれているものは除く (フォルダごと書き出されるため)。
    let selected: HashSet<i64> = opts.playlist_ids.iter().copied().collect();
    let has_selected_ancestor = |p: &Playlist| {
        let mut parent = p.parent_persistent_id.as_deref();
        let mut guard = 0;
        while let Some(pid) = parent.filter(|s| !s.is_empty()) {
            guard += 1;
            if guard > MAX_DEPTH {
                break;
            }
            match by_pid.get(pid) {
                Some(pp) if selected.contains(&pp.playlist_id) => return true,
                Some(pp) => parent = pp.parent_persistent_id.as_deref(),
                None => break,
            }
        }
        false
    };
    let roots: Vec<&Playlist> = playlists
        .iter()
        .filter(|p| selected.contains(&p.playlist_id) && !has_selected_ancestor(p))
        .collect();
    if roots.is_empty() {
        return Err("書き出すプレイリストが選ばれていません".to_string());
    }

    let mut tb = TreeBuilder {
        db,
        children,
        playlist_ids: HashSet::new(),
        order: Vec::new(),
        tracks: HashMap::new(),
        visited: HashSet::new(),
        folders: 0,
        lists: 0,
    };
    let mut nodes = Vec::new();
    for root in roots {
        if let Some(n) = tb.build(root, 0)? {
            nodes.push(n);
        }
    }

    // 解析結果 (キー) をまとめて引く。
    let pids: Vec<String> = tb
        .order
        .iter()
        .filter_map(|id| tb.tracks.get(id).and_then(|t| t.persistent_id.clone()))
        .collect();
    let analysis: HashMap<String, Option<String>> = db
        .get_analysis_by_persistent_ids(&pids, false)
        .map_err(|e| format!("解析結果の読み込みに失敗: {e}"))?
        .into_iter()
        .map(|(pid, a)| (pid, a.key_camelot))
        .collect();
    drop(snapshot);

    let mut report = BuildReport {
        playlists: tb.lists,
        folders: tb.folders,
        ..Default::default()
    };
    let mut traktor_report = traktor.as_ref().map(|t| TraktorReport {
        nml_path: t.nml_path.clone(),
        entries: t.index.len(),
        mp3_offset_ms: opts.mp3_offset_ms,
        cues_sent: !opts.prefer_device_cues,
        ..Default::default()
    });
    let offsets = CodecOffsets {
        mp3_ms: opts.mp3_offset_ms,
    };

    let mut refs: HashMap<i64, String> = HashMap::new();
    let mut by_path: HashMap<String, String> = HashMap::new();
    let mut track_ids: HashSet<u64> = HashSet::new();
    let mut inputs: Vec<TrackInput> = Vec::with_capacity(tb.order.len());
    for tid in &tb.order {
        let Some(t) = tb.tracks.get(tid) else {
            continue;
        };
        let path = t.location_path.as_deref().map(str::trim).unwrap_or("");
        // パスの無い曲は rbx-cli に渡せない (`path` は必須) ので送らない。
        // ファイルが見つからない曲は **そのまま送る**: rbx-cli は、以前書き出していない曲は
        // スキップし、以前この USB に書き出した曲なら USB を変更せずに `conflict`
        // (`source_unavailable`) で止める。ここで落とすと、外付けドライブ未接続などで
        // プレイリストから曲が消え、「USB から消す」がオンだと USB からも削除されてしまう。
        let size = if path.is_empty() {
            None
        } else {
            file_size(path)
        };
        if size.is_none() {
            report.missing += 1;
            if report.missing_examples.len() < MAX_EXAMPLES {
                report.missing_examples.push(track_label(t));
            }
            if path.is_empty() {
                continue;
            }
        } else {
            report.found += 1;
        }
        // 同じファイルを指す別の曲は 1 曲にまとめる (USB には 1 回だけ書く)。
        if let Some(existing) = by_path.get(path) {
            refs.insert(*tid, existing.clone());
            continue;
        }
        let pid = t
            .persistent_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("track:{}", t.track_id));
        let reference = pid.clone();
        refs.insert(*tid, reference.clone());
        by_path.insert(path.to_string(), reference.clone());

        let effective_key = t
            .key_camelot_user
            .clone()
            .or_else(|| analysis.get(&pid).cloned().flatten());
        let mut input = TrackInput {
            path: path.to_string(),
            reference: Some(reference),
            id: Some(stable_id(&pid, &mut track_ids)),
            title: non_empty(&t.name),
            artist: non_empty(&t.artist),
            album: non_empty(&t.album),
            genre: non_empty(&t.genre),
            key: effective_key.as_deref().and_then(camelot_to_rekordbox),
            comment: non_empty(&t.comments),
            rating: rating_to_stars(t.rating),
            year: t.year.filter(|y| (1..=9999).contains(y)).map(|y| y as u16),
            date_added: date_ymd(t.date_added.as_deref()),
            duration_sec: t
                .total_time_ms
                .filter(|ms| *ms > 0)
                .map(|ms| ((ms + 500) / 1000) as u32),
            track_number: t
                .track_number
                .filter(|n| *n > 0 && *n <= u32::MAX as i64)
                .map(|n| n as u32),
            disc_number: t
                .disc_number
                .filter(|n| *n > 0 && *n <= u16::MAX as i64)
                .map(|n| n as u16),
            play_count: t
                .play_count
                .filter(|n| *n >= 0 && *n <= u32::MAX as i64)
                .map(|n| n as u32),
            beat_grid: None,
            cues: None,
        };

        if let (Some(tk), Some(rep)) = (traktor.as_ref(), traktor_report.as_mut()) {
            // サイズが分からない (ファイルが無い) ときはパス一致だけ (名前 + サイズのフォールバックはしない)。
            match tk.index.find(path, size) {
                Lookup::Match(entry, kind) => {
                    rep.matched += 1;
                    if kind == MatchKind::NameSize {
                        rep.matched_by_name += 1;
                    }
                    let mapped = map_entry(entry, offsets.for_path(path));
                    if mapped.grid.is_some() {
                        rep.with_grid += 1;
                    }
                    input.beat_grid = mapped.grid;
                    if !opts.prefer_device_cues {
                        if !mapped.cues.is_empty() {
                            rep.with_cues += 1;
                        }
                        input.cues = Some(mapped.cues);
                    }
                }
                Lookup::Ambiguous => {
                    // 別ボリュームの同じパス / 同名・同サイズが複数 → どれか決めず送らない。
                    rep.unmatched += 1;
                    rep.ambiguous += 1;
                    if rep.ambiguous_examples.len() < MAX_EXAMPLES {
                        rep.ambiguous_examples.push(track_label(t));
                    }
                }
                Lookup::NotFound => {
                    rep.unmatched += 1;
                    if rep.unmatched_examples.len() < MAX_EXAMPLES {
                        rep.unmatched_examples.push(track_label(t));
                    }
                }
            }
        }
        inputs.push(input);
    }

    report.tracks = inputs.len();
    if report.missing > 0 {
        report.warnings.push(format!(
            "ファイルが見つからない曲が {} 曲あります。以前この USB に書き出していない曲はスキップされます。以前書き出した曲が含まれていると、USB を変更せずに書き出しが中止されます（外付けドライブを接続するか、曲の場所を直してから書き出してください）。",
            report.missing
        ));
    }
    if let Some(rep) = &traktor_report {
        if rep.matched_by_name > 0 {
            report.warnings.push(format!(
                "{} 曲はパスが一致せず、ファイル名とサイズで Traktor の曲と対応付けました。",
                rep.matched_by_name
            ));
        }
        if rep.ambiguous > 0 {
            report.warnings.push(format!(
                "{} 曲は Traktor のコレクションに候補が複数あり（別のボリュームに同じパスの曲がある等）、どれか決められないため Traktor のキュー/グリッドを使いません（USB 上のキューを残し、グリッドは解析）。",
                rep.ambiguous
            ));
        }
        if rep.cues_sent && rep.matched > rep.with_cues {
            report.warnings.push(format!(
                "Traktor にキューが無い {} 曲は、USB 上のキューが消えます（Traktor の状態に合わせます）。",
                rep.matched - rep.with_cues
            ));
        }
    }
    if report.found == 0 {
        report.warnings.push(
            "書き出せる曲がありません（プレイリストが空か、ファイルが見つかりません）。".into(),
        );
    }
    report.traktor = traktor_report;

    let device_name = opts
        .device_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let request = ExportRequest {
        protocol: PROTOCOL_VERSION,
        options: ExportOptions {
            analyze: "missing".into(),
            read_tags: true,
            embedded_artwork: opts.artwork,
            prune: opts.prune,
            device_name,
        },
        tracks: inputs,
        playlists: nodes.into_iter().map(|n| to_input(n, &refs)).collect(),
    };
    Ok(Built { request, report })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SmartCriteria, SmartOp, SmartRule, TrackAnalysis};
    use crate::traktor_nml::path::PathStyle;
    use crate::traktor_nml::{NmlCue, NmlEntry};
    use crate::usb_export::wire::CueKind;

    #[test]
    fn rating_maps_to_stars() {
        assert_eq!(rating_to_stars(None), None);
        assert_eq!(rating_to_stars(Some(0)), Some(0));
        assert_eq!(rating_to_stars(Some(20)), Some(1));
        assert_eq!(rating_to_stars(Some(60)), Some(3));
        assert_eq!(rating_to_stars(Some(70)), Some(4)); // ★3.5 → 4
        assert_eq!(rating_to_stars(Some(10)), Some(1)); // ★0.5 → 1
        assert_eq!(rating_to_stars(Some(100)), Some(5));
        assert_eq!(rating_to_stars(Some(250)), Some(5));
        assert_eq!(rating_to_stars(Some(-5)), Some(0));
    }

    #[test]
    fn camelot_converts_to_rekordbox_spelling() {
        assert_eq!(camelot_to_rekordbox("8A").as_deref(), Some("Am"));
        assert_eq!(camelot_to_rekordbox("8B").as_deref(), Some("C"));
        assert_eq!(camelot_to_rekordbox("1A").as_deref(), Some("Abm"));
        assert_eq!(camelot_to_rekordbox("1B").as_deref(), Some("B"));
        assert_eq!(camelot_to_rekordbox("11A").as_deref(), Some("F#m"));
        assert_eq!(camelot_to_rekordbox("2B").as_deref(), Some("F#"));
        assert_eq!(camelot_to_rekordbox("3B").as_deref(), Some("Db"));
        assert_eq!(camelot_to_rekordbox(" 5a ").as_deref(), Some("Cm"));
        assert_eq!(camelot_to_rekordbox("13A"), None);
        assert_eq!(camelot_to_rekordbox("Am"), None);
        assert_eq!(camelot_to_rekordbox(""), None);
        // 24 キーすべてが異なる綴りになる。
        let all: HashSet<String> = (1..=12)
            .flat_map(|n| [format!("{n}A"), format!("{n}B")])
            .filter_map(|k| camelot_to_rekordbox(&k))
            .collect();
        assert_eq!(all.len(), 24);
    }

    #[test]
    fn stable_ids_come_from_persistent_ids() {
        let mut taken = HashSet::new();
        let a = stable_id("00000000000000FF", &mut taken);
        assert_eq!(a, 255);
        // 同じ値が既に使われていれば次の空き。
        let b = stable_id("00000000000000FF", &mut taken);
        assert_eq!(b, 256);
        // 上位ビットは 53 bit に畳む。
        let c = stable_id("FFFFFFFFFFFFFFFF", &mut taken);
        assert_eq!(c, (1 << 53) - 1);
        // 0 は 1 に。hex でなくても決定的。
        let mut t2 = HashSet::new();
        assert_eq!(stable_id("0000000000000000", &mut t2), 1);
        let x = stable_id("not-hex", &mut HashSet::new());
        assert_eq!(x, stable_id("not-hex", &mut HashSet::new()));
        assert!((1..(1 << 53)).contains(&x));
    }

    #[test]
    fn dates_are_trimmed_to_ymd() {
        assert_eq!(
            date_ymd(Some("2024-05-01T12:00:00Z")).as_deref(),
            Some("2024-05-01")
        );
        assert_eq!(date_ymd(Some("2024-05-01")).as_deref(), Some("2024-05-01"));
        assert_eq!(date_ymd(Some("May 1")), None);
        assert_eq!(date_ymd(Some("2024/05/01")), None);
        assert_eq!(date_ymd(None), None);
    }

    // ---------------------------------------------------------- DB fixtures

    fn add_track(db: &Database, name: &str, path: &str) -> i64 {
        db.add_imported_track(
            Some(name),
            Some("Artist"),
            None,
            Some("Album"),
            Some("House"),
            Some(2024),
            Some(3),
            None,
            Some(1),
            None,
            Some(301_400),
            path,
            &format!("file://{path}"),
        )
        .unwrap()
    }

    fn pid(db: &Database, track_id: i64) -> String {
        db.get_track_by_track_id(track_id)
            .unwrap()
            .unwrap()
            .persistent_id
            .unwrap()
    }

    fn existing(paths: &'static [&'static str]) -> impl Fn(&str) -> Option<u64> {
        move |p: &str| paths.contains(&p).then_some(12_001_000)
    }

    struct Fixture {
        db: Database,
        folder: Playlist,
        sub: Playlist,
        smart: Playlist,
        a: i64,
        b: i64,
        c: i64,
    }

    fn fixture() -> Fixture {
        let db = Database::open_memory().unwrap();
        let a = add_track(&db, "Alpha", "/music/a.mp3");
        let b = add_track(&db, "Bravo", "/music/b.flac");
        let c = add_track(&db, "Charlie", "/music/gone.mp3");
        db.set_rating(a, 70).unwrap();
        db.update_track(
            b,
            &crate::models::TrackEdit {
                key_camelot_user: Some(Some("11A".into())),
                comments: Some("hi".into()),
                ..Default::default()
            },
        )
        .unwrap();
        // a は解析キー 8A を持つ。
        db.upsert_analysis(
            &pid(&db, a),
            &TrackAnalysis {
                track_id: a,
                version: 1,
                analyzed_at: "2026-01-01".into(),
                bpm: Some(124.0),
                key_camelot: Some("8A".into()),
                key_name: None,
                key_camelot_user: None,
                energy: None,
                loudness_lufs: None,
                replaygain_db: None,
                vector: vec![],
                peaks: vec![],
            },
        )
        .unwrap();

        let folder = db.create_playlist("Gigs", None, true).unwrap();
        let sub = db
            .create_playlist("Friday", folder.persistent_id.as_deref(), false)
            .unwrap();
        db.add_tracks_to_playlist(sub.playlist_id, &[a, c, b, a])
            .unwrap();
        let smart = db
            .create_smart_playlist(
                "Bravo only",
                &SmartCriteria {
                    match_all: true,
                    rules: vec![SmartRule {
                        field: "name".into(),
                        op: SmartOp::Is,
                        value: "Bravo".into(),
                    }],
                    limit: None,
                    sort_by: None,
                    sort_desc: false,
                },
            )
            .unwrap();
        Fixture {
            db,
            folder,
            sub,
            smart,
            a,
            b,
            c,
        }
    }

    #[test]
    fn builds_the_tree_tracks_and_metadata() {
        let f = fixture();
        let opts = UsbExportOptions {
            playlist_ids: vec![f.folder.playlist_id, f.sub.playlist_id, f.smart.playlist_id],
            destination: "/Volumes/STICK".into(),
            device_name: Some("  STICK ".into()),
            ..Default::default()
        };
        let built = build_request(
            &f.db,
            &opts,
            None,
            &existing(&["/music/a.mp3", "/music/b.flac"]),
        )
        .unwrap();
        let req = &built.request;
        assert_eq!(req.protocol, 1);
        assert_eq!(req.options.analyze, "missing");
        assert!(req.options.prune && req.options.embedded_artwork);
        assert_eq!(req.options.device_name.as_deref(), Some("STICK"));

        // 曲は初出順・重複なし。見つからない曲も送る (USB を守る判断は rbx-cli に任せる)。
        let paths: Vec<&str> = req.tracks.iter().map(|t| t.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["/music/a.mp3", "/music/gone.mp3", "/music/b.flac"]
        );
        let a = &req.tracks[0];
        assert_eq!(a.reference.as_deref(), Some(pid(&f.db, f.a).as_str()));
        assert_eq!(a.title.as_deref(), Some("Alpha"));
        assert_eq!(a.artist.as_deref(), Some("Artist"));
        assert_eq!(a.album.as_deref(), Some("Album"));
        assert_eq!(a.genre.as_deref(), Some("House"));
        assert_eq!(a.year, Some(2024));
        assert_eq!(a.track_number, Some(3));
        assert_eq!(a.disc_number, Some(1));
        assert_eq!(a.duration_sec, Some(301));
        assert_eq!(a.rating, Some(4));
        assert_eq!(a.key.as_deref(), Some("Am"), "analysis key 8A");
        assert!(a.date_added.as_deref().is_some_and(|d| d.len() == 10));
        assert!(a.id.is_some());
        assert_eq!(a.cues, None, "no Traktor → cues omitted");
        assert_eq!(a.beat_grid, None);
        let gone = &req.tracks[1];
        assert_eq!(gone.title.as_deref(), Some("Charlie"));
        assert_eq!(gone.reference.as_deref(), Some(pid(&f.db, f.c).as_str()));
        let b = &req.tracks[2];
        assert_eq!(b.key.as_deref(), Some("F#m"), "user override 11A wins");
        assert_eq!(b.comment.as_deref(), Some("hi"));
        assert_eq!(b.rating, None);
        let json = serde_json::to_value(req).unwrap();
        assert!(json["tracks"][0].get("bpm").is_none(), "BPM is never sent");

        // フォルダを選ぶと配下ごと。子 (Friday) の重複選択は無視される。
        assert_eq!(req.playlists.len(), 2);
        let gigs = &req.playlists[0];
        assert!(gigs.folder);
        assert_eq!(gigs.name, "Gigs");
        assert_eq!(gigs.children.len(), 1);
        let friday = &gigs.children[0];
        assert_eq!(friday.name, "Friday");
        let ra = pid(&f.db, f.a);
        let rb = pid(&f.db, f.b);
        let rc = pid(&f.db, f.c);
        assert_eq!(friday.tracks, vec![ra.clone(), rc, rb.clone(), ra.clone()]);
        let smart = &req.playlists[1];
        assert_eq!(smart.name, "Bravo only");
        assert_eq!(smart.tracks, vec![rb]);
        // プレイリスト id は一意で安定。
        let again = build_request(
            &f.db,
            &opts,
            None,
            &existing(&["/music/a.mp3", "/music/b.flac"]),
        )
        .unwrap();
        assert_eq!(again.request, built.request);
        assert_ne!(gigs.id, friday.id);

        // レポート。
        let r = &built.report;
        assert_eq!(r.tracks, 3);
        assert_eq!(r.found, 2);
        assert_eq!(r.playlists, 2);
        assert_eq!(r.folders, 1);
        assert_eq!(r.missing, 1);
        assert!(r.missing_examples[0].contains("Charlie"));
        assert!(r
            .warnings
            .iter()
            .any(|w| w.contains("見つからない曲が 1 曲")));
    }

    #[test]
    fn selecting_nothing_is_an_error() {
        let f = fixture();
        let err = build_request(&f.db, &UsbExportOptions::default(), None, &|_| Some(1))
            .err()
            .unwrap();
        assert!(err.contains("選ばれていません"));
    }

    fn nml_index() -> NmlIndex {
        NmlIndex::new(
            vec![
                NmlEntry {
                    volume: "Macintosh HD".into(),
                    dir: "/:music/:".into(),
                    file: "a.mp3".into(),
                    file_size_kb: Some(11720),
                    bpm: Some(124.0),
                    cues: vec![
                        NmlCue {
                            name: "AutoGrid".into(),
                            kind: 4,
                            start_ms: 50.0,
                            len_ms: 0.0,
                            hotcue: -1,
                        },
                        NmlCue {
                            name: "Drop".into(),
                            kind: 0,
                            start_ms: 1000.0,
                            len_ms: 0.0,
                            hotcue: 0,
                        },
                    ],
                },
                // b.flac は別の場所にあるがサイズ一致 → 名前 + サイズで一致。キュー無し。
                NmlEntry {
                    volume: "Old".into(),
                    dir: "/:elsewhere/:".into(),
                    file: "b.flac".into(),
                    file_size_kb: Some(11720),
                    bpm: None,
                    cues: vec![],
                },
            ],
            PathStyle::Unix,
        )
    }

    #[test]
    fn traktor_cues_and_grids_are_attached_to_matched_tracks() {
        let f = fixture();
        let extra = add_track(&f.db, "Delta", "/music/d.wav");
        f.db.add_tracks_to_playlist(f.sub.playlist_id, &[extra])
            .unwrap();
        let idx = nml_index();
        let opts = UsbExportOptions {
            playlist_ids: vec![f.folder.playlist_id],
            use_traktor: true,
            mp3_offset_ms: 10.0,
            ..Default::default()
        };
        let built = build_request(
            &f.db,
            &opts,
            Some(TraktorInput {
                nml_path: "/x/collection.nml".into(),
                index: &idx,
            }),
            &existing(&["/music/a.mp3", "/music/b.flac", "/music/d.wav"]),
        )
        .unwrap();
        let t = &built.request.tracks;
        assert_eq!(t[1].path, "/music/gone.mp3");
        // a: パス一致、MP3 オフセット +10ms。
        let grid = t[0].beat_grid.as_ref().unwrap();
        assert_eq!(grid.anchors[0].time_ms, 60.0);
        assert_eq!(grid.anchors[0].bpm, 124.0);
        let cues = t[0].cues.as_ref().unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].kind, CueKind::Hot);
        assert_eq!(cues[0].slot.as_deref(), Some("A"));
        assert_eq!(cues[0].time_ms, 1010.0);
        // gone: ファイルが無く NML にも無い → 両方省略 (名前 + サイズの照合もしない)。
        assert_eq!(t[1].cues, None);
        assert_eq!(t[1].beat_grid, None);
        // b: 名前 + サイズで一致、キュー無し → 空配列 (USB のキューを消す)、グリッド無し → 省略。
        assert_eq!(t[2].cues, Some(vec![]));
        assert_eq!(t[2].beat_grid, None);
        // d: NML に無い → 両方省略。
        assert_eq!(t[3].path, "/music/d.wav");
        assert_eq!(t[3].cues, None);
        assert_eq!(t[3].beat_grid, None);

        let rep = built.report.traktor.as_ref().unwrap();
        assert_eq!(rep.entries, 2);
        assert_eq!(rep.matched, 2);
        assert_eq!(rep.matched_by_name, 1);
        assert_eq!(rep.unmatched, 2);
        assert!(rep.unmatched_examples.iter().any(|x| x.contains("Delta")));
        assert_eq!(rep.with_cues, 1);
        assert_eq!(rep.with_grid, 1);
        assert!(rep.cues_sent);
        assert!(built
            .report
            .warnings
            .iter()
            .any(|w| w.contains("ファイル名とサイズ")));

        // 「USB 上のキューを優先」: cues は省略、グリッドは送る。
        let prefer = UsbExportOptions {
            prefer_device_cues: true,
            ..opts.clone()
        };
        let built = build_request(
            &f.db,
            &prefer,
            Some(TraktorInput {
                nml_path: "/x/collection.nml".into(),
                index: &idx,
            }),
            &existing(&["/music/a.mp3", "/music/b.flac", "/music/d.wav"]),
        )
        .unwrap();
        assert_eq!(built.request.tracks[0].cues, None);
        assert!(built.request.tracks[0].beat_grid.is_some());
        assert_eq!(built.request.tracks[2].cues, None);
        assert!(!built.report.traktor.unwrap().cues_sent);
    }

    #[test]
    fn same_file_in_two_library_entries_is_written_once() {
        let f = fixture();
        let dup = add_track(&f.db, "Alpha (dup)", "/music/a.mp3");
        let pl = f.db.create_playlist("Dups", None, false).unwrap();
        f.db.add_tracks_to_playlist(pl.playlist_id, &[f.a, dup])
            .unwrap();
        let built = build_request(
            &f.db,
            &UsbExportOptions {
                playlist_ids: vec![pl.playlist_id],
                ..Default::default()
            },
            None,
            &existing(&["/music/a.mp3"]),
        )
        .unwrap();
        assert_eq!(built.request.tracks.len(), 1);
        let ra = pid(&f.db, f.a);
        assert_eq!(built.request.playlists[0].tracks, vec![ra.clone(), ra]);
    }
    #[test]
    fn missing_files_are_sent_and_matched_by_path_only() {
        let f = fixture();
        let nopath = add_track(&f.db, "No path", "");
        let pl = f.db.create_playlist("Gone", None, false).unwrap();
        f.db.add_tracks_to_playlist(pl.playlist_id, &[f.c, nopath])
            .unwrap();
        // gone.mp3 は NML ではパスが一致する / 別の場所の同名ファイルは名前 + サイズでは採らない。
        let idx = NmlIndex::new(
            vec![NmlEntry {
                volume: "".into(),
                dir: "/:music/:".into(),
                file: "gone.mp3".into(),
                file_size_kb: Some(11720),
                bpm: Some(120.0),
                cues: vec![],
            }],
            PathStyle::Unix,
        );
        let built = build_request(
            &f.db,
            &UsbExportOptions {
                playlist_ids: vec![pl.playlist_id],
                use_traktor: true,
                ..Default::default()
            },
            Some(TraktorInput {
                nml_path: "x".into(),
                index: &idx,
            }),
            &existing(&[]),
        )
        .unwrap();
        // パスの無い曲だけは送れない。見つからない曲はそのまま送る (プレイリストからも消さない)。
        assert_eq!(built.request.tracks.len(), 1);
        assert_eq!(built.request.tracks[0].path, "/music/gone.mp3");
        assert_eq!(built.request.tracks[0].cues, Some(vec![]));
        assert_eq!(
            built.request.playlists[0].tracks,
            vec![pid(&f.db, f.c)],
            "the missing track stays in its playlist"
        );
        assert_eq!(built.report.missing, 2);
        assert_eq!(built.report.found, 0);
        assert_eq!(built.report.traktor.as_ref().unwrap().matched, 1);
        assert!(built
            .report
            .warnings
            .iter()
            .any(|w| w.contains("書き出せる曲がありません")));

        // 別の場所にある同名・同サイズの NML エントリは、サイズが分からないので採用しない。
        let moved = NmlIndex::new(
            vec![NmlEntry {
                volume: "".into(),
                dir: "/:elsewhere/:".into(),
                file: "gone.mp3".into(),
                file_size_kb: Some(11720),
                bpm: Some(120.0),
                cues: vec![],
            }],
            PathStyle::Unix,
        );
        let built = build_request(
            &f.db,
            &UsbExportOptions {
                playlist_ids: vec![pl.playlist_id],
                use_traktor: true,
                ..Default::default()
            },
            Some(TraktorInput {
                nml_path: "x".into(),
                index: &moved,
            }),
            &existing(&[]),
        )
        .unwrap();
        assert_eq!(built.request.tracks[0].cues, None);
        assert_eq!(built.report.traktor.as_ref().unwrap().unmatched, 1);
    }
    #[test]
    fn ambiguous_traktor_entries_are_reported_and_not_used() {
        let f = fixture();
        let entry = |volume: &str, bpm: f64| NmlEntry {
            volume: volume.into(),
            dir: "/:music/:".into(),
            file: "a.mp3".into(),
            file_size_kb: Some(11720),
            bpm: Some(bpm),
            cues: vec![],
        };
        let idx = NmlIndex::with_boot_volume(
            vec![entry("Backup", 128.0), entry("Macintosh HD", 124.0)],
            PathStyle::Unix,
            None,
        );
        let opts = UsbExportOptions {
            playlist_ids: vec![f.sub.playlist_id],
            use_traktor: true,
            ..Default::default()
        };
        let build = |idx: &NmlIndex| {
            build_request(
                &f.db,
                &opts,
                Some(TraktorInput {
                    nml_path: "x".into(),
                    index: idx,
                }),
                &existing(&["/music/a.mp3", "/music/b.flac"]),
            )
            .unwrap()
        };
        let built = build(&idx);
        assert_eq!(built.request.tracks[0].path, "/music/a.mp3");
        assert_eq!(built.request.tracks[0].cues, None);
        assert_eq!(built.request.tracks[0].beat_grid, None);
        let rep = built.report.traktor.as_ref().unwrap();
        assert_eq!(rep.ambiguous, 1);
        assert!(rep.ambiguous_examples[0].contains("Alpha"));
        assert!(built
            .report
            .warnings
            .iter()
            .any(|w| w.contains("候補が複数")));

        // 起動ボリュームのエントリがあればそれを使う。
        let idx = NmlIndex::with_boot_volume(
            vec![entry("Backup", 128.0), entry("Macintosh HD", 124.0)],
            PathStyle::Unix,
            Some("Macintosh HD"),
        );
        let built = build(&idx);
        assert_eq!(built.report.traktor.as_ref().unwrap().ambiguous, 0);
        assert_eq!(built.request.tracks[0].cues, Some(vec![]));
    }
}
