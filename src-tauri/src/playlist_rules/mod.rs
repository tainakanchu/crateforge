//! 宣言的プレイリストビルダー。
//!
//! YAML で書かれたルールセットを受け取り、ジェネレーター展開 → 階層フォルダ構築 →
//! 各ルールをスマートプレイリスト条件に変換して DB へ upsert、をまとめてやる。
//! 生成されるのはスマートプレイリストなので、親ルールの定義や曲のメタデータを変えると
//! 参照している側にも再適用なしで伝わる。
//!
//! 詳細仕様は [tainakanchu/itunes-playlist-builder] の `doc.md` を参照。

pub mod folder_tree;
pub mod generator;
pub mod models;
pub mod persist;
pub mod registry;
pub mod runner;
pub mod schema;
pub mod to_smart;

#[cfg(test)]
mod tests;

// Public for serde (referenced via EvaluationResult tree types in commands).
#[allow(unused_imports)]
pub use models::{ApplyResult, EvaluationResult, FolderNodeOut, PlaylistNodeOut, TreeNodeOut};
pub use runner::{apply_rules, preview_rules, validate_rules};
