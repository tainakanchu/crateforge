//! first-class Tags (Genre とは独立)。
//!
//! 正規化モデル: `tags(namespace, value)` + `track_tags(track_id, tag_id)`。
//! free tag (namespace なし) は `namespace = ''` で UNIQUE を成立させる。
//! 文字列表現は `namespace:value` (free は `value` のみ)。複数 `:` がある場合は
//! 最初の `:` が namespace 区切り、残りは value。

use rusqlite::{params, OptionalExtension, Result};

use super::Database;
use crate::models::{Tag, TagCount};

/// `"mood:dreamy"` → `("mood", "dreamy")`、`"bridge"` → `("", "bridge")`。
/// 複数 `:` は最初だけ namespace 区切り (`"a:b:c"` → `("a", "b:c")`)。
/// 前後空白は trim。value が空なら `("", "")` を返す (呼び出し側で弾く)。
pub fn parse_tag_str(s: &str) -> (String, String) {
    let s = s.trim();
    if s.is_empty() {
        return (String::new(), String::new());
    }
    if let Some((ns, val)) = s.split_once(':') {
        (ns.trim().to_string(), val.trim().to_string())
    } else {
        (String::new(), s.to_string())
    }
}

/// namespace + value を表示用文字列へ。namespace 空なら value のみ。
pub fn format_tag(namespace: &str, value: &str) -> String {
    if namespace.is_empty() {
        value.to_string()
    } else {
        format!("{namespace}:{value}")
    }
}

impl std::fmt::Display for Tag {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&format_tag(&self.namespace, &self.value))
    }
}

impl Database {
    /// 全タグを付与曲数つきで頻度順に返す (未使用タグ count=0 も含む)。
    pub fn list_all_tags(&self) -> Result<Vec<TagCount>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.namespace, t.value, COUNT(tt.track_id) AS cnt
             FROM tags t
             LEFT JOIN track_tags tt ON tt.tag_id = t.id
             GROUP BY t.id
             ORDER BY cnt DESC, t.namespace COLLATE NOCASE ASC, t.value COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TagCount {
                id: r.get(0)?,
                namespace: r.get(1)?,
                value: r.get(2)?,
                count: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// 1 曲に付いているタグ一覧 (namespace, value 昇順)。
    pub fn get_track_tags(&self, track_id: i64) -> Result<Vec<Tag>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.namespace, t.value
             FROM track_tags tt
             JOIN tags t ON t.id = tt.tag_id
             WHERE tt.track_id = ?1
             ORDER BY t.namespace COLLATE NOCASE ASC, t.value COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map(params![track_id], |r| {
            Ok(Tag {
                id: r.get(0)?,
                namespace: r.get(1)?,
                value: r.get(2)?,
            })
        })?;
        rows.collect()
    }

    /// `tags` に upsert して id を返す。value が空なら None。
    fn ensure_tag_id(&self, namespace: &str, value: &str) -> Result<Option<i64>> {
        if value.is_empty() {
            return Ok(None);
        }
        self.conn.execute(
            "INSERT OR IGNORE INTO tags (namespace, value) VALUES (?1, ?2)",
            params![namespace, value],
        )?;
        let id: i64 = self.conn.query_row(
            "SELECT id FROM tags WHERE namespace = ?1 AND value = ?2",
            params![namespace, value],
            |r| r.get(0),
        )?;
        Ok(Some(id))
    }

    /// 複数曲に同じタグを付与。重複リンクは無視。更新した (track, tag) 数を返す。
    pub fn add_tag_to_tracks(&self, track_ids: &[i64], tag_str: &str) -> Result<i64> {
        let (ns, val) = parse_tag_str(tag_str);
        let Some(tag_id) = self.ensure_tag_id(&ns, &val)? else {
            return Ok(0);
        };
        let mut updated = 0_i64;
        for &track_id in track_ids {
            let n = self.conn.execute(
                "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                params![track_id, tag_id],
            )?;
            updated += n as i64;
        }
        Ok(updated)
    }

    /// 複数曲から同じタグを除去。タグ行自体は残す (他曲や再付与のため)。
    pub fn remove_tag_from_tracks(&self, track_ids: &[i64], tag_str: &str) -> Result<i64> {
        let (ns, val) = parse_tag_str(tag_str);
        if val.is_empty() {
            return Ok(0);
        }
        let tag_id: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM tags WHERE namespace = ?1 AND value = ?2",
                params![ns, val],
                |r| r.get(0),
            )
            .optional()?;
        let Some(tag_id) = tag_id else {
            return Ok(0);
        };
        let mut updated = 0_i64;
        for &track_id in track_ids {
            let n = self.conn.execute(
                "DELETE FROM track_tags WHERE track_id = ?1 AND tag_id = ?2",
                params![track_id, tag_id],
            )?;
            updated += n as i64;
        }
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn parse_tag_str_free_and_namespaced() {
        assert_eq!(parse_tag_str("bridge"), ("".into(), "bridge".into()));
        assert_eq!(
            parse_tag_str("mood:dreamy"),
            ("mood".into(), "dreamy".into())
        );
        assert_eq!(parse_tag_str("a:b:c"), ("a".into(), "b:c".into()));
        assert_eq!(parse_tag_str("  mood:dreamy  "), ("mood".into(), "dreamy".into()));
        assert_eq!(parse_tag_str(""), ("".into(), "".into()));
        assert_eq!(parse_tag_str("   "), ("".into(), "".into()));
    }

    #[test]
    fn format_tag_roundtrip_display() {
        assert_eq!(format_tag("", "bridge"), "bridge");
        assert_eq!(format_tag("mood", "dreamy"), "mood:dreamy");
    }

    #[test]
    fn add_remove_list_tags() {
        let db = Database::open_memory().unwrap();
        // 曲 2 件を直 INSERT (search_text 等は不要)
        for tid in [1_i64, 2] {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, file_exists) VALUES (?1, 't', 1)",
                    params![tid],
                )
                .unwrap();
        }

        assert_eq!(db.add_tag_to_tracks(&[1, 2], "bridge").unwrap(), 2);
        // 重複は 0 増
        assert_eq!(db.add_tag_to_tracks(&[1], "bridge").unwrap(), 0);
        assert_eq!(db.add_tag_to_tracks(&[1], "mood:dreamy").unwrap(), 1);

        let tags1 = db.get_track_tags(1).unwrap();
        assert_eq!(tags1.len(), 2);
        assert!(tags1.iter().any(|t| t.namespace.is_empty() && t.value == "bridge"));
        assert!(tags1
            .iter()
            .any(|t| t.namespace == "mood" && t.value == "dreamy"));

        let tags2 = db.get_track_tags(2).unwrap();
        assert_eq!(tags2.len(), 1);
        assert_eq!(tags2[0].value, "bridge");

        let all = db.list_all_tags().unwrap();
        assert_eq!(all.len(), 2);
        let bridge = all.iter().find(|t| t.value == "bridge").unwrap();
        assert_eq!(bridge.count, 2);
        let dreamy = all.iter().find(|t| t.value == "dreamy").unwrap();
        assert_eq!(dreamy.count, 1);
        assert_eq!(dreamy.namespace, "mood");

        assert_eq!(db.remove_tag_from_tracks(&[1], "bridge").unwrap(), 1);
        assert_eq!(db.get_track_tags(1).unwrap().len(), 1);
        // track 2 は残る
        assert_eq!(db.get_track_tags(2).unwrap().len(), 1);
    }
}
