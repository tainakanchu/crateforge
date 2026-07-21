//! YAML rules file の serde 表現。
//!
//! [zod スキーマ](https://github.com/tainakanchu/itunes-playlist-builder/blob/master/packages/core/src/ruleSchema.ts) の
//! ほぼ忠実な Rust 版。生の YAML キーは camelCase なので `rename_all = "camelCase"` を多用する。

use std::collections::HashMap;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesFile {
    pub namespace: String,
    #[serde(default)]
    pub options: Option<OptionsInput>,
    #[serde(default)]
    pub playlists: Vec<PlaylistRule>,
    #[serde(default)]
    pub templates: Option<HashMap<String, GeneratorTemplate>>,
    #[serde(default)]
    pub generators: Vec<GeneratorEntry>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptionsInput {
    pub remove_existing_namespace: Option<bool>,
    pub fail_on_missing_playlist: Option<bool>,
    pub dedupe_track_ids: Option<bool>,
    pub case_sensitive_contains: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistRule {
    pub name: String,
    /// 仕様上は受け取るが評価には使わない。
    #[allow(dead_code)]
    pub description: Option<String>,
    #[serde(rename = "match")]
    pub match_: Condition,
    pub sort: Option<Vec<SortRule>>,
    /// 将来の予約フィールド (現状は無視)。
    #[allow(dead_code)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Condition {
    All {
        all: Vec<Condition>,
    },
    Any {
        any: Vec<Condition>,
    },
    Not {
        not: Box<Condition>,
    },
    InPlaylist {
        #[serde(rename = "inPlaylist")]
        in_playlist: PlaylistRef,
    },
    Field(FieldCondition),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldCondition {
    pub field: String,
    #[serde(default)]
    pub equals: Option<serde_yaml::Value>,
    pub contains: Option<String>,
    #[serde(default, rename = "in")]
    pub in_: Option<Vec<serde_yaml::Value>>,
    pub gt: Option<f64>,
    pub gte: Option<f64>,
    pub lt: Option<f64>,
    pub lte: Option<f64>,
    pub exists: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistRef {
    pub source: PlaylistSource,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistSource {
    Existing,
    Generated,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SortRule {
    pub field: String,
    pub order: SortOrder,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    Asc,
    Desc,
}

// ---- Generators ----

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum GeneratorEntry {
    Inline(InlineGenerator),
    TemplateRef(TemplateRefGenerator),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InlineGenerator {
    BpmRange(BpmRangeGenerator),
    Ranges(RangesGenerator),
    Tags(TagsGenerator),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BpmRangeGenerator {
    pub base_path: String,
    pub source_playlist: PlaylistRef,
    pub from: i64,
    pub to: i64,
    pub step: i64,
    #[serde(default)]
    pub pad: usize,
    pub sort: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangesGenerator {
    pub base_path: String,
    pub source_playlist: PlaylistRef,
    pub field: String,
    pub ranges: Vec<RangeEntry>,
    #[serde(default)]
    pub pad: usize,
    pub sort: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagsGenerator {
    pub base_path: String,
    pub source_playlist: PlaylistRef,
    pub field: String,
    pub values: Vec<String>,
    pub sort: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRefGenerator {
    pub template: String,
    pub base_path: String,
    pub source_playlist: PlaylistRef,
    pub sort: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GeneratorTemplate {
    BpmRange(BpmRangeTemplate),
    Ranges(RangesTemplate),
    Tags(TagsTemplate),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BpmRangeTemplate {
    pub from: i64,
    pub to: i64,
    pub step: i64,
    #[serde(default)]
    pub pad: usize,
    pub sort: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangesTemplate {
    pub field: String,
    pub ranges: Vec<RangeEntry>,
    #[serde(default)]
    pub pad: usize,
    pub sort: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagsTemplate {
    pub field: String,
    pub values: Vec<String>,
    pub sort: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RangeEntry {
    pub name: Option<String>,
    pub gte: Option<f64>,
    pub gt: Option<f64>,
    pub lt: Option<f64>,
    pub lte: Option<f64>,
}

// ---- Effective options ----

#[derive(Debug, Clone, Copy)]
pub struct BuildOptions {
    pub remove_existing_namespace: bool,
    pub fail_on_missing_playlist: bool,
    pub dedupe_track_ids: bool,
    pub case_sensitive_contains: bool,
}

impl BuildOptions {
    pub fn resolve(input: Option<&OptionsInput>) -> Self {
        let i = input.cloned().unwrap_or_default();
        BuildOptions {
            remove_existing_namespace: i.remove_existing_namespace.unwrap_or(true),
            fail_on_missing_playlist: i.fail_on_missing_playlist.unwrap_or(true),
            dedupe_track_ids: i.dedupe_track_ids.unwrap_or(true),
            case_sensitive_contains: i.case_sensitive_contains.unwrap_or(false),
        }
    }
}

pub fn parse_rules_yaml(yaml: &str) -> Result<RulesFile, String> {
    serde_yaml::from_str::<RulesFile>(yaml).map_err(|e| format!("Rule validation failed: {}", e))
}

/// v1 でサポートする Track フィールド名一覧 (camelCase)。React 側補完用。
#[allow(dead_code)]
pub const SUPPORTED_FIELDS: &[&str] = &[
    "trackId",
    "name",
    "artist",
    "albumArtist",
    "composer",
    "album",
    "genre",
    "bpm",
    "rating",
    "playCount",
    "skipCount",
    "year",
    "trackNumber",
    "discNumber",
    "dateAdded",
    "dateModified",
    "location",
    "comments",
    "grouping",
    "compilation",
    "podcast",
    "disabled",
    "kind",
];
