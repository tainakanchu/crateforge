//! スマートプレイリストのメンバー解決 (プレイリスト参照つき)。
//!
//! 1 回の評価パス (= [`PlaylistResolver`] の寿命) の中で全曲・解析結果を一度だけ読み、
//! 参照先プレイリストのメンバーをメモ化する。参照先の種類ごとの扱い:
//! - スマート (criteria あり): criteria 自身の並び + limit まで適用した結果
//!   (UI の並び替え・プレイリスト内検索は関係しない)。参照先がさらに参照していても再帰的に解決する。
//! - フォルダ: 子孫プレイリスト (それぞれスマート考慮) の和集合。
//! - 通常: `playlist_tracks` の静的メンバー。
//! - 存在しない: 空集合 (`is` → 偽 / `isNot` → 真)。
//!
//! 循環参照は評価中スタックで検出し、循環した参照を空集合として扱ってログに残す。

use std::collections::{HashMap, HashSet};

use rusqlite::Result;

use super::Database;
use crate::models::{SmartCriteria, Track, TrackAnalysis};
use crate::smart::{self, EvalContext};
use crate::text_fold::FoldLevel;

struct PlaylistRow {
    persistent_id: Option<String>,
    is_folder: bool,
    criteria: Option<SmartCriteria>,
}

/// 評価パスで共有する全曲 + 解析結果。スマート評価が必要になった時点で一度だけ読む。
struct Library {
    tracks: Vec<Track>,
    analysis: HashMap<i64, TrackAnalysis>,
    /// track_id → `tracks` の添字。
    index: HashMap<i64, usize>,
}

/// 解決済みメンバー。順序付きの列と、参照判定用の集合を両方持つ。
struct Resolved {
    ids: Vec<i64>,
    set: HashSet<i64>,
}

/// スマート考慮のプレイリストメンバー解決器。1 回の評価パスごとに作り直す
/// (作成後の DB 変更は反映しない)。
pub struct PlaylistResolver<'db> {
    db: &'db Database,
    rows: HashMap<i64, PlaylistRow>,
    by_pid: HashMap<String, i64>,
    /// 親 persistent_id → 子 playlist_id (sort_order 順)。
    children: HashMap<String, Vec<i64>>,
    level: FoldLevel,
    library: Option<Library>,
    memo: HashMap<i64, Resolved>,
    /// 評価中のプレイリスト (循環検出用スタック)。
    visiting: Vec<i64>,
}

impl Database {
    /// プレイリスト一覧を読み込んだ解決器を作る。全曲の読み込みは遅延 (必要になるまで読まない)。
    pub fn playlist_resolver(&self) -> Result<PlaylistResolver<'_>> {
        let mut stmt = self.conn.prepare(
            "SELECT playlist_id, persistent_id, parent_persistent_id, is_folder, smart_criteria
             FROM playlists ORDER BY sort_order, name",
        )?;
        let raw = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i32>(3)? != 0,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>>>()?;

        let mut rows = HashMap::new();
        let mut by_pid = HashMap::new();
        let mut children: HashMap<String, Vec<i64>> = HashMap::new();
        for (playlist_id, persistent_id, parent, is_folder, criteria_json) in raw {
            // 壊れた JSON は get_smart_criteria と同じく「条件なし」扱い。
            let criteria = criteria_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<SmartCriteria>(s).ok());
            if let Some(pid) = persistent_id.as_ref().filter(|p| !p.is_empty()) {
                by_pid.entry(pid.clone()).or_insert(playlist_id);
            }
            if let Some(parent) = parent.filter(|p| !p.is_empty()) {
                children.entry(parent).or_default().push(playlist_id);
            }
            rows.insert(
                playlist_id,
                PlaylistRow {
                    persistent_id,
                    is_folder,
                    criteria,
                },
            );
        }

        let level = FoldLevel::from_state(
            self.get_state("search_fold_level")
                .ok()
                .flatten()
                .as_deref(),
        );
        Ok(PlaylistResolver {
            db: self,
            rows,
            by_pid,
            children,
            level,
            library: None,
            memo: HashMap::new(),
            visiting: Vec::new(),
        })
    }
}

impl PlaylistResolver<'_> {
    /// スマートプレイリスト (フォルダ以外で criteria を持つ) か。
    pub fn is_smart(&self, playlist_id: i64) -> bool {
        self.rows
            .get(&playlist_id)
            .is_some_and(|r| !r.is_folder && r.criteria.is_some())
    }

    /// プレイリストのメンバー (track_id) を順序付きで返す。スマートは criteria の並び + limit、
    /// 通常は sort_index 順、フォルダは子孫の和集合 (出現順)、存在しなければ空。
    pub fn track_ids(&mut self, playlist_id: i64) -> Result<Vec<i64>> {
        Ok(self
            .resolve(playlist_id)?
            .map(|r| r.ids.clone())
            .unwrap_or_default())
    }

    /// スマートプレイリストの評価結果 (criteria の並び + limit 適用済み) を曲で返す。
    /// criteria を持たない (通常・フォルダ・存在しない) なら None。
    pub fn smart_tracks(&mut self, playlist_id: i64) -> Result<Option<Vec<Track>>> {
        if !self.is_smart(playlist_id) {
            return Ok(None);
        }
        let ids = self.track_ids(playlist_id)?;
        self.ensure_library()?;
        let lib = self.library.as_ref().expect("library loaded");
        Ok(Some(
            ids.iter()
                .filter_map(|id| lib.index.get(id).map(|&i| lib.tracks[i].clone()))
                .collect(),
        ))
    }

    fn ensure_library(&mut self) -> Result<()> {
        if self.library.is_none() {
            let tracks = self.db.get_all_tracks()?;
            let analysis = self
                .db
                .get_all_analysis()?
                .into_iter()
                .map(|a| (a.track_id, a))
                .collect();
            let index = tracks
                .iter()
                .enumerate()
                .map(|(i, t)| (t.track_id, i))
                .collect();
            self.library = Some(Library {
                tracks,
                analysis,
                index,
            });
        }
        Ok(())
    }

    /// メモ化つきの解決。循環 (評価中のプレイリストを再び参照) なら None。
    fn resolve(&mut self, playlist_id: i64) -> Result<Option<&Resolved>> {
        if !self.memo.contains_key(&playlist_id) {
            if self.visiting.contains(&playlist_id) {
                let chain = self
                    .visiting
                    .iter()
                    .chain(std::iter::once(&playlist_id))
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(" -> ");
                crate::logging::write_line(
                    "warn",
                    &format!(
                        "smart playlist: 循環参照を検出したため空集合として扱います ({chain})"
                    ),
                );
                return Ok(None);
            }
            self.visiting.push(playlist_id);
            let computed = self.compute(playlist_id);
            self.visiting.pop();
            let ids = computed?;
            let set = ids.iter().copied().collect();
            self.memo.insert(playlist_id, Resolved { ids, set });
        }
        Ok(self.memo.get(&playlist_id))
    }

    fn compute(&mut self, playlist_id: i64) -> Result<Vec<i64>> {
        let Some(row) = self.rows.get(&playlist_id) else {
            return Ok(Vec::new());
        };
        if row.is_folder {
            // フォルダは子孫の和集合 (重複を除いて出現順)。フォルダ自身は決してスマートにしない。
            let child_ids = row
                .persistent_id
                .as_ref()
                .and_then(|pid| self.children.get(pid))
                .cloned()
                .unwrap_or_default();
            let mut out = Vec::new();
            let mut seen = HashSet::new();
            for child in child_ids {
                if let Some(r) = self.resolve(child)? {
                    for &tid in &r.ids {
                        if seen.insert(tid) {
                            out.push(tid);
                        }
                    }
                }
            }
            return Ok(out);
        }
        if let Some(criteria) = row.criteria.clone() {
            return self.evaluate(&criteria);
        }
        self.db.get_static_playlist_track_ids(playlist_id)
    }

    /// criteria を評価して track_id を criteria の並び + limit で返す。
    /// 評価中のプレイリストは呼び出し側で `visiting` に積んでおくこと。
    fn evaluate(&mut self, criteria: &SmartCriteria) -> Result<Vec<i64>> {
        let mut membership: HashMap<String, HashSet<i64>> = HashMap::new();
        for pid in smart::referenced_playlists(criteria) {
            let set = match self.by_pid.get(&pid).copied() {
                Some(target) => self
                    .resolve(target)?
                    .map(|r| r.set.clone())
                    .unwrap_or_default(),
                None => HashSet::new(),
            };
            membership.insert(pid, set);
        }

        self.ensure_library()?;
        let lib = self.library.as_ref().expect("library loaded");
        let ctx = EvalContext {
            level: self.level,
            membership: &membership,
        };
        let mut matched: Vec<usize> = (0..lib.tracks.len())
            .filter(|&i| {
                let t = &lib.tracks[i];
                smart::track_matches(t, lib.analysis.get(&t.track_id), criteria, &ctx)
            })
            .collect();
        // criteria 自身の並び (無ければ name 昇順、第 2 キー以降は then_by)。limit はこの並びで切る。
        matched
            .sort_by(|&a, &b| smart::compare_by_criteria(&lib.tracks[a], &lib.tracks[b], criteria));
        if let Some(limit) = criteria.limit {
            matched.truncate(limit);
        }
        Ok(matched
            .into_iter()
            .map(|i| lib.tracks[i].track_id)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SmartGroup, SmartOp, SmartRule};

    fn rule(field: &str, op: SmartOp, value: &str) -> SmartRule {
        SmartRule {
            field: field.into(),
            op,
            value: value.into(),
        }
    }

    fn criteria(rules: Vec<SmartRule>) -> SmartCriteria {
        SmartCriteria {
            match_all: true,
            rules,
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        }
    }

    /// 曲 1..6 (genre と bpm)、プレイリスト:
    /// - 10 Static (P010): 静的 [3, 1, 5]
    /// - 20 Folder (P020) の中に 21 Child A (静的 [2]) と 22 Child B (静的 [4, 2])
    /// - 30 / 31 / 32 はテストごとに条件を付けるスマート用
    fn db() -> Database {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO tracks (track_id, name, genre, bpm, file_exists) VALUES
                   (1, 'a', 'House', 120, 1),
                   (2, 'b', 'House', 128, 1),
                   (3, 'c', 'Techno', 130, 1),
                   (4, 'd', 'Techno', 140, 1),
                   (5, 'e', 'IDM', 100, 1),
                   (6, 'f', 'House', 124, 1);
                 INSERT INTO playlists (playlist_id, persistent_id, parent_persistent_id, name, is_folder, sort_order) VALUES
                   (10, 'P010', NULL, 'Static', 0, 1),
                   (20, 'P020', NULL, 'Folder', 1, 2),
                   (21, 'P021', 'P020', 'Child A', 0, 3),
                   (22, 'P022', 'P020', 'Child B', 0, 4),
                   (30, 'P030', NULL, 'Smart 30', 0, 5),
                   (31, 'P031', NULL, 'Smart 31', 0, 6),
                   (32, 'P032', NULL, 'Smart 32', 0, 7);
                 INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES
                   (10, 3, 0), (10, 1, 1), (10, 5, 2),
                   (21, 2, 0),
                   (22, 4, 0), (22, 2, 1),
                   (30, 6, 0);",
            )
            .unwrap();
        db
    }

    fn ids(db: &Database, playlist_id: i64) -> Vec<i64> {
        db.get_playlist_track_ids(playlist_id).unwrap()
    }

    #[test]
    fn static_and_folder_membership() {
        let db = db();
        let mut r = db.playlist_resolver().unwrap();
        assert_eq!(r.track_ids(10).unwrap(), vec![3, 1, 5]);
        // フォルダは子孫の和集合 (重複なし、出現順)。
        assert_eq!(r.track_ids(20).unwrap(), vec![2, 4]);
        assert!(r.track_ids(999).unwrap().is_empty());

        // スマート: フォルダ参照は和集合で判定。
        db.set_smart_criteria(30, &criteria(vec![rule("playlist", SmartOp::Is, "P020")]))
            .unwrap();
        assert_eq!(ids(&db, 30), vec![2, 4]);
    }

    /// スマートがスマートを参照する (iTunes の Favorite J-POP → Favorite SONGS と同じ形)。
    #[test]
    fn smart_of_smart() {
        let db = db();
        // 31 = House (1, 2, 6)
        db.set_smart_criteria(31, &criteria(vec![rule("genre", SmartOp::Is, "House")]))
            .unwrap();
        // 30 = 31 に含まれ、かつ bpm >= 124 → 2, 6。静的な行 (6) は無視されライブ評価になる。
        db.set_smart_criteria(
            30,
            &criteria(vec![
                rule("playlist", SmartOp::Is, "P031"),
                rule("bpm", SmartOp::Gte, "124"),
            ]),
        )
        .unwrap();
        assert_eq!(ids(&db, 30), vec![2, 6]);
        // 31 の定義を変えると 30 にも伝わる。
        db.set_smart_criteria(31, &criteria(vec![rule("genre", SmartOp::Is, "Techno")]))
            .unwrap();
        assert_eq!(ids(&db, 30), vec![3, 4]);

        // isNot + 入れ子グループ: Static (3,1,5) に含まれない ANY[House, IDM]。
        let mut c = criteria(vec![rule("playlist", SmartOp::IsNot, "P010")]);
        c.groups = vec![SmartGroup {
            match_all: false,
            rules: vec![
                rule("genre", SmartOp::Is, "House"),
                rule("genre", SmartOp::Is, "IDM"),
            ],
            groups: vec![],
        }];
        db.set_smart_criteria(32, &c).unwrap();
        assert_eq!(ids(&db, 32), vec![2, 6]);
    }

    #[test]
    fn missing_target_is_empty() {
        let db = db();
        db.set_smart_criteria(30, &criteria(vec![rule("playlist", SmartOp::Is, "NOPE")]))
            .unwrap();
        assert!(ids(&db, 30).is_empty());
        db.set_smart_criteria(
            30,
            &criteria(vec![rule("playlist", SmartOp::IsNot, "NOPE")]),
        )
        .unwrap();
        assert_eq!(ids(&db, 30), vec![1, 2, 3, 4, 5, 6]);
    }

    /// 循環 (30 → 31 → 30) は循環した参照を空集合として扱い、無限再帰しない。
    #[test]
    fn cycle_is_treated_as_empty() {
        let db = db();
        db.set_smart_criteria(30, &criteria(vec![rule("playlist", SmartOp::Is, "P031")]))
            .unwrap();
        db.set_smart_criteria(31, &criteria(vec![rule("playlist", SmartOp::Is, "P030")]))
            .unwrap();
        assert!(ids(&db, 30).is_empty());
        assert!(ids(&db, 31).is_empty());
        // 自己参照の isNot: 自分 = 空集合扱いなので全曲。
        db.set_smart_criteria(
            32,
            &criteria(vec![rule("playlist", SmartOp::IsNot, "P032")]),
        )
        .unwrap();
        assert_eq!(ids(&db, 32).len(), 6);
    }

    /// 参照先の limit (criteria 自身の並びで切った結果) が尊重される。
    #[test]
    fn referenced_limit_is_respected() {
        let db = db();
        // 31 = bpm 降順の上位 2 曲 → 4 (140), 3 (130)。
        let mut top = criteria(vec![]);
        top.limit = Some(2);
        top.sort_by = Some("bpm".into());
        top.sort_desc = true;
        db.set_smart_criteria(31, &top).unwrap();
        assert_eq!(ids(&db, 31), vec![4, 3]);
        db.set_smart_criteria(30, &criteria(vec![rule("playlist", SmartOp::Is, "P031")]))
            .unwrap();
        assert_eq!(ids(&db, 30), vec![3, 4]);
    }

    /// 外向きの読み出し (get_playlist_tracks / get_playlist_track_ids) はスマートならライブ評価、
    /// 静的な行が必要な経路向けの get_static_* は保存行のまま。
    #[test]
    fn outward_reads_are_live_for_smart_playlists() {
        let db = db();
        db.set_smart_criteria(30, &criteria(vec![rule("genre", SmartOp::Is, "Techno")]))
            .unwrap();
        let tracks: Vec<i64> = db
            .get_playlist_tracks(30, 100, 0, None, None)
            .unwrap()
            .into_iter()
            .map(|t| t.track_id)
            .collect();
        assert_eq!(tracks, vec![3, 4]);
        // UI の並び替えは表示順だけ変える。
        let desc: Vec<i64> = db
            .get_playlist_tracks(30, 100, 0, Some("bpm"), Some("desc"))
            .unwrap()
            .into_iter()
            .map(|t| t.track_id)
            .collect();
        assert_eq!(desc, vec![4, 3]);
        assert_eq!(db.get_playlist_track_ids(30).unwrap(), vec![3, 4]);
        assert_eq!(db.get_static_playlist_track_ids(30).unwrap(), vec![6]);
        assert_eq!(
            db.get_static_playlist_tracks(30)
                .unwrap()
                .into_iter()
                .map(|t| t.track_id)
                .collect::<Vec<_>>(),
            vec![6]
        );
        // 通常プレイリストは従来どおり。
        assert_eq!(db.get_playlist_track_ids(10).unwrap(), vec![3, 1, 5]);
    }

    /// limit 付きスマートは、UI の並び替えをしても選ばれる曲は変わらない。
    #[test]
    fn ui_sort_does_not_change_limited_selection() {
        let db = db();
        let mut c = criteria(vec![rule("genre", SmartOp::Is, "House")]);
        c.limit = Some(2);
        c.sort_by = Some("bpm".into());
        db.set_smart_criteria(30, &c).unwrap();
        // bpm 昇順の上位 2 曲 = 1 (120), 6 (124)。name 降順で表示しても同じ 2 曲。
        let shown: Vec<i64> = db
            .get_playlist_tracks(30, 100, 0, Some("name"), Some("desc"))
            .unwrap()
            .into_iter()
            .map(|t| t.track_id)
            .collect();
        assert_eq!(shown, vec![6, 1]);
    }
}
