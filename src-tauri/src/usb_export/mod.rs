//! USB 書き出し (rekordbox 互換 / CDJ 向け)。実際の書き出しは外部の GPL CLI `rbx-cli` が行う
//! (`crate::rbx_cli` 参照)。

pub mod errors;
pub mod wire;
