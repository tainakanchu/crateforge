//! 公開 API: validate / preview / apply。
//!
//! Apply と Preview は同じ処理 ([`persist::apply_in_txn`]) をトランザクション内で実行し、
//! Apply はコミット、Preview はロールバックする。Preview の件数・メンバーは Apply した場合と
//! 一致し、DB は変わらない。

use crate::db::Database;

use super::folder_tree::collect_referenced_tracks;
use super::models::{ApplyResult, EvaluationResult};
use super::persist;
use super::schema::parse_rules_yaml;

pub fn validate_rules(yaml: &str) -> Result<(), String> {
    parse_rules_yaml(yaml).map(|_| ())
}

pub fn preview_rules(db: &Database, yaml: &str) -> Result<EvaluationResult, String> {
    let rules_file = parse_rules_yaml(yaml)?;
    let tx = db
        .write_txn()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;
    let outcome = persist::apply_in_txn(db, &rules_file)?;
    // 結果を読み終えたので書き込みはすべて捨てる。
    tx.rollback()
        .map_err(|e| format!("Failed to roll back preview: {}", e))?;
    let referenced_track_count = collect_referenced_tracks(&outcome.tree).len();
    Ok(EvaluationResult {
        tree: outcome.tree,
        playlist_count: outcome.playlist_count,
        folder_count: outcome.folder_count,
        referenced_track_count,
        created_count: outcome.created,
        updated_count: outcome.updated,
        removed_count: outcome.removed,
        warnings: outcome.warnings,
    })
}

pub fn apply_rules(db: &Database, yaml: &str) -> Result<ApplyResult, String> {
    let rules_file = parse_rules_yaml(yaml)?;
    let tx = db
        .write_txn()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;
    // エラーなら tx は drop でロールバックされる (途中まで書いた分も残らない)。
    let outcome = persist::apply_in_txn(db, &rules_file)?;
    tx.commit()
        .map_err(|e| format!("Failed to commit playlist rules: {}", e))?;

    crate::logging::write_line(
        "info",
        &format!(
            "playlist rules '{}': playlists={} folders={} created={} updated={} removed={} warnings={}",
            rules_file.namespace,
            outcome.playlist_count,
            outcome.folder_count,
            outcome.created,
            outcome.updated,
            outcome.removed,
            outcome.warnings.len()
        ),
    );
    for w in &outcome.warnings {
        crate::logging::write_line("warn", &format!("playlist rules: {w}"));
    }

    Ok(ApplyResult {
        generated_playlist_count: outcome.playlist_count,
        generated_folder_count: outcome.folder_count,
        created_count: outcome.created,
        updated_count: outcome.updated,
        removed_count: outcome.removed,
        warnings: outcome.warnings,
    })
}
