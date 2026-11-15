//! ライブラリ操作のユースケース層。
//!
//! GUI の Tauri コマンド (`commands/*`) と HTTP API (`api/handlers.rs`) は薄いアダプタで、
//! 「何をどの順でやるか」はここに置く (docs/refactor/design.md)。同じ手順を両方に書くと
//! 片方だけ直る食い違いが起きるため。
//!
//! 約束:
//! - `AppHandle`・axum に依存しない。引数は `&Database` と素の値。
//! - エラーはモジュールごとの enum。`ApiError` (HTTP ステータス) / `String` (コマンド) への
//!   写像はアダプタ側で行う。
//! - 再生キューの掃除・UI への通知など DB の外の後始末は、結果の値を見てアダプタが行う。

pub mod edit;
pub mod playlists;
pub mod similar;
