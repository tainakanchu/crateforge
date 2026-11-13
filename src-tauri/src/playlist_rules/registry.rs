//! `inPlaylist { source: existing }` の参照先を引く索引 (フルパス優先、次に一意な名前)。
//!
//! 対象は namespace ルートフォルダの外にある既存プレイリスト・フォルダ。namespace の中は
//! このルールセット自身が作るものなので、`source: generated` で参照してもらう。

use std::collections::{HashMap, HashSet};

use crate::db::playlists::PlaylistNode;

pub struct ExistingIndex {
    /// "親/子/名前" → persistent_id。
    by_full_path: HashMap<String, String>,
    /// 名前 → persistent_id (同名が複数あれば複数)。
    by_name: HashMap<String, Vec<String>>,
    /// namespace の中にだけあるパス / 名前 (エラーメッセージを分かりやすくする用)。
    in_namespace: HashSet<String>,
    namespace: String,
}

/// 親チェーンを辿って "親/子/名前" を作る。壊れたデータで循環していても止まる。
fn full_path(node: &PlaylistNode, by_pid: &HashMap<&str, &PlaylistNode>) -> String {
    let mut parts = vec![node.name.as_str()];
    let mut parent = node.parent_persistent_id.as_deref();
    let mut depth = 0;
    while let Some(pid) = parent {
        let Some(p) = by_pid.get(pid) else { break };
        depth += 1;
        if depth > 64 {
            break;
        }
        parts.push(p.name.as_str());
        parent = p.parent_persistent_id.as_deref();
    }
    parts.reverse();
    parts.join("/")
}

impl ExistingIndex {
    /// `namespace_pids` = namespace ルートフォルダ (複数あれば全部) とその子孫の persistent_id。
    pub fn build(
        nodes: &[PlaylistNode],
        namespace_pids: &HashSet<String>,
        namespace: &str,
    ) -> Self {
        let by_pid: HashMap<&str, &PlaylistNode> = nodes
            .iter()
            .filter_map(|n| n.persistent_id.as_deref().map(|p| (p, n)))
            .collect();
        let mut by_full_path = HashMap::new();
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        let mut in_namespace = HashSet::new();
        for n in nodes {
            let Some(pid) = n.persistent_id.as_ref() else {
                continue;
            };
            let path = full_path(n, &by_pid);
            if namespace_pids.contains(pid) {
                in_namespace.insert(path);
                in_namespace.insert(n.name.clone());
                continue;
            }
            by_full_path.entry(path).or_insert_with(|| pid.clone());
            by_name.entry(n.name.clone()).or_default().push(pid.clone());
        }
        ExistingIndex {
            by_full_path,
            by_name,
            in_namespace,
            namespace: namespace.to_string(),
        }
    }

    /// 参照先の persistent_id。見つからない・曖昧なら理由を Err で返す。
    pub fn resolve(&self, name: &str) -> Result<String, String> {
        if let Some(pid) = self.by_full_path.get(name) {
            return Ok(pid.clone());
        }
        match self.by_name.get(name).map(Vec::as_slice) {
            Some([only]) => Ok(only.clone()),
            Some(list) if list.len() > 1 => Err(format!(
                "既存のプレイリストで「{}」という名前のものが複数あります。フォルダを含むパスで指定してください",
                name
            )),
            _ if self.in_namespace.contains(name) => Err(format!(
                "参照した既存のプレイリスト「{}」は namespace「{}」の中にあります。source: generated で参照してください",
                name, self.namespace
            )),
            _ => Err(format!(
                "参照した既存のプレイリストが見つかりません: 「{}」",
                name
            )),
        }
    }
}
