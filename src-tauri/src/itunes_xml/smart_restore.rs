//! iTunes のスマートプレイリスト条件を DB のプレイリストへ適用する。
//!
//! iTunes XML 取り込み後のパスと、既存ライブラリ向けの「スマートプレイリストを復元」
//! コマンドの共通処理。プレイリストは `Playlist Persistent ID` で突き合わせ、条件中の
//! プレイリスト参照は次の順で解決する:
//! 1. その PID を持つ DB のプレイリスト
//! 2. 渡された XML のどれかにその PID のプレイリストがあれば、その名前で DB の
//!    (フォルダ以外の) プレイリストを引き、ちょうど 1 件ならその PID に付け替える
//!    (iTunes がライブラリ移行後も古い PID を条件に残していることがあるため)
//! 3. それでも見つからなければ元の PID のまま残し (評価時は「存在しない = 空」)、未解決として報告する

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::parser::{RawPlaylist, RawTrack};
use super::smart_criteria::decode_smart_playlist;
use crate::db::Database;
use crate::models::SmartCriteria;
use crate::smart::PLAYLIST_FIELD;

/// 復元結果の 1 プレイリスト分の状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SmartRestoreStatus {
    /// 条件を変換して保存した。
    Converted,
    /// 既に条件があるので触らなかった (上書きしない設定)。
    SkippedExisting,
    /// 変換できなかった (理由は message)。
    Failed,
    /// フォルダの条件は無視した (フォルダはスマートにしない)。
    FolderIgnored,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartRestoreEntry {
    pub name: String,
    pub persistent_id: String,
    pub status: SmartRestoreStatus,
    pub message: Option<String>,
    pub warnings: Vec<String>,
}

/// 解決できなかったプレイリスト参照。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedRef {
    /// 参照を含むプレイリストの名前。
    pub playlist_name: String,
    /// 参照先の PID (条件にはこのまま残る)。
    pub persistent_id: String,
    /// XML 上で分かった参照先の名前 (分かれば)。
    pub ref_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartRestoreReport {
    pub converted: usize,
    pub skipped_existing: usize,
    pub failed: usize,
    pub folders_ignored: usize,
    /// XML のスマートプレイリストのうち、同じ PID のプレイリストが DB に無かった数。
    pub no_matching_playlist: usize,
    /// XML の "Grouping" で埋めた曲数 (復元コマンドのみ)。
    pub grouping_backfilled: usize,
    pub playlists: Vec<SmartRestoreEntry>,
    pub unresolved_refs: Vec<UnresolvedRef>,
}

/// XML 1 ファイルから取り出した、復元に必要な情報だけの軽量表現
/// (80MB 級の XML を複数読んでも生のパース結果を抱え続けないように)。
pub struct XmlSmartSource {
    playlists: Vec<SourcePlaylist>,
    /// (曲の persistent_id, Grouping)。
    groupings: Vec<(String, String)>,
}

struct SourcePlaylist {
    persistent_id: String,
    name: String,
    is_folder: bool,
    criteria: Option<Vec<u8>>,
    info: Option<Vec<u8>>,
}

impl XmlSmartSource {
    pub fn from_raw(tracks: &[RawTrack], playlists: &[RawPlaylist]) -> Self {
        let playlists = playlists
            .iter()
            // ライブラリ本体・iTunes 組み込み (ミュージック等) は取り込み対象外なので除く。
            .filter(|p| !p.get_bool("Master") && p.get_int("Distinguished Kind").is_none())
            .filter_map(|p| {
                let persistent_id = p
                    .get_str("Playlist Persistent ID")
                    .filter(|id| !id.is_empty())?
                    .to_string();
                Some(SourcePlaylist {
                    persistent_id,
                    name: p.get_str("Name").unwrap_or("Untitled").to_string(),
                    is_folder: p.get_bool("Folder"),
                    criteria: p.get_data("Smart Criteria"),
                    info: p.get_data("Smart Info"),
                })
            })
            .collect();
        let groupings = tracks
            .iter()
            .filter_map(|t| {
                let pid = t.get_str("Persistent ID").filter(|s| !s.is_empty())?;
                let grouping = t
                    .get_str("Grouping")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())?;
                Some((pid.to_string(), grouping.to_string()))
            })
            .collect();
        XmlSmartSource {
            playlists,
            groupings,
        }
    }

    pub fn from_file(path: &str) -> Result<Self, String> {
        let (tracks, playlists) = super::parser::parse_library_file(path)?;
        Ok(Self::from_raw(&tracks, &playlists))
    }
}

struct DbPlaylist {
    playlist_id: i64,
    is_folder: bool,
    has_criteria: bool,
}

/// 渡された XML (先頭ほど優先) のスマートプレイリスト条件を DB へ適用する。
/// トランザクションは呼び出し側で張ること (取り込み中は取り込みのトランザクション内で呼ぶ)。
pub fn apply_smart_sources(
    db: &Database,
    sources: &[XmlSmartSource],
    overwrite: bool,
) -> rusqlite::Result<SmartRestoreReport> {
    let mut report = SmartRestoreReport::default();

    // XML 上の PID → 名前 (別名解決用、先頭のファイルを優先)。
    let mut xml_names: HashMap<&str, &str> = HashMap::new();
    for source in sources {
        for p in &source.playlists {
            xml_names
                .entry(p.persistent_id.as_str())
                .or_insert(p.name.as_str());
        }
    }

    // DB のプレイリスト索引。
    let mut by_pid: HashMap<String, DbPlaylist> = HashMap::new();
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for p in db.get_playlists()? {
        let Some(pid) = p.persistent_id.clone().filter(|s| !s.is_empty()) else {
            continue;
        };
        if !p.is_folder {
            by_name.entry(p.name.clone()).or_default().push(pid.clone());
        }
        let has_criteria = db.get_smart_criteria(p.playlist_id)?.is_some();
        by_pid.insert(
            pid,
            DbPlaylist {
                playlist_id: p.playlist_id,
                is_folder: p.is_folder,
                has_criteria,
            },
        );
    }

    let mut seen: HashSet<&str> = HashSet::new();
    for source in sources {
        for p in &source.playlists {
            let Some(criteria_blob) = p.criteria.as_deref() else {
                continue;
            };
            // 同じ PID が複数ファイルにあれば先頭のファイルを採用する。
            if !seen.insert(p.persistent_id.as_str()) {
                continue;
            }
            let Some(target) = by_pid.get(&p.persistent_id) else {
                report.no_matching_playlist += 1;
                continue;
            };
            let mut entry = SmartRestoreEntry {
                name: p.name.clone(),
                persistent_id: p.persistent_id.clone(),
                status: SmartRestoreStatus::Converted,
                message: None,
                warnings: Vec::new(),
            };
            if p.is_folder || target.is_folder {
                entry.status = SmartRestoreStatus::FolderIgnored;
                entry.message = Some("フォルダの条件は無視しました".to_string());
                report.folders_ignored += 1;
                report.playlists.push(entry);
                continue;
            }
            if target.has_criteria && !overwrite {
                entry.status = SmartRestoreStatus::SkippedExisting;
                entry.message = Some("既に条件があるため変更しませんでした".to_string());
                report.skipped_existing += 1;
                report.playlists.push(entry);
                continue;
            }

            let decoded = decode_smart_playlist(criteria_blob, p.info.as_deref());
            entry.warnings = decoded.warnings;
            let mut criteria = match decoded.result {
                Ok(c) => c,
                Err(reason) => {
                    entry.status = SmartRestoreStatus::Failed;
                    entry.message = Some(reason);
                    report.failed += 1;
                    report.playlists.push(entry);
                    continue;
                }
            };

            resolve_references(
                &mut criteria,
                &p.name,
                &by_pid,
                &by_name,
                &xml_names,
                &mut entry.warnings,
                &mut report.unresolved_refs,
            );

            let playlist_id = target.playlist_id;
            db.set_smart_criteria(playlist_id, &criteria)?;
            if let Some(t) = by_pid.get_mut(&p.persistent_id) {
                t.has_criteria = true;
            }
            report.converted += 1;
            report.playlists.push(entry);
        }
    }

    // Grouping の後付け (DB 側が未設定の曲だけ)。先頭のファイルの値が優先される。
    for source in sources {
        for (pid, grouping) in &source.groupings {
            if db.fill_track_grouping_by_persistent_id(pid, grouping)? {
                report.grouping_backfilled += 1;
            }
        }
    }

    Ok(report)
}

/// 条件中のプレイリスト参照を DB の PID に解決する (モジュール先頭のコメント参照)。
#[allow(clippy::too_many_arguments)]
fn resolve_references(
    criteria: &mut SmartCriteria,
    playlist_name: &str,
    by_pid: &HashMap<String, DbPlaylist>,
    by_name: &HashMap<String, Vec<String>>,
    xml_names: &HashMap<&str, &str>,
    warnings: &mut Vec<String>,
    unresolved: &mut Vec<UnresolvedRef>,
) {
    crate::smart::for_each_rule_mut(criteria, &mut |rule| {
        if rule.field != PLAYLIST_FIELD {
            return;
        }
        let pid = rule.value.trim().to_string();
        if by_pid.contains_key(&pid) {
            return;
        }
        let ref_name = xml_names.get(pid.as_str()).copied();
        if let Some(name) = ref_name {
            if let Some([only]) = by_name.get(name).map(Vec::as_slice) {
                warnings.push(format!(
                    "参照先「{name}」({pid}) を名前で解決しました ({only})"
                ));
                rule.value = only.clone();
                return;
            }
        }
        warnings.push(match ref_name {
            Some(name) => format!("参照先「{name}」({pid}) が見つかりません"),
            None => format!("参照先 ({pid}) が見つかりません"),
        });
        let item = UnresolvedRef {
            playlist_name: playlist_name.to_string(),
            persistent_id: pid,
            ref_name: ref_name.map(str::to_string),
        };
        if !unresolved.contains(&item) {
            unresolved.push(item);
        }
    });
}

/// 復元コマンド本体: XML を順に読み、1 トランザクションで適用する (曲・プレイリストは取り込まない)。
pub fn restore_from_files(
    db: &Database,
    paths: &[String],
    overwrite: bool,
) -> Result<SmartRestoreReport, String> {
    if paths.is_empty() {
        return Err("XML ファイルを選択してください".to_string());
    }
    let sources = paths
        .iter()
        .map(|p| XmlSmartSource::from_file(p).map_err(|e| format!("{p}: {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    let tx = db.write_txn().map_err(|e| e.to_string())?;
    let report = apply_smart_sources(db, &sources, overwrite).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    log_report("restore", &report);
    Ok(report)
}

/// 結果の要約と警告をログに残す。
pub fn log_report(context: &str, report: &SmartRestoreReport) {
    if report.playlists.is_empty() && report.grouping_backfilled == 0 {
        return;
    }
    crate::logging::write_line(
        "info",
        &format!(
            "itunes smart playlists ({context}): converted={} skipped={} failed={} folders={} no_match={} unresolved={} grouping={}",
            report.converted,
            report.skipped_existing,
            report.failed,
            report.folders_ignored,
            report.no_matching_playlist,
            report.unresolved_refs.len(),
            report.grouping_backfilled,
        ),
    );
    for entry in &report.playlists {
        for w in entry.warnings.iter().chain(entry.message.iter()) {
            crate::logging::write_line(
                "warn",
                &format!("itunes smart playlist '{}': {w}", entry.name),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::smart_criteria::fixtures::*;
    use super::*;
    use crate::models::{SmartGroup, SmartOp, SmartRule};

    const SONGS_PID: &str = "C8EA7D9C323131DF";
    const OLD_SONGS_PID: &str = "3C0E5A28D090134F";
    const TAIWAN_PID: &str = "E53CF75F65F5BE6E";
    const OLD_TAIWAN_PID: &str = "B873A90DB6BAA17B";
    const FAV_TAIWAN_PID: &str = "C7D0A19E9FD296B2";
    const FAV_JPOP_PID: &str = "D6DDCCBCC745E045";
    const FAV_IDOL_PID: &str = "DD832CD875A4F4D8";

    /// (Track ID, Persistent ID, Name, Genre, Rating, Grouping)。
    type XmlTrack<'a> = (i64, &'a str, &'a str, &'a str, i64, Option<&'a str>);

    struct XmlPlaylist<'a> {
        name: &'a str,
        pid: &'a str,
        smart: Option<(&'a str, &'a str)>,
        items: &'a [i64],
    }

    fn pl<'a>(name: &'a str, pid: &'a str, smart: Option<(&'a str, &'a str)>) -> XmlPlaylist<'a> {
        XmlPlaylist {
            name,
            pid,
            smart,
            items: &[],
        }
    }

    /// 最小限の iTunes Library XML を組み立てる。tracks = (Track ID, Persistent ID, Name, Genre, Rating, Grouping)。
    fn library_xml(
        tracks: &[XmlTrack],
        playlists: &[XmlPlaylist],
    ) -> String {
        let mut x = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n<key>Tracks</key>\n<dict>\n",
        );
        for (id, pid, name, genre, rating, grouping) in tracks {
            x.push_str(&format!(
                "<key>{id}</key>\n<dict>\n<key>Track ID</key><integer>{id}</integer>\n<key>Persistent ID</key><string>{pid}</string>\n<key>Name</key><string>{name}</string>\n<key>Genre</key><string>{genre}</string>\n<key>Rating</key><integer>{rating}</integer>\n<key>Date Modified</key><date>2024-01-01T00:00:00Z</date>\n"
            ));
            if let Some(g) = grouping {
                x.push_str(&format!("<key>Grouping</key><string>{g}</string>\n"));
            }
            x.push_str("</dict>\n");
        }
        x.push_str("</dict>\n<key>Playlists</key>\n<array>\n");
        x.push_str("<dict>\n<key>Name</key><string>Library</string>\n<key>Master</key><true/>\n<key>Playlist ID</key><integer>1</integer>\n<key>Playlist Persistent ID</key><string>0000000000000001</string>\n</dict>\n");
        for (i, p) in playlists.iter().enumerate() {
            x.push_str(&format!(
                "<dict>\n<key>Name</key><string>{}</string>\n<key>Playlist ID</key><integer>{}</integer>\n<key>Playlist Persistent ID</key><string>{}</string>\n",
                p.name,
                100 + i,
                p.pid
            ));
            if let Some((criteria, info)) = p.smart {
                // 実ファイル同様、base64 を改行・タブで折り返す。
                let wrap = |b64: &str| {
                    b64.as_bytes()
                        .chunks(60)
                        .map(|c| format!("\t\t\t{}", std::str::from_utf8(c).unwrap()))
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                x.push_str(&format!(
                    "<key>Smart Info</key>\n<data>\n{}\n</data>\n<key>Smart Criteria</key>\n<data>\n{}\n</data>\n",
                    wrap(info),
                    wrap(criteria)
                ));
            }
            if !p.items.is_empty() {
                x.push_str("<key>Playlist Items</key>\n<array>\n");
                for id in p.items {
                    x.push_str(&format!(
                        "<dict>\n<key>Track ID</key><integer>{id}</integer>\n</dict>\n"
                    ));
                }
                x.push_str("</array>\n");
            }
            x.push_str("</dict>\n");
        }
        x.push_str("</array>\n</dict>\n</plist>\n");
        x
    }

    fn write(dir: &tempfile::TempDir, name: &str, content: &str) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        path.to_string_lossy().to_string()
    }

    /// 既存ライブラリ (2023 年版の XML から取り込み済み、スマートは静的スナップショット) を模した DB。
    /// 曲: 1 = J-POP ★5 / 2 = Soundtrack ★5 / 3 = 台湾 ★4 / 4 = 台湾 ★2 / 5 = Idol ★5 (grouping は空)。
    fn library_db() -> Database {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute_batch(&format!(
                "INSERT INTO tracks (track_id, persistent_id, name, genre, rating, grouping, file_exists) VALUES
                   (1, 'T000000000000001', 'One',   'J-POP',      100, NULL,   1),
                   (2, 'T000000000000002', 'Two',   'Soundtrack', 100, NULL,   1),
                   (3, 'T000000000000003', 'Three', 'Mandopop',    80, NULL,   1),
                   (4, 'T000000000000004', 'Four',  'Mandopop',    40, NULL,   1),
                   (5, 'T000000000000005', 'Five',  'Idol',       100, 'Keep', 1);
                 INSERT INTO playlists (playlist_id, persistent_id, name, is_smart, sort_order) VALUES
                   (10, '{SONGS_PID}', 'Favorite SONGS', 0, 1),
                   (11, '{TAIWAN_PID}', '台湾音楽', 0, 2),
                   (12, '{FAV_TAIWAN_PID}', 'Favorite 台湾音楽', 0, 3),
                   (13, '{FAV_JPOP_PID}', 'Favorite J-POP', 0, 4),
                   (14, '{FAV_IDOL_PID}', 'Favorite アイドル', 0, 5);
                 INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES
                   (11, 3, 0), (11, 4, 1),
                   (12, 2, 0);"
            ))
            .unwrap();
        db
    }

    /// 2023 年版: 条件は現行 PID と、旧ライブラリの PID (台湾音楽) が混在する。
    fn current_xml() -> String {
        library_xml(
            &[
                (1, "T000000000000001", "One", "J-POP", 100, Some("Pop")),
                (5, "T000000000000005", "Five", "Idol", 100, Some("Idol")),
            ],
            &[
                pl(
                    "Favorite SONGS",
                    SONGS_PID,
                    Some((SONGS_CRITERIA, SONGS_INFO)),
                ),
                pl("台湾音楽", TAIWAN_PID, None),
                pl(
                    "Favorite 台湾音楽",
                    FAV_TAIWAN_PID,
                    Some((TAIWAN_CRITERIA, TAIWAN_INFO)),
                ),
                pl(
                    "Favorite J-POP",
                    FAV_JPOP_PID,
                    Some((JPOP_CRITERIA, JPOP_INFO)),
                ),
                pl(
                    "Favorite アイドル",
                    FAV_IDOL_PID,
                    Some((IDOL_CRITERIA, IDOL_INFO)),
                ),
                // DB に無いスマートプレイリスト。
                pl(
                    "Ghost",
                    "ABCDEF0123456789",
                    Some((SONGS_CRITERIA, SONGS_INFO)),
                ),
            ],
        )
    }

    /// 2022 年版: 旧 PID のプレイリスト名だけが分かればよい。
    fn old_xml() -> String {
        library_xml(
            &[(1, "T000000000000001", "One", "J-POP", 100, Some("OldPop"))],
            &[
                pl(
                    "Favorite SONGS",
                    OLD_SONGS_PID,
                    Some((SONGS_CRITERIA, SONGS_INFO)),
                ),
                pl("台湾音楽", OLD_TAIWAN_PID, None),
                // 同じ PID が後ろのファイルにもある → 先頭のファイルが優先される。
                pl(
                    "Favorite 台湾音楽",
                    FAV_TAIWAN_PID,
                    Some((SONGS_CRITERIA, SONGS_INFO)),
                ),
            ],
        )
    }

    fn entry<'a>(report: &'a SmartRestoreReport, pid: &str) -> &'a SmartRestoreEntry {
        report
            .playlists
            .iter()
            .find(|e| e.persistent_id == pid)
            .unwrap_or_else(|| panic!("no entry for {pid}: {:?}", report.playlists))
    }

    fn grouping_of(db: &Database, track_id: i64) -> Option<String> {
        db.conn
            .query_row(
                "SELECT grouping FROM tracks WHERE track_id = ?1",
                [track_id],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// 既存ライブラリへの復元: 旧 PID は 2 つ目の XML の名前で解決され、既に条件がある行は
    /// 上書きしない設定ならそのまま。Grouping は空の曲だけ埋める。
    #[test]
    fn restore_resolves_aliases_and_backfills_grouping() {
        let dir = tempfile::tempdir().unwrap();
        let current = write(&dir, "current.xml", &current_xml());
        let old = write(&dir, "old.xml", &old_xml());
        let db = library_db();
        // Favorite J-POP はローカルで条件を編集済み。
        let local = SmartCriteria {
            match_all: true,
            rules: vec![SmartRule {
                field: "genre".into(),
                op: SmartOp::Is,
                value: "J-POP".into(),
            }],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        db.set_smart_criteria(13, &local).unwrap();

        let report = restore_from_files(&db, &[current.clone(), old.clone()], false).unwrap();
        assert_eq!(report.converted, 3, "{report:?}");
        assert_eq!(report.skipped_existing, 1);
        assert_eq!(report.failed, 0);
        // Ghost (現行 XML) と旧 PID の Favorite SONGS (旧 XML) は DB に同じ PID が無い。
        assert_eq!(report.no_matching_playlist, 2);
        assert!(
            report.unresolved_refs.is_empty(),
            "{:?}",
            report.unresolved_refs
        );
        assert_eq!(
            entry(&report, FAV_JPOP_PID).status,
            SmartRestoreStatus::SkippedExisting
        );
        assert_eq!(db.get_smart_criteria(13).unwrap(), Some(local.clone()));

        // 台湾: 旧 PID → 名前 → 現行 PID に付け替わる (先頭ファイルの条件が採用される)。
        let taiwan = db.get_smart_criteria(12).unwrap().unwrap();
        assert_eq!(
            taiwan.rules,
            vec![
                SmartRule {
                    field: "playlist".into(),
                    op: SmartOp::Is,
                    value: SONGS_PID.into(),
                },
                SmartRule {
                    field: "playlist".into(),
                    op: SmartOp::Is,
                    value: TAIWAN_PID.into(),
                },
            ]
        );
        let warnings = &entry(&report, FAV_TAIWAN_PID).warnings;
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings.iter().all(|w| w.contains("名前で解決")));
        let row: (i64, i64) = db
            .conn
            .query_row(
                "SELECT is_smart, (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = 12)
                 FROM playlists WHERE playlist_id = 12",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        // スマートになっても静的な行は残る (条件がある間は無視される)。
        assert_eq!(row, (1, 1));

        // ライブ評価: Favorite SONGS (★>2.45 かつ Soundtrack 以外) ∩ 台湾音楽 (3, 4) = 3。
        assert_eq!(db.get_playlist_track_ids(10).unwrap(), vec![5, 1, 3]);
        assert_eq!(db.get_playlist_track_ids(12).unwrap(), vec![3]);

        // Grouping: 空だった曲 1 だけ埋まる (先頭ファイルの値)。曲 5 の既存値は残る。
        assert_eq!(report.grouping_backfilled, 1);
        assert_eq!(grouping_of(&db, 1).as_deref(), Some("Pop"));
        assert_eq!(grouping_of(&db, 5).as_deref(), Some("Keep"));

        // アイドル: grouping の条件も保存される。
        let idol = db.get_smart_criteria(14).unwrap().unwrap();
        assert_eq!(idol.rules[0].field, "grouping");

        // 上書きあり: ローカル編集済みの J-POP も iTunes の条件で置き換わる。
        let report = restore_from_files(&db, &[current, old], true).unwrap();
        assert_eq!(report.skipped_existing, 0);
        assert_eq!(report.converted, 4);
        let jpop = db.get_smart_criteria(13).unwrap().unwrap();
        assert_eq!(
            jpop.rules,
            vec![SmartRule {
                field: "playlist".into(),
                op: SmartOp::Is,
                value: SONGS_PID.into(),
            }]
        );
        assert_eq!(
            jpop.groups,
            vec![SmartGroup {
                match_all: false,
                rules: vec![
                    SmartRule {
                        field: "genre".into(),
                        op: SmartOp::Contains,
                        value: "J-POP".into(),
                    },
                    SmartRule {
                        field: "genre".into(),
                        op: SmartOp::Contains,
                        value: "J-Indie".into(),
                    },
                ],
                groups: vec![],
            }]
        );
        assert_eq!(db.get_playlist_track_ids(13).unwrap(), vec![1]);
    }

    /// 旧 XML を渡さなければ旧 PID は解決できず、未解決として報告して PID のまま残す。
    #[test]
    fn restore_reports_unresolved_references() {
        let dir = tempfile::tempdir().unwrap();
        let current = write(&dir, "current.xml", &current_xml());
        let db = library_db();
        let report = restore_from_files(&db, &[current], false).unwrap();
        assert_eq!(report.converted, 4);
        assert_eq!(
            report.unresolved_refs,
            vec![
                UnresolvedRef {
                    playlist_name: "Favorite 台湾音楽".into(),
                    persistent_id: OLD_SONGS_PID.into(),
                    ref_name: None,
                },
                UnresolvedRef {
                    playlist_name: "Favorite 台湾音楽".into(),
                    persistent_id: OLD_TAIWAN_PID.into(),
                    ref_name: None,
                },
            ]
        );
        let taiwan = db.get_smart_criteria(12).unwrap().unwrap();
        assert_eq!(taiwan.rules[0].value, OLD_SONGS_PID);
        // 存在しない参照先は空集合なので、どの曲にも一致しない。
        assert!(db.get_playlist_track_ids(12).unwrap().is_empty());
    }

    /// 通常の iTunes XML 取り込み: スマートプレイリストは取り込み後に変換され is_smart が立つ。
    /// 再取り込みではローカルで編集した条件を保持する。
    #[test]
    fn import_converts_smart_playlists_and_preserves_local_edits() {
        let dir = tempfile::tempdir().unwrap();
        let xml = library_xml(
            &[
                (1, "T000000000000001", "One", "J-POP", 100, Some("Idol")),
                (2, "T000000000000002", "Two", "Soundtrack", 100, None),
                (3, "T000000000000003", "Three", "J-Indie", 20, None),
            ],
            &[
                // 参照元が参照先より前にあっても解決できる。
                XmlPlaylist {
                    name: "Favorite J-POP",
                    pid: FAV_JPOP_PID,
                    smart: Some((JPOP_CRITERIA, JPOP_INFO)),
                    items: &[1, 3],
                },
                XmlPlaylist {
                    name: "Favorite SONGS",
                    pid: SONGS_PID,
                    smart: Some((SONGS_CRITERIA, SONGS_INFO)),
                    items: &[1, 2],
                },
                XmlPlaylist {
                    name: "Static",
                    pid: "5555555555555555",
                    smart: None,
                    items: &[2],
                },
            ],
        );
        let path = write(&dir, "lib.xml", &xml);
        let db = Database::open_memory().unwrap();
        super::super::parser::import_library(&path, &db).unwrap();

        let smart_flags: Vec<(String, i64)> = {
            let mut stmt = db
                .conn
                .prepare("SELECT name, is_smart FROM playlists ORDER BY sort_order")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert_eq!(
            smart_flags,
            vec![
                ("Favorite J-POP".to_string(), 1),
                ("Favorite SONGS".to_string(), 1),
                ("Static".to_string(), 0),
            ]
        );
        let jpop = db
            .get_playlist_by_persistent_id(FAV_JPOP_PID)
            .unwrap()
            .unwrap();
        // ライブ評価: SONGS (★>2.45, Soundtrack 以外 = 1) ∩ (J-POP or J-Indie) = 1。
        assert_eq!(
            db.get_playlist_track_ids(jpop.playlist_id).unwrap(),
            vec![1]
        );
        // grouping も取り込まれる。
        assert_eq!(
            db.get_track_by_track_id(1)
                .unwrap()
                .unwrap()
                .grouping
                .as_deref(),
            Some("Idol")
        );

        // ローカルで条件を編集してから再取り込み → 編集が残る。
        let local = SmartCriteria {
            match_all: true,
            rules: vec![SmartRule {
                field: "genre".into(),
                op: SmartOp::Is,
                value: "J-Indie".into(),
            }],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        db.set_smart_criteria(jpop.playlist_id, &local).unwrap();
        super::super::parser::import_library(&path, &db).unwrap();
        assert_eq!(
            db.get_smart_criteria(jpop.playlist_id).unwrap(),
            Some(local)
        );
        assert_eq!(
            db.get_playlist_track_ids(jpop.playlist_id).unwrap(),
            vec![3]
        );
    }
}

