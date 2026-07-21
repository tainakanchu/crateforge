//! 公開 API: validate / preview / apply。
//!
//! `apply_rules` は実際に DB に書き込み、preview/validate は副作用なし。

use std::collections::HashMap;

use crate::db::Database;
use crate::models::Track;

use super::evaluator;
use super::folder_tree::{self, collect_referenced_tracks, count_nodes};
use super::generator;
use super::models::{ApplyResult, EvaluationResult, FolderNodeOut, GeneratedPlaylist, TreeNodeOut};
use super::registry::{ExistingPlaylist, PlaylistRegistry};
use super::schema::{parse_rules_yaml, BuildOptions, PlaylistRule, RulesFile};

pub fn validate_rules(yaml: &str) -> Result<(), String> {
    parse_rules_yaml(yaml).map(|_| ())
}

pub fn preview_rules(db: &Database, yaml: &str) -> Result<EvaluationResult, String> {
    let rules_file = parse_rules_yaml(yaml)?;
    let (_, tree, folder_count, playlist_count) = evaluate(db, &rules_file)?;
    let referenced_track_count = collect_referenced_tracks(&tree).len();
    Ok(EvaluationResult {
        tree,
        playlist_count,
        folder_count,
        referenced_track_count,
    })
}

pub fn apply_rules(db: &Database, yaml: &str) -> Result<ApplyResult, String> {
    let rules_file = parse_rules_yaml(yaml)?;
    let options = BuildOptions::resolve(rules_file.options.as_ref());

    let (_, tree, folder_count, playlist_count) = evaluate(db, &rules_file)?;

    let removed = if options.remove_existing_namespace {
        db.delete_playlist_subtree_by_root_name(&rules_file.namespace)
            .map_err(|e| format!("Failed to remove existing namespace: {}", e))?
    } else {
        false
    };

    persist_tree(db, &tree, None)?;

    Ok(ApplyResult {
        generated_playlist_count: playlist_count,
        generated_folder_count: folder_count,
        removed_existing: removed,
    })
}

fn evaluate(
    db: &Database,
    rules_file: &RulesFile,
) -> Result<(Vec<GeneratedPlaylist>, FolderNodeOut, usize, usize), String> {
    let options = BuildOptions::resolve(rules_file.options.as_ref());

    // Load all tracks into a HashMap (avoids reloading per rule).
    let tracks_vec = db
        .get_all_tracks()
        .map_err(|e| format!("Failed to load tracks: {}", e))?;
    let tracks: HashMap<i64, Track> = tracks_vec.into_iter().map(|t| (t.track_id, t)).collect();

    let existing = load_existing_playlists(db)?;
    let mut registry = PlaylistRegistry::new(existing, options);

    let templates = rules_file.templates.clone().unwrap_or_else(HashMap::new);

    let mut all_rules: Vec<PlaylistRule> = rules_file.playlists.clone();
    let expanded = generator::expand_generators(&rules_file.generators, &templates)?;
    all_rules.extend(expanded);

    let generated = evaluator::evaluate_rules(
        &all_rules,
        &rules_file.namespace,
        &tracks,
        &mut registry,
        &options,
    )?;

    let tree = folder_tree::build_folder_tree(&rules_file.namespace, &generated);
    let (folder_count, playlist_count) = count_nodes(&tree);
    Ok((generated, tree, folder_count, playlist_count))
}

fn load_existing_playlists(db: &Database) -> Result<Vec<ExistingPlaylist>, String> {
    let playlists = db
        .get_playlists()
        .map_err(|e| format!("Failed to load playlists: {}", e))?;

    // Build a persistent_id → full_path map by walking the parent chain.
    let by_pid: HashMap<String, &crate::models::Playlist> = playlists
        .iter()
        .filter_map(|p| p.persistent_id.clone().map(|pid| (pid, p)))
        .collect();

    let mut out = Vec::with_capacity(playlists.len());
    for p in &playlists {
        if p.is_folder {
            // Folders don't have track ids of their own.
            continue;
        }
        let full_path = build_full_path(p, &by_pid);
        let track_ids = db
            .get_playlist_track_ids(p.playlist_id)
            .map_err(|e| format!("Failed to load playlist tracks: {}", e))?;
        out.push(ExistingPlaylist {
            name: p.name.clone(),
            full_path,
            track_ids,
        });
    }
    Ok(out)
}

fn build_full_path(
    p: &crate::models::Playlist,
    by_pid: &HashMap<String, &crate::models::Playlist>,
) -> String {
    let mut parts = vec![p.name.clone()];
    let mut current_parent = p.parent_persistent_id.clone();
    while let Some(parent_pid) = current_parent {
        match by_pid.get(&parent_pid) {
            Some(parent) => {
                parts.push(parent.name.clone());
                current_parent = parent.parent_persistent_id.clone();
            }
            None => break,
        }
    }
    parts.reverse();
    parts.join("/")
}

fn persist_tree(
    db: &Database,
    folder: &FolderNodeOut,
    parent_pid: Option<&str>,
) -> Result<(), String> {
    // Create this folder.
    let pl = db
        .create_playlist(&folder.name, parent_pid, true)
        .map_err(|e| format!("Failed to create folder \"{}\": {}", folder.name, e))?;
    let folder_pid = pl.persistent_id.clone();

    for child in &folder.children {
        match child {
            TreeNodeOut::Folder(f) => {
                persist_tree(db, f, folder_pid.as_deref())?;
            }
            TreeNodeOut::Playlist(p) => {
                let new_pl = db
                    .create_playlist(&p.name, folder_pid.as_deref(), false)
                    .map_err(|e| format!("Failed to create playlist \"{}\": {}", p.name, e))?;
                if !p.track_ids.is_empty() {
                    db.add_tracks_to_playlist(new_pl.playlist_id, &p.track_ids)
                        .map_err(|e| format!("Failed to add tracks to \"{}\": {}", p.name, e))?;
                }
            }
        }
    }

    Ok(())
}
