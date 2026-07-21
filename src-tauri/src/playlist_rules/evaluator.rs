//! ルール群を順番に評価して GeneratedPlaylist のリストを作る。
//!
//! - duplicate path 検出
//! - forward reference 検出 (まだ生成されていない generated playlist を参照)
//! - 各 rule に対して全 track をスキャン → match → (dedupe) → sort

use std::collections::{HashMap, HashSet};

use crate::models::Track;

use super::condition;
use super::models::GeneratedPlaylist;
use super::registry::PlaylistRegistry;
use super::schema::{BuildOptions, Condition, PlaylistRule, PlaylistSource, SortRule};
use super::sorter;

pub fn evaluate_rules(
    rules: &[PlaylistRule],
    namespace: &str,
    tracks: &HashMap<i64, Track>,
    registry: &mut PlaylistRegistry,
    options: &BuildOptions,
) -> Result<Vec<GeneratedPlaylist>, String> {
    let mut generated = Vec::with_capacity(rules.len());
    let mut seen_paths: HashSet<String> = HashSet::new();

    for rule in rules {
        let path = rule.name.clone();
        let full_path = format!("{}/{}", namespace, path);

        if seen_paths.contains(&path) {
            return Err(format!("Duplicate generated playlist path: \"{}\"", path));
        }
        seen_paths.insert(path.clone());

        validate_no_forward_refs(&rule.match_, &path, registry)?;

        let mut matched: Vec<i64> = tracks
            .iter()
            .filter_map(|(id, t)| {
                if condition::evaluate(t, &rule.match_, options, registry) {
                    Some(*id)
                } else {
                    None
                }
            })
            .collect();

        // Preserve insertion order while deduping (HashMap doesn't guarantee order,
        // so we sort first by id as a stable baseline before applying user sort).
        matched.sort_unstable();

        if options.dedupe_track_ids {
            let mut seen = HashSet::new();
            matched.retain(|id| seen.insert(*id));
        }

        let sort_rules: Vec<SortRule> = rule.sort.clone().unwrap_or_default();
        let sorted = if sort_rules.is_empty() {
            matched
        } else {
            sorter::sort_track_ids(matched, tracks, &sort_rules)
        };

        let parent_path = if path.contains('/') {
            Some(
                path.rsplit_once('/')
                    .map(|(parent, _)| parent.to_string())
                    .unwrap_or_default(),
            )
        } else {
            None
        };

        let name = path.rsplit('/').next().unwrap_or(path.as_str()).to_string();

        let pl = GeneratedPlaylist {
            name,
            path: path.clone(),
            full_path,
            parent_path,
            track_ids: sorted,
            sort: if sort_rules.is_empty() {
                None
            } else {
                Some(sort_rules)
            },
        };

        registry.register_generated(&pl);
        generated.push(pl);
    }

    Ok(generated)
}

fn validate_no_forward_refs(
    condition: &Condition,
    current_path: &str,
    registry: &PlaylistRegistry,
) -> Result<(), String> {
    match condition {
        Condition::All { all } => {
            for c in all {
                validate_no_forward_refs(c, current_path, registry)?;
            }
        }
        Condition::Any { any } => {
            for c in any {
                validate_no_forward_refs(c, current_path, registry)?;
            }
        }
        Condition::Not { not } => {
            validate_no_forward_refs(not, current_path, registry)?;
        }
        Condition::InPlaylist { in_playlist } => match in_playlist.source {
            PlaylistSource::Generated => {
                if !registry.has_generated(&in_playlist.name) {
                    return Err(format!(
                        "Generated playlist \"{}\" references later playlist \"{}\"",
                        current_path, in_playlist.name
                    ));
                }
            }
            PlaylistSource::Existing => {
                registry.check_existing(&in_playlist.name)?;
            }
        },
        Condition::Field(_) => {}
    }
    Ok(())
}
