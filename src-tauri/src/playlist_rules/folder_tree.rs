//! ルールのパス ("A/B/name") から namespace 配下の folder/playlist ツリーを組み立てる。
//!
//! 子の並びは YAML に最初に出てきた順 (フォルダとプレイリストを混在させたまま保つ)。

use std::collections::HashSet;

use super::models::{FolderNodeOut, TreeNodeOut};
use super::schema::PlaylistRule;

/// 作るべきツリーのノード。
#[derive(Debug, Clone, PartialEq)]
pub enum SpecNode {
    Folder(FolderSpec),
    Playlist(PlaylistSpec),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderSpec {
    pub name: String,
    /// namespace を含まない相対パス (ルートは "")。
    pub path: String,
    pub children: Vec<SpecNode>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlaylistSpec {
    pub name: String,
    /// namespace を含まない相対パス (= ルール名)。
    pub path: String,
    /// 対応するルールの添字。
    pub rule_index: usize,
}

/// ルール列からツリーを作る。重複パス・空のパス要素・フォルダとプレイリストの衝突はエラー。
pub fn build_spec_tree(namespace: &str, rules: &[PlaylistRule]) -> Result<FolderSpec, String> {
    let mut root = FolderSpec {
        name: namespace.to_string(),
        path: String::new(),
        children: Vec::new(),
    };
    let mut seen: HashSet<&str> = HashSet::new();
    for (rule_index, rule) in rules.iter().enumerate() {
        let path = rule.name.as_str();
        if !seen.insert(path) {
            return Err(format!("生成するプレイリストのパスが重複しています: 「{}」", path));
        }
        let segments: Vec<&str> = path.split('/').collect();
        if segments.iter().any(|s| s.trim().is_empty()) {
            return Err(format!("生成するプレイリストのパスが不正です: 「{}」", path));
        }
        let (name, folders) = segments.split_last().expect("split yields at least one");
        let mut current = &mut root;
        for (depth, seg) in folders.iter().enumerate() {
            let folder_path = segments[..=depth].join("/");
            let pos = current.children.iter().position(|c| match c {
                SpecNode::Folder(f) => f.name == *seg,
                SpecNode::Playlist(p) => p.name == *seg,
            });
            let idx = match pos {
                Some(i) => {
                    if matches!(current.children[i], SpecNode::Playlist(_)) {
                        return Err(format!(
                            "生成するプレイリストのパス「{}」が、プレイリスト「{}」をフォルダとして使っています",
                            path, folder_path
                        ));
                    }
                    i
                }
                None => {
                    current.children.push(SpecNode::Folder(FolderSpec {
                        name: seg.to_string(),
                        path: folder_path,
                        children: Vec::new(),
                    }));
                    current.children.len() - 1
                }
            };
            let SpecNode::Folder(f) = &mut current.children[idx] else {
                unreachable!("checked above")
            };
            current = f;
        }
        if current.children.iter().any(|c| match c {
            SpecNode::Folder(f) => f.name == *name,
            SpecNode::Playlist(p) => p.name == *name,
        }) {
            return Err(format!(
                "生成するプレイリストのパス「{}」はフォルダとしても使われています",
                path
            ));
        }
        current.children.push(SpecNode::Playlist(PlaylistSpec {
            name: name.to_string(),
            path: path.to_string(),
            rule_index,
        }));
    }
    Ok(root)
}

pub fn count_nodes(root: &FolderNodeOut) -> (usize, usize) {
    let mut folder_count = 0usize;
    let mut playlist_count = 0usize;

    fn walk(node: &TreeNodeOut, folders: &mut usize, playlists: &mut usize) {
        match node {
            TreeNodeOut::Folder(f) => {
                *folders += 1;
                for c in &f.children {
                    walk(c, folders, playlists);
                }
            }
            TreeNodeOut::Playlist(_) => {
                *playlists += 1;
            }
        }
    }

    for c in &root.children {
        walk(c, &mut folder_count, &mut playlist_count);
    }
    (folder_count, playlist_count)
}

pub fn collect_referenced_tracks(root: &FolderNodeOut) -> HashSet<i64> {
    let mut set = HashSet::new();
    fn walk(node: &TreeNodeOut, set: &mut HashSet<i64>) {
        match node {
            TreeNodeOut::Folder(f) => {
                for c in &f.children {
                    walk(c, set);
                }
            }
            TreeNodeOut::Playlist(p) => {
                for id in &p.track_ids {
                    set.insert(*id);
                }
            }
        }
    }
    for c in &root.children {
        walk(c, &mut set);
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlist_rules::schema::parse_rules_yaml;

    fn rules(names: &[&str]) -> Vec<PlaylistRule> {
        let mut yaml = String::from("namespace: N\nplaylists:\n");
        for n in names {
            yaml.push_str(&format!("  - name: \"{n}\"\n    match: {{all: []}}\n"));
        }
        parse_rules_yaml(&yaml).unwrap().playlists
    }

    fn shape(node: &SpecNode) -> String {
        match node {
            SpecNode::Folder(f) => format!(
                "{}[{}]",
                f.name,
                f.children.iter().map(shape).collect::<Vec<_>>().join(",")
            ),
            SpecNode::Playlist(p) => p.name.clone(),
        }
    }

    /// 子は YAML に最初に出てきた順 (フォルダとプレイリストの混在も保つ)。
    #[test]
    fn keeps_yaml_order() {
        let root =
            build_spec_tree("N", &rules(&["Top", "A/x", "B/y", "A/z", "A/S/w", "Last"])).unwrap();
        let got: Vec<String> = root.children.iter().map(shape).collect();
        assert_eq!(got, vec!["Top", "A[x,z,S[w]]", "B[y]", "Last"]);
    }

    #[test]
    fn rejects_bad_paths() {
        assert!(build_spec_tree("N", &rules(&["A", "A"]))
            .unwrap_err()
            .contains("重複"));
        assert!(build_spec_tree("N", &rules(&["A", "A/b"]))
            .unwrap_err()
            .contains("フォルダとして使っています"));
        assert!(build_spec_tree("N", &rules(&["A/b", "A"]))
            .unwrap_err()
            .contains("フォルダとしても使われています"));
        assert!(build_spec_tree("N", &rules(&["A//b"]))
            .unwrap_err()
            .contains("不正"));
    }
}
