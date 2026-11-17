//! 一覧の「件数」「ID 列」「ページ」が食い違わないことを固定するテスト
//! (`docs/library-list/design.md` §3)。
//!
//! デスクトップの一覧は、最初に件数を取ってスクロール範囲を全件ぶん確保し、見えている範囲の
//! ページだけを取る。件数とページの条件がずれると、末尾に空の行が残る / 最後の曲に届かない。
//! そのため、どの一覧でも次を満たすこと:
//! - 件数 == 全ページを連結した長さ
//! - ID 列 == 全ページを連結した track_id の列 (順序も同じ)

use super::tracks::AlbumScope;
use super::Database;
use crate::models::{SmartCriteria, SmartOp, SmartRule};

/// わざと割り切れないページ長にして、端数のページと空ページの両方を通す。
const PAGE: i64 = 4;

/// 曲 1..=14、通常プレイリスト 10 (同じ曲を 2 回含む)、スマートプレイリスト 30 (House タグ)。
fn db() -> Database {
    let db = Database::open_memory().unwrap();
    db.conn
        .execute_batch(
            "INSERT INTO tracks
               (track_id, name, artist, album_artist, album, genre, bpm, year, compilation, file_exists)
             VALUES
               (1,  'Alpha',   'Ann',  NULL,  'First',  'House',            120, 2001, 0, 1),
               (2,  'Bravo',   'Ann',  NULL,  'First',  'DeepHouse',        122, 2001, 0, 1),
               (3,  'Charlie', 'Ann',  NULL,  'Second', 'House Techno',     128, 2003, 0, 1),
               (4,  'Delta',   'Bob',  NULL,  'Solo',   'Techno',           130, NULL, 0, 1),
               (5,  'Echo',    'Bob',  NULL,  NULL,     'Electronic/Dance', NULL, 1999, 0, 1),
               (6,  'Alpha',   'Cid',  NULL,  'Solo',   'House',            124, 2010, 0, 0),
               (7,  'Golf',    'Dee',  'VA',  'Mix',    'House',            126, 2012, 1, 1),
               (8,  'Hotel',   'Eve',  'VA',  'Mix',    'IDM',              100, 2012, 1, 1),
               (9,  'India',   NULL,   NULL,  NULL,     NULL,               NULL, NULL, 0, 1),
               (10, 'Juliet',  'Ann',  NULL,  'Second', 'TechHouse',        127, 2003, 0, 1),
               (11, 'Kilo',    'Fay',  NULL,  'Kilo',   'house',            118, 2020, 0, 1),
               (12, 'Lima',    'Fay',  NULL,  'Kilo',   'Ambient',          90,  2020, 0, 1),
               (13, 'Alpha',   'Gus',  NULL,  'Third',  'House',            121, 2005, 0, 1),
               (14, 'Mike',    'Gus',  NULL,  'Third',  NULL,               NULL, 2005, 0, 1);
             INSERT INTO playlists
               (playlist_id, persistent_id, parent_persistent_id, name, is_folder, sort_order)
             VALUES
               (10, 'P010', NULL, 'Static', 0, 1),
               (30, 'P030', NULL, 'Smart',  0, 2);
             INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES
               (10, 7, 0), (10, 1, 1), (10, 13, 2), (10, 1, 3), (10, 4, 4),
               (10, 12, 5), (10, 3, 6), (10, 9, 7), (10, 6, 8);",
        )
        .unwrap();
    for id in 1..=14 {
        db.recompute_search_text(id).unwrap();
    }
    db.set_smart_criteria(
        30,
        &SmartCriteria {
            match_all: true,
            rules: vec![SmartRule {
                field: "genre".into(),
                op: SmartOp::Contains,
                value: "House".into(),
            }],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        },
    )
    .unwrap();
    db
}

/// `fetch(limit, offset)` を空ページが返るまで呼び、全ページを連結する。
fn all_pages<T>(mut fetch: impl FnMut(i64, i64) -> Vec<T>) -> Vec<T> {
    let mut out = Vec::new();
    let mut offset = 0;
    loop {
        let page = fetch(PAGE, offset);
        assert!(page.len() as i64 <= PAGE, "limit を超えて返っている");
        if page.is_empty() {
            return out;
        }
        offset += page.len() as i64;
        out.extend(page);
    }
}

const SORTS: [(Option<&str>, Option<&str>); 6] = [
    (None, None),
    (Some("name"), Some("asc")),
    (Some("name"), Some("desc")),
    (Some("artist"), Some("asc")),
    (Some("bpm"), Some("desc")),
    (Some("year"), Some("asc")),
];

#[test]
fn windowed_list_library_and_search_count_and_ids_match_pages() {
    let db = db();
    let queries = [
        None,
        Some(""),
        Some("alpha"),
        Some("house"),
        Some("genre:house"),
        Some("genre:\"House Techno\""),
        Some("artist:ann genre:house"),
        Some("bpm:120-128"),
        Some("no-such-track"),
    ];
    for query in queries {
        for (field, order) in SORTS {
            let paged: Vec<i64> = all_pages(|limit, offset| match query {
                // 検索語が無いときフロントは get_tracks を呼ぶ。
                None => db.get_tracks(limit, offset, field, order).unwrap(),
                Some(q) => db.search_tracks(q, limit, offset, field, order).unwrap(),
            })
            .into_iter()
            .map(|t| t.track_id)
            .collect();
            let ctx = format!("query={query:?} sort={field:?} {order:?}");
            assert_eq!(db.count_tracks(query).unwrap(), paged.len() as i64, "{ctx}");
            assert_eq!(
                db.get_track_ids(query, field, order).unwrap(),
                paged,
                "{ctx}"
            );
        }
    }
    // 件数そのもの: 全曲 / genre: はタグ単位の完全一致 (DeepHouse・TechHouse は数えない)。
    assert_eq!(db.count_tracks(None).unwrap(), 14);
    assert_eq!(db.count_tracks(Some("genre:house")).unwrap(), 6);
    assert_eq!(db.count_tracks(Some("house")).unwrap(), 8);
    assert_eq!(db.count_tracks(Some("no-such-track")).unwrap(), 0);
}

#[test]
fn windowed_list_static_playlist_count_and_ids_match_pages() {
    let db = db();
    for query in [
        None,
        Some(""),
        Some("alpha"),
        Some("genre:house"),
        Some("zzz"),
    ] {
        for (field, order) in SORTS {
            let paged: Vec<i64> = all_pages(|limit, offset| {
                db.get_playlist_tracks_filtered(10, query, limit, offset, field, order)
                    .unwrap()
            })
            .into_iter()
            .map(|t| t.track_id)
            .collect();
            let ctx = format!("query={query:?} sort={field:?} {order:?}");
            assert_eq!(
                db.count_playlist_tracks_filtered(10, query).unwrap(),
                paged.len() as i64,
                "{ctx}"
            );
            assert_eq!(
                db.get_playlist_track_ids_filtered(10, query, field, order)
                    .unwrap(),
                paged,
                "{ctx}"
            );
        }
    }
    // 手動順 (sort 指定なし) は sort_index 順。同じ曲が 2 回入っていれば 2 行ぶん数える。
    assert_eq!(
        db.get_playlist_track_ids_filtered(10, None, None, None)
            .unwrap(),
        vec![7, 1, 13, 1, 4, 12, 3, 9, 6]
    );
    assert_eq!(db.count_playlist_tracks_filtered(10, None).unwrap(), 9);
    // 存在しないプレイリストは空。
    assert_eq!(db.count_playlist_tracks_filtered(999, None).unwrap(), 0);
    assert!(db
        .get_playlist_track_ids_filtered(999, None, None, None)
        .unwrap()
        .is_empty());
}

#[test]
fn windowed_list_smart_playlist_count_and_ids_match_pages() {
    let db = db();
    let sorts = [
        (None, None),
        (Some("playlistOrder"), None),
        (Some("name"), Some("asc")),
        (Some("name"), Some("desc")),
        (Some("bpm"), Some("asc")),
    ];
    for query in [
        None,
        Some(""),
        Some("alpha"),
        Some("genre:house"),
        Some("zzz"),
    ] {
        for (field, order) in sorts {
            let ctx = format!("query={query:?} sort={field:?} {order:?}");
            // フロントはスマートなら get_smart_playlist_tracks を呼ぶが、
            // get_playlist_tracks 経由 (criteria を見て振り分け) でも同じ結果になること。
            let paged: Vec<i64> = all_pages(|limit, offset| {
                db.get_smart_playlist_tracks_filtered(30, query, limit, offset, field, order)
                    .unwrap()
            })
            .into_iter()
            .map(|t| t.track_id)
            .collect();
            let via_dispatch: Vec<i64> = all_pages(|limit, offset| {
                db.get_playlist_tracks_filtered(30, query, limit, offset, field, order)
                    .unwrap()
            })
            .into_iter()
            .map(|t| t.track_id)
            .collect();
            assert_eq!(paged, via_dispatch, "{ctx}");
            assert_eq!(
                db.count_playlist_tracks_filtered(30, query).unwrap(),
                paged.len() as i64,
                "{ctx}"
            );
            assert_eq!(
                db.get_playlist_track_ids_filtered(30, query, field, order)
                    .unwrap(),
                paged,
                "{ctx}"
            );
        }
    }
    // スマート条件の「含む」は部分一致 (DeepHouse / TechHouse も入る)。その中を検索の
    // genre:house (タグの完全一致) で絞ると 6 曲になる。
    assert_eq!(db.count_playlist_tracks_filtered(30, None).unwrap(), 8);
    assert_eq!(
        db.count_playlist_tracks_filtered(30, Some("genre:house"))
            .unwrap(),
        6
    );
}

#[test]
fn windowed_list_albums_count_matches_pages_in_every_scope() {
    let db = db();
    let scopes = [
        AlbumScope::default(),
        AlbumScope {
            query: Some("genre:house"),
            playlist_id: None,
        },
        AlbumScope {
            query: Some("zzz"),
            playlist_id: None,
        },
        AlbumScope {
            query: None,
            playlist_id: Some(10),
        },
        AlbumScope {
            query: Some("alpha"),
            playlist_id: Some(10),
        },
        AlbumScope {
            query: None,
            playlist_id: Some(30),
        },
        AlbumScope {
            query: Some("ann"),
            playlist_id: Some(30),
        },
        AlbumScope {
            query: None,
            playlist_id: Some(999),
        },
    ];
    let sorts = [
        (None, None),
        (Some("album"), Some("desc")),
        (Some("year"), Some("asc")),
        (Some("playCount"), Some("desc")),
    ];
    for scope in scopes {
        for (field, order) in sorts {
            let ctx = format!("scope={scope:?} sort={field:?} {order:?}");
            let albums = all_pages(|limit, offset| {
                db.get_albums_scoped(scope, field, order, limit, offset)
                    .unwrap()
            });
            assert_eq!(
                db.count_albums(scope).unwrap(),
                albums.len() as i64,
                "{ctx}"
            );
            // アルバムのキーはページをまたいで重複しない。
            let mut keys: Vec<&str> = albums.iter().map(|a| a.album_key.as_str()).collect();
            keys.sort_unstable();
            keys.dedup();
            assert_eq!(keys.len(), albums.len(), "{ctx}");
            // カードの曲数は、展開したときに返る曲数と一致する (範囲の曲だけ)。
            for album in &albums {
                let tracks = db.get_album_tracks_scoped(&album.album_key, scope).unwrap();
                assert_eq!(
                    tracks.len() as i64,
                    album.track_count,
                    "{ctx} {}",
                    album.album_key
                );
            }
        }
    }
    // ライブラリ全体: First / Second / Solo(Bob) / Solo(Cid) / Mix / Kilo / Third / 不明。
    assert_eq!(db.count_albums(AlbumScope::default()).unwrap(), 8);
    // プレイリスト 10 の曲 (7, 1, 13, 4, 12, 3, 9, 6。重複は 1 曲として数える)。
    let in_playlist = AlbumScope {
        query: None,
        playlist_id: Some(10),
    };
    assert_eq!(db.count_albums(in_playlist).unwrap(), 8);
    let first = db
        .get_albums_scoped(in_playlist, Some("album"), Some("asc"), 100, 0)
        .unwrap()
        .into_iter()
        .find(|a| a.album == "First")
        .unwrap();
    assert_eq!(
        first.track_count, 1,
        "プレイリストに入っている曲だけで数える"
    );
    // 範囲なしの版は従来どおりライブラリ全体。
    assert_eq!(db.get_album_tracks(&first.album_key).unwrap().len(), 2);
}

#[test]
fn windowed_list_artists_count_matches_pages() {
    let db = db();
    let sorts = [
        (None, None),
        (Some("name"), Some("desc")),
        (Some("trackCount"), Some("desc")),
        (Some("albumCount"), Some("asc")),
    ];
    for query in [
        None,
        Some(""),
        Some("genre:house"),
        Some("alpha"),
        Some("zzz"),
    ] {
        for (field, order) in sorts {
            let ctx = format!("query={query:?} sort={field:?} {order:?}");
            let artists = all_pages(|limit, offset| {
                db.get_artists_matching(field, order, limit, offset, query)
                    .unwrap()
            });
            assert_eq!(
                db.count_artists_matching(query).unwrap(),
                artists.len() as i64,
                "{ctx}"
            );
        }
    }
    // Ann / Bob / Cid / Various Artists (コンピレーション) / 不明 / Fay / Gus。
    assert_eq!(db.count_artists_matching(None).unwrap(), 7);
    assert_eq!(db.artist_count().unwrap(), 7);
}

/// 並びのキーが同値の行があっても、ページと ID 列の並びが一致する (L1)。
/// 既定の並び (曲名) は track_id、プレイリストの手動順は rowid で一意にしている。
#[test]
fn windowed_list_ties_are_ordered_deterministically() {
    let db = Database::open_memory().unwrap();
    // 全曲が同じ曲名。プレイリスト 10 は全行が同じ sort_index。
    for id in 1..=23 {
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, file_exists) VALUES (?1, 'Same', 1)",
                [id],
            )
            .unwrap();
    }
    db.conn
        .execute_batch(
            "INSERT INTO playlists (playlist_id, persistent_id, name, is_folder, sort_order)
               VALUES (10, 'P010', 'Ties', 0, 1);",
        )
        .unwrap();
    for id in [9, 3, 17, 3, 21, 1, 12, 5, 9, 2] {
        db.conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES (10, ?1, 0)",
                [id],
            )
            .unwrap();
    }
    for (field, order) in [(None, None), (Some("bogus"), None), (Some("name"), Some("desc"))] {
        let paged: Vec<i64> = all_pages(|limit, offset| db.get_tracks(limit, offset, field, order).unwrap())
            .into_iter()
            .map(|t| t.track_id)
            .collect();
        assert_eq!(paged, (1..=23).collect::<Vec<i64>>(), "{field:?}");
        assert_eq!(db.get_track_ids(None, field, order).unwrap(), paged, "{field:?}");
    }
    // 手動順で同じ sort_index なら、入れた順 (rowid)。
    let paged: Vec<i64> = all_pages(|limit, offset| {
        db.get_playlist_tracks_filtered(10, None, limit, offset, None, None)
            .unwrap()
    })
    .into_iter()
    .map(|t| t.track_id)
    .collect();
    assert_eq!(paged, vec![9, 3, 17, 3, 21, 1, 12, 5, 9, 2]);
    assert_eq!(
        db.get_playlist_track_ids_filtered(10, None, None, None).unwrap(),
        paged
    );
}

/// ID 列のキャッシュ: 読み取りと、一覧に関係しない書き込み (再生位置の保存など) では覚えた列を
/// 使い回し、一覧に関係する書き込みがあれば捨てる。
/// (SQLite の commit hook は読み取りでは呼ばれず、書き込みトランザクションのコミットで呼ばれる。)
#[test]
fn windowed_list_id_cache_survives_reads_and_drops_on_write() {
    use std::cell::Cell;
    let db = db();
    db.settle_list_cache();
    let computes = Cell::new(0);
    let probe = || {
        db.cached_list_ids("probe", || {
            computes.set(computes.get() + 1);
            Ok(vec![1, 2, 3])
        })
        .unwrap()
    };
    probe();
    // 読み取り (件数・ページ・ID 列・スマートプレイリストの評価) ではキャッシュを捨てない。
    db.count_tracks(Some("house")).unwrap();
    db.get_tracks(PAGE, 0, Some("name"), Some("asc")).unwrap();
    db.get_playlist_track_ids_filtered(30, None, None, None).unwrap();
    probe();
    assert_eq!(computes.get(), 1, "読み取りだけならキャッシュを使い回す");

    // 一覧に関係しないテーブルへの書き込み (設定・再生キュー・再生履歴) でも捨てない。
    db.set_state("playback_position", "12345").unwrap();
    db.conn
        .execute("INSERT INTO recent_tracks (track_id, played_at) VALUES (1, 'now')", [])
        .unwrap();
    probe();
    assert_eq!(computes.get(), 1, "一覧に関係しない書き込みでは捨てない");

    // 一覧に関係する書き込みのあとは、一覧が新しい内容になる (古い ID 列を返さない)。
    let before = db.get_track_ids(None, Some("name"), Some("asc")).unwrap();
    db.conn
        .execute("UPDATE tracks SET name = 'Aaa' WHERE track_id = 14", [])
        .unwrap();
    probe();
    assert_eq!(computes.get(), 2, "一覧に関係する書き込みで捨てる");
    let after = db.get_track_ids(None, Some("name"), Some("asc")).unwrap();
    assert_ne!(before, after);
    assert_eq!(after[0], 14);
    // スマートプレイリストも同じ: 条件から外れた曲が消える。
    assert_eq!(db.count_playlist_tracks_filtered(30, None).unwrap(), 8);
    db.conn
        .execute("UPDATE tracks SET genre = 'Ambient' WHERE track_id = 1", [])
        .unwrap();
    assert_eq!(db.count_playlist_tracks_filtered(30, None).unwrap(), 7);
    // WHERE なしの DELETE は行ごとの通知が出ない。何を触ったか分からないので捨てる。
    db.settle_list_cache();
    probe();
    let n = computes.get();
    db.conn.execute("DELETE FROM playlist_tracks", []).unwrap();
    probe();
    assert_eq!(computes.get(), n + 1);
    // 検索の字体ゆれ吸収レベルは app_state にあるが、一覧のキーに含めているので結果が変わる。
    db.settle_list_cache();
    db.get_track_ids(Some("house"), None, None).unwrap();
    db.set_state("search_fold_level", "off").unwrap();
    assert_eq!(
        db.get_track_ids(Some("house"), None, None).unwrap().len() as i64,
        db.count_tracks(Some("house")).unwrap()
    );
}

/// ファイルの DB: キャッシュはコネクションをまたいで共有し、ほかのコネクション・別プロセスの
/// 書き込みは data_version (監視用コネクション) で検知する。
#[test]
fn windowed_list_id_cache_across_connections_uses_data_version() {
    use std::cell::Cell;
    let dir = tempfile::tempdir().unwrap();
    let a = Database::open(dir.path()).unwrap();
    let b = Database::open(dir.path()).unwrap();
    a.settle_list_cache();
    let computes = Cell::new(0);
    let probe = |db: &Database| {
        db.cached_list_ids("probe", || {
            computes.set(computes.get() + 1);
            Ok(vec![1])
        })
        .unwrap()
    };
    probe(&a);
    probe(&b);
    assert_eq!(computes.get(), 1, "別のコネクション (別のコマンド) からも同じ列を使う");

    // 別のコネクションが一覧に関係しない書き込みをしても使い回す (再生位置の保存)。
    b.set_state("playback_position", "1").unwrap();
    probe(&a);
    assert_eq!(computes.get(), 1);

    // 別のコネクションが曲を書き換えたら捨てる。
    b.conn
        .execute("INSERT INTO tracks (track_id, name, file_exists) VALUES (1, 'x', 1)", [])
        .unwrap();
    probe(&a);
    assert_eq!(computes.get(), 2);

    // このプロセスの hook を通らない書き込み (別プロセス相当) も、data_version で気づく。
    a.settle_list_cache();
    probe(&a);
    let n = computes.get();
    let outside = rusqlite::Connection::open(dir.path().join("library.db")).unwrap();
    outside
        .execute("UPDATE tracks SET name = 'y' WHERE track_id = 1", [])
        .unwrap();
    probe(&a);
    assert_eq!(computes.get(), n + 1, "別プロセスの書き込みで捨てる");

    // API 用のコネクションはキャッシュを使わず、覚えもしない。
    let api = Database::open(dir.path()).unwrap().bypass_list_cache();
    let n = computes.get();
    probe(&api);
    probe(&api);
    assert_eq!(computes.get(), n + 2);
}

/// スマートプレイリストは、件数・並び順の違うページ・ID 列・アルバムの範囲で評価を 1 回だけ行う。
#[test]
fn windowed_list_smart_playlist_is_evaluated_once_for_count_and_pages() {
    let db = db();
    db.settle_list_cache();
    // 評価 (smart-matched) を覚えさせ、その後の呼び出しが評価し直さないことを、
    // 「評価結果を差し替えても、覚えた列から答える」ことで確かめる。
    assert_eq!(db.count_playlist_tracks_filtered(30, None).unwrap(), 8);
    // commit hook を通さずに条件を変えることはできないので、キャッシュのキーで確かめる:
    // 評価のエントリが、並び順つきのページの計算で再利用される。
    let by_name: Vec<i64> = db
        .get_playlist_track_ids_filtered(30, None, Some("name"), Some("asc"))
        .unwrap();
    let by_bpm: Vec<i64> = db
        .get_playlist_track_ids_filtered(30, None, Some("bpm"), Some("desc"))
        .unwrap();
    let mut a = by_name.clone();
    let mut b = by_bpm.clone();
    a.sort_unstable();
    b.sort_unstable();
    assert_eq!(a, b, "並び順が違っても同じ曲");
    assert_eq!(by_name.len(), 8);
    // 評価結果のエントリを直接見る: もう一度求めても compute は呼ばれない。
    let again = db
        .cached_list_ids("smart-matched\u{1f}30", || panic!("評価し直している"))
        .unwrap();
    assert_eq!(again.len(), 8);
}

/// get_tracks_by_ids は入力順のまま返し、重複はその回数ぶん、存在しない ID は飛ばす。
#[test]
fn get_tracks_by_ids_keeps_input_order_in_one_query() {
    let db = db();
    let got: Vec<i64> = db
        .get_tracks_by_ids(&[9, 3, 999, 3, 14, 1])
        .unwrap()
        .into_iter()
        .map(|t| t.track_id)
        .collect();
    assert_eq!(got, vec![9, 3, 3, 14, 1]);
    assert!(db.get_tracks_by_ids(&[]).unwrap().is_empty());
}

/// 複数曲のレーティングは 1 回で全部変わる (全選択でも 1 トランザクション)。値は 0〜100 に収める。
#[test]
fn set_rating_many_updates_all_in_one_transaction() {
    let db = db();
    let ids: Vec<i64> = (1..=14).collect();
    db.set_rating_many(&ids, 80).unwrap();
    assert!(db.get_tracks_by_ids(&ids).unwrap().iter().all(|t| t.rating == Some(80)));
    db.set_rating_many(&[1, 2, 999], 250).unwrap();
    let t = db.get_tracks_by_ids(&[1, 2, 3]).unwrap();
    assert_eq!(
        t.iter().map(|t| t.rating).collect::<Vec<_>>(),
        vec![Some(100), Some(100), Some(80)]
    );
    // rating だけの変更では date_modified を進めない (set_rating と同じ)。
    assert!(t.iter().all(|t| t.date_modified.is_none()));
    db.set_rating_many(&[], 0).unwrap();
}

/// 計測用 (通常のテストでは走らせない):
/// `cargo test --release windowed_list_bench -- --ignored --nocapture`
///
/// 37,082 曲の DB で、深い OFFSET のページ取得を「全列を並べ替える」(v0.21.0 までの SQL) と
/// 「ID 先行」(現在) で比べる。結果は docs/library-list/design.md §3 に記録する。
#[test]
#[ignore]
fn windowed_list_bench_deep_offset_page() {
    use std::time::Instant;
    let db = Database::open_memory().unwrap();
    db.conn.execute_batch("BEGIN").unwrap();
    for id in 1..=37_082i64 {
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, artist, album, genre, bpm, location_path, file_exists)
                 VALUES (?1, ?2, ?3, ?4, 'House Techno', ?5, ?6, 1)",
                rusqlite::params![
                    id,
                    format!("Track {} of the {} mix", (id * 7919) % 37_082, id % 97),
                    format!("Artist {}", (id * 31) % 3152),
                    format!("Album {}", (id * 17) % 5210),
                    100 + id % 60,
                    format!("/music/artist {}/album {}/{id}.flac", id % 3152, id % 5210),
                ],
            )
            .unwrap();
    }
    db.conn.execute_batch("COMMIT").unwrap();

    let time = |label: &str, f: &dyn Fn() -> usize| {
        let mut best = f64::MAX;
        let mut n = 0;
        for _ in 0..5 {
            let t = Instant::now();
            n = f();
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        }
        println!("{label}: {best:.1} ms ({n} rows)");
    };
    for (field, offset) in [(Some("name"), 0), (Some("name"), 36_800), (Some("artist"), 36_800)] {
        let order = super::tracks::build_order_by(field, Some("asc"), "", "name");
        let old_sql = format!(
            "SELECT {} FROM tracks ORDER BY {order} LIMIT 200 OFFSET {offset}",
            super::tracks::TRACK_COLUMNS
        );
        time(&format!("全列を並べ替え (v0.21.0)      sort={field:?} offset={offset}"), &|| {
            let mut stmt = db.conn.prepare(&old_sql).unwrap();
            let rows = stmt.query_map([], super::tracks::row_to_track).unwrap();
            rows.count()
        });
        // 書き込みの直後 (ID 列を並べ替え直す = 一覧を開いた最初の 1 回)。
        time(&format!("ID 先行・最初の 1 回 (並べ替え) sort={field:?} offset={offset}"), &|| {
            db.drop_list_cache();
            db.get_tracks(200, offset, field, Some("asc")).unwrap().len()
        });
        // 2 ページ目以降 (覚えた ID 列から切り出して行を引くだけ)。
        db.settle_list_cache();
        db.get_tracks(200, 0, field, Some("asc")).unwrap();
        time(&format!("ID 先行・2 ページ目以降       sort={field:?} offset={offset}"), &|| {
            db.get_tracks(200, offset, field, Some("asc")).unwrap().len()
        });
    }
}
