//! 既存プレイリスト + 生成プレイリストの track-id セットを引けるレジストリ。

use std::collections::{HashMap, HashSet};

use super::models::GeneratedPlaylist;
use super::schema::{BuildOptions, PlaylistRef, PlaylistSource};

pub struct ExistingPlaylist {
    pub name: String,
    pub full_path: String,
    pub track_ids: Vec<i64>,
}

pub struct PlaylistRegistry {
    existing_by_full_path: HashMap<String, HashSet<i64>>,
    existing_by_name: HashMap<String, Vec<HashSet<i64>>>,
    generated_by_path: HashMap<String, HashSet<i64>>,
    options: BuildOptions,
}

impl PlaylistRegistry {
    pub fn new(existing: Vec<ExistingPlaylist>, options: BuildOptions) -> Self {
        let mut by_full_path = HashMap::new();
        let mut by_name: HashMap<String, Vec<HashSet<i64>>> = HashMap::new();

        for p in existing {
            let set: HashSet<i64> = p.track_ids.into_iter().collect();
            by_full_path.insert(p.full_path.clone(), set.clone());
            by_name.entry(p.name).or_default().push(set);
        }

        PlaylistRegistry {
            existing_by_full_path: by_full_path,
            existing_by_name: by_name,
            generated_by_path: HashMap::new(),
            options,
        }
    }

    pub fn resolve(&self, r: &PlaylistRef) -> Option<&HashSet<i64>> {
        match r.source {
            PlaylistSource::Existing => self.resolve_existing(&r.name),
            PlaylistSource::Generated => self.generated_by_path.get(&r.name),
        }
    }

    fn resolve_existing(&self, name: &str) -> Option<&HashSet<i64>> {
        // Try full path first.
        if let Some(s) = self.existing_by_full_path.get(name) {
            return Some(s);
        }

        // Fall back to bare name.
        match self.existing_by_name.get(name) {
            Some(list) if list.len() == 1 => Some(&list[0]),
            Some(list) if list.len() > 1 => {
                // Ambiguous; caller path will receive an error elsewhere.
                // For now, return None and let downstream handle it.
                let _ = list;
                None
            }
            _ => None,
        }
    }

    /// fail_on_missing_playlist が true なら見つからない existing 参照を Err に。
    pub fn check_existing(&self, name: &str) -> Result<(), String> {
        if !self.options.fail_on_missing_playlist {
            return Ok(());
        }
        if self.existing_by_full_path.contains_key(name) {
            return Ok(());
        }
        match self.existing_by_name.get(name) {
            Some(list) if list.len() == 1 => Ok(()),
            Some(list) if list.len() > 1 => Err(format!(
                "Multiple existing playlists matched name \"{}\"; use nested path when available",
                name
            )),
            _ => Err(format!(
                "Referenced existing playlist not found: \"{}\"",
                name
            )),
        }
    }

    pub fn register_generated(&mut self, p: &GeneratedPlaylist) {
        self.generated_by_path
            .insert(p.path.clone(), p.track_ids.iter().copied().collect());
    }

    pub fn has_generated(&self, path: &str) -> bool {
        self.generated_by_path.contains_key(path)
    }
}
