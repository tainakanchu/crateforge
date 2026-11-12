//! Rules の Apply / Preview を DB (インメモリ) 越しに確かめる。

use std::collections::HashMap;

use super::{apply_rules, preview_rules};
use crate::db::playlists::PlaylistNode;
use crate::db::Database;
use crate::models::{SmartCriteria, SmartOp, SmartRule};
use crate::smart::PLAYLIST_FIELD;

/// 曲 1..6:
/// 1 J-POP ★4 (80) bpm 120 / 2 J-POP ★2 (40) bpm 128 / 3 Rock ★5 (100) bpm 140
/// 4 J-POP ★3 (60) bpm 128 / 5 House (rating なし) bpm 124 / 6 J-POP ★5 (100) bpm 100
fn db() -> Database {
    let db = Database::open_memory().unwrap();
    db.conn
        .execute_batch(
            "INSERT INTO tracks (track_id, name, artist, genre, bpm, rating, file_exists) VALUES
               (1, 'a', 'Bravo', 'J-POP', 120, 80, 1),
               (2, 'b', 'Alpha', 'J-POP', 128, 40, 1),
               (3, 'c', 'Alpha', 'Rock', 140, 100, 1),
               (4, 'd', 'Alpha', 'J-POP', 128, 60, 1),
               (5, 'e', 'Charlie', 'House', 124, NULL, 1),
               (6, 'f', 'Alpha', 'J-POP', 100, 100, 1);",
        )
        .unwrap();
    db
}

const FAVORITES: &str = r#"
namespace: Gen
playlists:
  - name: "Favorite SONGS"
    match:
      field: rating
      gte: 60
  - name: "Genre/Favorite J-POP"
    match:
      all:
        - inPlaylist: {source: generated, name: "Favorite SONGS"}
        - field: genre
          equals: J-POP
"#;

fn nodes(db: &Database) -> Vec<PlaylistNode> {
    db.get_playlist_nodes().unwrap()
}

/// "Gen/Genre/Favorite J-POP" のようなパスでノードを引く。
fn find(db: &Database, path: &str) -> Option<PlaylistNode> {
    let all = nodes(db);
    let mut parent: Option<String> = None;
    let mut found = None;
    for seg in path.split('/') {
        let n = all
            .iter()
            .find(|n| n.name == seg && n.parent_persistent_id == parent)?
            .clone();
        parent = n.persistent_id.clone();
        found = Some(n);
    }
    found
}

fn members(db: &Database, path: &str) -> Vec<i64> {
    let id = find(db, path)
        .unwrap_or_else(|| panic!("{path} not found"))
        .playlist_id;
    db.get_playlist_track_ids(id).unwrap()
}

fn sorted(mut v: Vec<i64>) -> Vec<i64> {
    v.sort_unstable();
    v
}

fn static_rows(db: &Database, playlist_id: i64) -> Vec<i64> {
    db.get_static_playlist_track_ids(playlist_id).unwrap()
}

/// 生成されるのはスマートプレイリストで、静的な行にも適用時点のメンバーが入る。
#[test]
fn apply_creates_smart_playlists() {
    let db = db();
    let res = apply_rules(&db, FAVORITES).unwrap();
    assert_eq!(res.generated_playlist_count, 2);
    assert_eq!(res.generated_folder_count, 1);
    // Gen + Favorite SONGS + Genre + Favorite J-POP。
    assert_eq!(res.created_count, 4);
    assert_eq!(res.updated_count, 0);
    assert_eq!(res.removed_count, 0);
    assert!(res.warnings.is_empty(), "{:?}", res.warnings);

    let songs = find(&db, "Gen/Favorite SONGS").unwrap();
    let jpop = find(&db, "Gen/Genre/Favorite J-POP").unwrap();
    let crit = db.get_smart_criteria(jpop.playlist_id).unwrap().unwrap();
    assert_eq!(
        crit.rules[0],
        SmartRule {
            field: PLAYLIST_FIELD.into(),
            op: SmartOp::Is,
            value: songs.persistent_id.clone().unwrap(),
        }
    );
    assert_eq!(sorted(members(&db, "Gen/Favorite SONGS")), vec![1, 3, 4, 6]);
    assert_eq!(
        sorted(members(&db, "Gen/Genre/Favorite J-POP")),
        vec![1, 4, 6]
    );
    assert_eq!(
        sorted(static_rows(&db, jpop.playlist_id)),
        vec![1, 4, 6],
        "スナップショットの行も書かれる"
    );
    assert!(
        db.get_playlists()
            .unwrap()
            .iter()
            .find(|p| p.playlist_id == jpop.playlist_id)
            .unwrap()
            .is_smart
    );
}

/// 親の定義を変えずとも、曲のレーティングを変えれば依存側も再適用なしで変わる。
#[test]
fn generated_reference_is_live() {
    let db = db();
    apply_rules(&db, FAVORITES).unwrap();
    assert_eq!(
        sorted(members(&db, "Gen/Genre/Favorite J-POP")),
        vec![1, 4, 6]
    );
    // 曲 2 を ★2 → ★5 に、曲 4 を ★3 → ★1 に。
    db.conn
        .execute_batch("UPDATE tracks SET rating = 100 WHERE track_id = 2; UPDATE tracks SET rating = 20 WHERE track_id = 4;")
        .unwrap();
    assert_eq!(
        sorted(members(&db, "Gen/Genre/Favorite J-POP")),
        vec![1, 2, 6]
    );
}

/// 再適用しても ID は変わらず、namespace 外からの参照もそのまま追従する。
#[test]
fn reapply_keeps_ids_and_outside_references() {
    let db = db();
    apply_rules(&db, FAVORITES).unwrap();
    let songs = find(&db, "Gen/Favorite SONGS").unwrap();
    let jpop = find(&db, "Gen/Genre/Favorite J-POP").unwrap();

    // namespace 外のスマートプレイリストが生成プレイリストを参照する。
    let outside = db
        .create_smart_playlist(
            "Outside",
            &SmartCriteria {
                match_all: true,
                rules: vec![SmartRule {
                    field: PLAYLIST_FIELD.into(),
                    op: SmartOp::Is,
                    value: songs.persistent_id.clone().unwrap(),
                }],
                groups: vec![],
                limit: None,
                sort_by: None,
                sort_desc: false,
                then_by: Vec::new(),
            },
        )
        .unwrap();
    assert_eq!(
        sorted(db.get_playlist_track_ids(outside.playlist_id).unwrap()),
        vec![1, 3, 4, 6]
    );

    // 定義を ★4 以上に変えて再適用。
    let changed = FAVORITES.replace("gte: 60", "gte: 80");
    let res = apply_rules(&db, &changed).unwrap();
    assert_eq!(res.created_count, 0);
    assert_eq!(res.updated_count, 4);
    assert_eq!(res.removed_count, 0);

    let songs2 = find(&db, "Gen/Favorite SONGS").unwrap();
    let jpop2 = find(&db, "Gen/Genre/Favorite J-POP").unwrap();
    assert_eq!(songs2.playlist_id, songs.playlist_id);
    assert_eq!(songs2.persistent_id, songs.persistent_id);
    assert_eq!(jpop2.persistent_id, jpop.persistent_id);
    assert_eq!(sorted(members(&db, "Gen/Genre/Favorite J-POP")), vec![1, 6]);
    assert_eq!(
        sorted(db.get_playlist_track_ids(outside.playlist_id).unwrap()),
        vec![1, 3, 6]
    );
    // ルートフォルダは 1 つのまま。
    assert_eq!(
        nodes(&db)
            .iter()
            .filter(|n| n.name == "Gen" && n.parent_persistent_id.is_none())
            .count(),
        1
    );
}

/// removeExistingNamespace: true (既定) はルールに無いノードを消し、false は残す。
#[test]
fn pruning_on_and_off() {
    let two = "namespace: Gen\nplaylists:\n  - name: A\n    match: {field: genre, equals: Rock}\n  - name: Sub/B\n    match: {field: genre, equals: House}\n";
    let one = "namespace: Gen\nplaylists:\n  - name: A\n    match: {field: genre, equals: Rock}\n";
    let one_keep = "namespace: Gen\noptions:\n  removeExistingNamespace: false\nplaylists:\n  - name: A\n    match: {field: genre, equals: Rock}\n";

    let db = db();
    apply_rules(&db, two).unwrap();
    let b = find(&db, "Gen/Sub/B").unwrap();
    // 手で namespace 内に置いたプレイリストも対象。
    let root = find(&db, "Gen").unwrap();
    db.create_playlist("Manual", root.persistent_id.as_deref(), false)
        .unwrap();

    let res = apply_rules(&db, one_keep).unwrap();
    assert_eq!(res.removed_count, 0);
    assert!(find(&db, "Gen/Sub/B").is_some());
    assert!(find(&db, "Gen/Manual").is_some());

    let res = apply_rules(&db, one).unwrap();
    // Sub + B + Manual。
    assert_eq!(res.removed_count, 3);
    assert!(find(&db, "Gen/Sub").is_none());
    assert!(find(&db, "Gen/Manual").is_none());
    assert!(static_rows(&db, b.playlist_id).is_empty(), "行も消える");
    assert!(find(&db, "Gen/A").is_some());
}

/// 同じパスでフォルダ ↔ プレイリストが入れ替わったら作り直す (警告つき)。
#[test]
fn kind_mismatch_is_replaced() {
    let db = db();
    apply_rules(
        &db,
        "namespace: Gen\nplaylists:\n  - name: X\n    match: {field: genre, equals: Rock}\n",
    )
    .unwrap();
    let old = find(&db, "Gen/X").unwrap();
    let res = apply_rules(
        &db,
        "namespace: Gen\nplaylists:\n  - name: X/y\n    match: {field: genre, equals: Rock}\n",
    )
    .unwrap();
    let new = find(&db, "Gen/X").unwrap();
    assert!(new.is_folder);
    // playlist_id は MAX+1 採番なので再利用されうる。別物であることは PID で見る。
    assert_ne!(new.persistent_id, old.persistent_id);
    assert_eq!(res.removed_count, 1);
    assert_eq!(res.created_count, 2);
    assert!(
        res.warnings
            .iter()
            .any(|w| w.contains("既存のプレイリスト「Gen/X」をフォルダに置き換えました")),
        "{:?}",
        res.warnings
    );
    assert_eq!(members(&db, "Gen/X/y"), vec![3]);
}

/// 同名ルートフォルダが複数ある (旧 removeExistingNamespace: false の名残) なら最初を使って警告。
#[test]
fn duplicate_root_folders_warn() {
    let db = db();
    db.conn
        .execute_batch(
            "INSERT INTO playlists (playlist_id, persistent_id, parent_persistent_id, name, is_folder, sort_order) VALUES
               (50, 'R050', NULL, 'Gen', 1, 5),
               (40, 'R040', NULL, 'Gen', 1, 9);",
        )
        .unwrap();
    let res = apply_rules(&db, FAVORITES).unwrap();
    assert!(
        res.warnings
            .iter()
            .any(|w| w.contains("フォルダが 2 個あります")),
        "{:?}",
        res.warnings
    );
    assert_eq!(res.created_count, 3, "ルートは作らない");
    let songs = find(&db, "Gen/Favorite SONGS").unwrap();
    assert_eq!(songs.parent_persistent_id.as_deref(), Some("R050"));
    assert_eq!(
        nodes(&db)
            .iter()
            .filter(|n| n.name == "Gen" && n.parent_persistent_id.is_none())
            .count(),
        2
    );
}

/// DB の観測可能な状態 (プレイリスト行 + 条件 + 静的な行)。
fn snapshot(db: &Database) -> Vec<String> {
    let mut stmt = db
        .conn
        .prepare(
            "SELECT p.playlist_id, p.persistent_id, p.parent_persistent_id, p.name, p.is_folder,
                    p.is_smart, p.sort_order, COALESCE(p.smart_criteria, ''),
                    (SELECT group_concat(track_id) FROM playlist_tracks pt WHERE pt.playlist_id = p.playlist_id)
             FROM playlists p ORDER BY p.playlist_id",
        )
        .unwrap();
    stmt.query_map([], |r| {
        Ok(format!(
            "{}|{:?}|{:?}|{}|{}|{}|{}|{}|{:?}",
            r.get::<_, i64>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, Option<String>>(8)?,
        ))
    })
    .unwrap()
    .collect::<Result<Vec<_>, _>>()
    .unwrap()
}

fn tree_counts(node: &super::TreeNodeOut, out: &mut HashMap<String, usize>) {
    match node {
        super::TreeNodeOut::Folder(f) => f.children.iter().for_each(|c| tree_counts(c, out)),
        super::TreeNodeOut::Playlist(p) => {
            out.insert(p.full_path.clone(), p.track_ids.len());
        }
    }
}

/// Preview は Apply と同じ件数・メンバーを返し、DB は変えない (初回・再適用の両方)。
#[test]
fn preview_matches_apply_and_leaves_db_unchanged() {
    let db = db();
    for yaml in [
        FAVORITES.to_string(),
        FAVORITES.replace("gte: 60", "gte: 100"),
    ] {
        let before = snapshot(&db);
        let preview = preview_rules(&db, &yaml).unwrap();
        assert_eq!(snapshot(&db), before, "preview は DB を変えない");

        let applied = apply_rules(&db, &yaml).unwrap();
        assert_eq!(preview.playlist_count, applied.generated_playlist_count);
        assert_eq!(preview.folder_count, applied.generated_folder_count);
        assert_eq!(preview.created_count, applied.created_count);
        assert_eq!(preview.updated_count, applied.updated_count);
        assert_eq!(preview.removed_count, applied.removed_count);
        assert_eq!(preview.warnings, applied.warnings);

        let mut counts = HashMap::new();
        preview
            .tree
            .children
            .iter()
            .for_each(|c| tree_counts(c, &mut counts));
        for (path, n) in counts {
            assert_eq!(members(&db, &path).len(), n, "{path}");
        }
    }
}

/// existing 参照はフォルダも可 (子孫の和集合)。
#[test]
fn existing_reference_to_folder() {
    let db = db();
    db.conn
        .execute_batch(
            "INSERT INTO playlists (playlist_id, persistent_id, parent_persistent_id, name, is_folder, sort_order) VALUES
               (60, 'C060', NULL, 'Crates', 1, 1),
               (61, 'C061', 'C060', 'Crate A', 0, 2),
               (62, 'C062', 'C060', 'Crate B', 0, 3);
             INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES
               (61, 1, 0), (61, 5, 1), (62, 3, 0);",
        )
        .unwrap();
    let yaml = "namespace: Gen\nplaylists:\n  - name: InCrates\n    match:\n      inPlaylist: {source: existing, name: Crates}\n  - name: InB\n    match:\n      inPlaylist: {source: existing, name: \"Crates/Crate B\"}\n";
    apply_rules(&db, yaml).unwrap();
    assert_eq!(sorted(members(&db, "Gen/InCrates")), vec![1, 3, 5]);
    assert_eq!(members(&db, "Gen/InB"), vec![3]);
    // 静的プレイリストに曲を足すと追従する。
    db.add_tracks_to_playlist(62, &[6]).unwrap();
    assert_eq!(sorted(members(&db, "Gen/InCrates")), vec![1, 3, 5, 6]);
}

/// failOnMissingPlaylist: true はエラー (DB は変わらない)、false は警告 + 一致なし。
#[test]
fn fail_on_missing_playlist() {
    let db = db();
    let strict = "namespace: Gen\nplaylists:\n  - name: P\n    match:\n      inPlaylist: {source: existing, name: Nope}\n";
    let before = snapshot(&db);
    let err = apply_rules(&db, strict).unwrap_err();
    assert!(
        err.contains("参照した既存のプレイリストが見つかりません: 「Nope」"),
        "{err}"
    );
    assert_eq!(snapshot(&db), before);

    let lenient = "namespace: Gen\noptions:\n  failOnMissingPlaylist: false\nplaylists:\n  - name: P\n    match:\n      inPlaylist: {source: existing, name: Nope}\n  - name: Q\n    match:\n      not:\n        inPlaylist: {source: existing, name: Nope}\n";
    let res = apply_rules(&db, lenient).unwrap();
    assert!(
        res.warnings
            .iter()
            .any(|w| w.starts_with("P: 参照した既存のプレイリストが見つかりません")),
        "{:?}",
        res.warnings
    );
    assert!(members(&db, "Gen/P").is_empty());
    assert_eq!(members(&db, "Gen/Q").len(), 6);
}

/// namespace の中を existing で参照するのは generated を使うよう案内するエラー。
#[test]
fn existing_reference_into_namespace_is_rejected() {
    let db = db();
    apply_rules(&db, FAVORITES).unwrap();
    let yaml = format!(
        "{FAVORITES}  - name: Again\n    match:\n      inPlaylist: {{source: existing, name: \"Favorite SONGS\"}}\n"
    );
    let err = apply_rules(&db, &yaml).unwrap_err();
    assert!(err.contains("namespace「Gen」の中にあります"), "{err}");
}

/// generated の前方参照 (= 循環の可能性) はエラー。
#[test]
fn forward_reference_is_rejected() {
    let db = db();
    let yaml = "namespace: Gen\nplaylists:\n  - name: A\n    match:\n      inPlaylist: {source: generated, name: B}\n  - name: B\n    match: {field: genre, equals: Rock}\n";
    let err = apply_rules(&db, yaml).unwrap_err();
    assert!(err.contains("後ろで定義されたプレイリスト「B」を参照しています"), "{err}");
    assert!(find(&db, "Gen").is_none(), "何も書かない");
}

/// 複数キーのソートは then_by としてライブ評価の並びに効く。
#[test]
fn multi_key_sort_order() {
    let db = db();
    let yaml = "namespace: Gen\nplaylists:\n  - name: Sorted\n    match: {field: genre, equals: J-POP}\n    sort:\n      - {field: artist, order: asc}\n      - {field: bpm, order: desc}\n      - {field: trackId, order: asc}\n";
    apply_rules(&db, yaml).unwrap();
    // Alpha (2: 128, 4: 128, 6: 100) → Bravo (1)。bpm 同値は trackId 昇順。
    assert_eq!(members(&db, "Gen/Sorted"), vec![2, 4, 6, 1]);
    let id = find(&db, "Gen/Sorted").unwrap().playlist_id;
    let c = db.get_smart_criteria(id).unwrap().unwrap();
    assert_eq!(c.sort_by.as_deref(), Some("artist"));
    assert_eq!(c.then_by.len(), 2);
    assert_eq!(static_rows(&db, id), vec![2, 4, 6, 1]);
}

/// 再適用で新しいノードを先頭に足しても、サイドバーの並び (sort_order) は YAML 順になる。
#[test]
fn sort_order_follows_yaml() {
    let db = db();
    let first = "namespace: Gen\nplaylists:\n  - name: B\n    match: {all: []}\n  - name: C\n    match: {all: []}\n";
    apply_rules(&db, first).unwrap();
    let second = "namespace: Gen\nplaylists:\n  - name: A\n    match: {all: []}\n  - name: B\n    match: {all: []}\n  - name: C\n    match: {all: []}\n";
    apply_rules(&db, second).unwrap();
    let root = find(&db, "Gen").unwrap();
    let names: Vec<String> = nodes(&db)
        .into_iter()
        .filter(|n| n.parent_persistent_id == root.persistent_id)
        .map(|n| n.name)
        .collect();
    assert_eq!(names, vec!["A", "B", "C"]);
}
