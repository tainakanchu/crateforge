//! Rules の適用本体。namespace ルートフォルダ配下をパスで upsert し (既存ノードは
//! playlist_id / persistent_id を保ったまま再利用)、各プレイリストにスマート条件を書く。
//!
//! 呼び出し側が張ったトランザクションの中で実行する前提 (自前のトランザクションは張らない)。
//! Apply はコミット、Preview は同じ処理を流してロールバックする。
//!
//! 手順:
//! 1. ルール展開 (generator) → ツリー構築 → 参照の検証 (書き込み前に全部エラーにする)
//! 2. Phase A: ルートフォルダを探して (無ければ作って) ツリーを upsert、パス → PID を記録
//! 3. Phase B: `inPlaylist` を PID に解決してスマート条件を書く
//! 4. 書いた条件をライブ評価して `playlist_tracks` にスナップショットを書く
//!    (サイドバーの曲数など、静的な行を読む経路が適用時点の状態と一致するように)

use std::collections::{HashMap, HashSet};

use crate::db::playlists::PlaylistNode;
use crate::db::Database;

use super::folder_tree::{self, FolderSpec, SpecNode};
use super::generator;
use super::models::{FolderNodeOut, PlaylistNodeOut, TreeNodeOut};
use super::registry::ExistingIndex;
use super::schema::{
    BuildOptions, Condition, PlaylistRef, PlaylistRule, PlaylistSource, RulesFile,
};
use super::to_smart::{self, RefResolution};

/// 適用結果 (Preview / Apply 共通)。
pub struct Outcome {
    pub tree: FolderNodeOut,
    pub folder_count: usize,
    pub playlist_count: usize,
    pub created: usize,
    pub updated: usize,
    pub removed: usize,
    pub warnings: Vec<String>,
}

fn db_err(context: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |e| format!("{}: {}", context, e)
}

/// ルールを適用する。呼び出し側のトランザクション内で呼ぶこと。
pub fn apply_in_txn(db: &Database, rules_file: &RulesFile) -> Result<Outcome, String> {
    let options = BuildOptions::resolve(rules_file.options.as_ref());
    let namespace = rules_file.namespace.as_str();
    if namespace.trim().is_empty() {
        return Err("Rule validation failed: namespace must not be empty".to_string());
    }

    let mut warnings = Vec::new();
    if options.case_sensitive_contains {
        warnings.push(
            "caseSensitiveContains is not supported by smart playlists; text matching is always case-insensitive"
                .to_string(),
        );
    }

    let templates = rules_file.templates.clone().unwrap_or_default();
    let mut rules: Vec<PlaylistRule> = rules_file.playlists.clone();
    rules.extend(generator::expand_generators(
        &rules_file.generators,
        &templates,
    )?);

    let spec = folder_tree::build_spec_tree(namespace, &rules)?;

    let nodes = db
        .get_playlist_nodes()
        .map_err(db_err("Failed to load playlists"))?;
    // namespace ルート (トップレベルの同名フォルダ)。sort_order, playlist_id 順に並んでいる。
    let roots: Vec<&PlaylistNode> = nodes
        .iter()
        .filter(|n| {
            n.parent_persistent_id.is_none()
                && n.is_folder
                && n.name == namespace
                && n.persistent_id.is_some()
        })
        .collect();
    let mut children: HashMap<String, Vec<PlaylistNode>> = HashMap::new();
    for n in &nodes {
        if let Some(parent) = &n.parent_persistent_id {
            children.entry(parent.clone()).or_default().push(n.clone());
        }
    }
    let namespace_pids = subtree_pids(&roots, &children);
    let existing = ExistingIndex::build(&nodes, &namespace_pids, namespace);

    validate_refs(&rules, &existing, options.fail_on_missing_playlist)?;

    // ---- Phase A: ツリーの upsert ----
    let (created, updated, removed, playlists, by_path) = {
        let mut up = Upserter {
            db,
            namespace,
            children,
            prune: options.remove_existing_namespace,
            created: 0,
            updated: 0,
            removed: 0,
            warnings: &mut warnings,
            order: Vec::new(),
            playlists: Vec::new(),
            by_path: HashMap::new(),
        };
        let root_pid = match roots.first() {
            Some(root) => {
                if roots.len() > 1 {
                    up.warnings.push(format!(
                        "Found {} top-level folders named \"{}\"; using the first one and leaving the others untouched",
                        roots.len(),
                        namespace
                    ));
                }
                up.updated += 1;
                root.persistent_id.clone().expect("filtered above")
            }
            None => {
                let pl = db
                    .create_playlist(namespace, None, true)
                    .map_err(|e| format!("Failed to create folder \"{}\": {}", namespace, e))?;
                up.created += 1;
                pl.persistent_id
                    .ok_or_else(|| format!("Failed to create folder \"{}\"", namespace))?
            }
        };
        up.upsert_folder(&root_pid, &spec)?;
        up.resequence()?;
        (up.created, up.updated, up.removed, up.playlists, up.by_path)
    };

    // ---- Phase B: スマート条件を書く ----
    let mut resolve = |r: &PlaylistRef| -> RefResolution {
        match r.source {
            // 前方参照は検証済みなので、generated は必ず先に upsert されている。
            PlaylistSource::Generated => by_path
                .get(&r.name)
                .cloned()
                .ok_or_else(|| format!("Generated playlist \"{}\" not found", r.name)),
            PlaylistSource::Existing => existing.resolve(&r.name),
        }
    };
    for (rule_index, playlist_id) in &playlists {
        let criteria = to_smart::rule_to_criteria(&rules[*rule_index], &mut resolve, &mut warnings);
        db.set_smart_criteria(*playlist_id, &criteria)
            .map_err(db_err("Failed to save smart criteria"))?;
    }

    // ---- 書いた条件をライブ評価してスナップショットを書く ----
    let mut members: HashMap<usize, Vec<i64>> = HashMap::new();
    {
        let mut resolver = db
            .playlist_resolver()
            .map_err(db_err("Failed to evaluate playlists"))?;
        for (rule_index, playlist_id) in &playlists {
            let ids = resolver
                .track_ids(*playlist_id)
                .map_err(db_err("Failed to evaluate playlists"))?;
            members.insert(*rule_index, ids);
        }
    }
    for (rule_index, playlist_id) in &playlists {
        db.overwrite_playlist_tracks(*playlist_id, &members[rule_index])
            .map_err(db_err("Failed to write playlist tracks"))?;
    }

    let tree = to_out(&spec, namespace, None, &mut members);
    let (folder_count, playlist_count) = folder_tree::count_nodes(&tree);
    Ok(Outcome {
        tree,
        folder_count,
        playlist_count,
        created,
        updated,
        removed,
        warnings,
    })
}

/// ルート群とその子孫の persistent_id。
fn subtree_pids(
    roots: &[&PlaylistNode],
    children: &HashMap<String, Vec<PlaylistNode>>,
) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut stack: Vec<String> = roots
        .iter()
        .filter_map(|r| r.persistent_id.clone())
        .collect();
    while let Some(pid) = stack.pop() {
        if !out.insert(pid.clone()) {
            continue;
        }
        for c in children.get(&pid).into_iter().flatten() {
            if let Some(p) = &c.persistent_id {
                stack.push(p.clone());
            }
        }
    }
    out
}

/// 参照の検証: generated は自分より前のルールだけ (= 循環しない)、existing は
/// `failOnMissingPlaylist` なら解決できること。
fn validate_refs(
    rules: &[PlaylistRule],
    existing: &ExistingIndex,
    fail_on_missing: bool,
) -> Result<(), String> {
    fn walk(
        c: &Condition,
        current: &str,
        seen: &HashSet<&str>,
        existing: &ExistingIndex,
        fail_on_missing: bool,
    ) -> Result<(), String> {
        match c {
            Condition::All { all: list } | Condition::Any { any: list } => {
                for c in list {
                    walk(c, current, seen, existing, fail_on_missing)?;
                }
                Ok(())
            }
            Condition::Not { not } => walk(not, current, seen, existing, fail_on_missing),
            Condition::InPlaylist { in_playlist } => match in_playlist.source {
                PlaylistSource::Generated if !seen.contains(in_playlist.name.as_str()) => {
                    Err(format!(
                        "Generated playlist \"{}\" references later playlist \"{}\"",
                        current, in_playlist.name
                    ))
                }
                PlaylistSource::Generated => Ok(()),
                PlaylistSource::Existing if fail_on_missing => {
                    existing.resolve(&in_playlist.name).map(|_| ())
                }
                PlaylistSource::Existing => Ok(()),
            },
            Condition::Field(_) => Ok(()),
        }
    }

    let mut seen: HashSet<&str> = HashSet::new();
    for rule in rules {
        walk(&rule.match_, &rule.name, &seen, existing, fail_on_missing)?;
        seen.insert(&rule.name);
    }
    Ok(())
}

struct Upserter<'a> {
    db: &'a Database,
    namespace: &'a str,
    /// 適用前の 親 PID → 子 (sort_order 順)。処理した親の分は取り出して消す。
    children: HashMap<String, Vec<PlaylistNode>>,
    prune: bool,
    created: usize,
    updated: usize,
    removed: usize,
    warnings: &'a mut Vec<String>,
    /// ツリーのノード (ルート以外) の playlist_id を YAML の深さ優先順で。
    order: Vec<i64>,
    /// (ルール添字, playlist_id)。
    playlists: Vec<(usize, i64)>,
    /// ルールのパス → persistent_id。
    by_path: HashMap<String, String>,
}

impl Upserter<'_> {
    fn full_path(&self, path: &str) -> String {
        format!("{}/{}", self.namespace, path)
    }

    fn delete_subtree(&mut self, node: &PlaylistNode) -> Result<(), String> {
        self.removed += self
            .db
            .delete_playlist_subtree(node.playlist_id)
            .map_err(|e| format!("Failed to remove \"{}\": {}", node.name, e))?;
        Ok(())
    }

    /// フォルダ (parent_pid) の子を spec どおりに揃える。同名・同種の既存の子は再利用、
    /// 種類が違えば作り直し、無ければ作る。prune なら spec に無い子は消す。
    fn upsert_folder(&mut self, parent_pid: &str, spec: &FolderSpec) -> Result<(), String> {
        let existing = self.children.remove(parent_pid).unwrap_or_default();
        let mut claimed = vec![false; existing.len()];

        for child in &spec.children {
            let (name, path, is_folder) = match child {
                SpecNode::Folder(f) => (f.name.as_str(), f.path.as_str(), true),
                SpecNode::Playlist(p) => (p.name.as_str(), p.path.as_str(), false),
            };
            let same_kind = (0..existing.len()).find(|&i| {
                !claimed[i]
                    && existing[i].name == name
                    && existing[i].is_folder == is_folder
                    && existing[i].persistent_id.is_some()
            });
            let (playlist_id, pid) = match same_kind {
                Some(i) => {
                    claimed[i] = true;
                    self.updated += 1;
                    let e = &existing[i];
                    (e.playlist_id, e.persistent_id.clone().expect("checked"))
                }
                None => {
                    if let Some(i) =
                        (0..existing.len()).find(|&i| !claimed[i] && existing[i].name == name)
                    {
                        claimed[i] = true;
                        self.delete_subtree(&existing[i])?;
                        let kind = |folder: bool| if folder { "folder" } else { "playlist" };
                        self.warnings.push(format!(
                            "Replaced existing {} \"{}\" with a {}",
                            kind(existing[i].is_folder),
                            self.full_path(path),
                            kind(is_folder)
                        ));
                    }
                    let pl = self
                        .db
                        .create_playlist(name, Some(parent_pid), is_folder)
                        .map_err(|e| format!("Failed to create \"{}\": {}", name, e))?;
                    self.created += 1;
                    let pid = pl
                        .persistent_id
                        .ok_or_else(|| format!("Failed to create \"{}\"", name))?;
                    (pl.playlist_id, pid)
                }
            };
            self.order.push(playlist_id);
            match child {
                SpecNode::Folder(f) => self.upsert_folder(&pid, f)?,
                SpecNode::Playlist(p) => {
                    self.playlists.push((p.rule_index, playlist_id));
                    self.by_path.insert(p.path.clone(), pid);
                }
            }
        }

        if self.prune {
            for (i, node) in existing.iter().enumerate() {
                if !claimed[i] {
                    self.delete_subtree(node)?;
                }
            }
        }
        Ok(())
    }

    /// ツリーのノードの sort_order を YAML の順に振り直す。値の集合は今のまま
    /// (新規ノードの末尾採番分を含む) で並びだけ入れ替えるので、毎回増え続けない。
    fn resequence(&self) -> Result<(), String> {
        let current: HashMap<i64, i64> = self
            .db
            .get_playlist_nodes()
            .map_err(db_err("Failed to load playlists"))?
            .into_iter()
            .map(|n| (n.playlist_id, n.sort_order))
            .collect();
        let mut values: Vec<i64> = self
            .order
            .iter()
            .filter_map(|id| current.get(id).copied())
            .collect();
        values.sort_unstable();
        for (id, value) in self.order.iter().zip(values) {
            if current.get(id) != Some(&value) {
                self.db
                    .set_playlist_sort_order(*id, value)
                    .map_err(db_err("Failed to reorder playlists"))?;
            }
        }
        Ok(())
    }
}

/// spec + 評価結果からフロント向けのツリーを作る。
fn to_out(
    spec: &FolderSpec,
    namespace: &str,
    parent_path: Option<String>,
    members: &mut HashMap<usize, Vec<i64>>,
) -> FolderNodeOut {
    let full = |path: &str| {
        if path.is_empty() {
            namespace.to_string()
        } else {
            format!("{}/{}", namespace, path)
        }
    };
    let full_path = full(&spec.path);
    let children = spec
        .children
        .iter()
        .map(|c| match c {
            SpecNode::Folder(f) => {
                TreeNodeOut::Folder(to_out(f, namespace, Some(full_path.clone()), members))
            }
            SpecNode::Playlist(p) => TreeNodeOut::Playlist(PlaylistNodeOut {
                name: p.name.clone(),
                full_path: full(&p.path),
                parent_path: Some(full_path.clone()),
                track_ids: members.remove(&p.rule_index).unwrap_or_default(),
            }),
        })
        .collect();
    FolderNodeOut {
        name: spec.name.clone(),
        full_path,
        parent_path,
        children,
    }
}
