//! 軽量なファイルロガー + panic フック。
//!
//! このアプリは GUI 起動で stderr がどこにも残らないため、クラッシュや非致命
//! エラーの痕跡を app data dir のログファイルに残す。`panic = "abort"` でも
//! `set_hook` は abort 前に走るので、panic のメッセージと発生箇所 (file:line、
//! release でも strip されない) を確実に記録できる。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// ログファイルのパス。`install` で一度だけ設定される。
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// このサイズ (バイト) を超えていたら起動時に切り詰める (簡易ローテーション)。
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// `app_data_dir/crateforge.log` を返す。
pub fn log_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("crateforge.log")
}

/// ロガーを初期化し、panic フックを登録する。`setup` から app_data_dir を渡して呼ぶ。
/// 二重呼び出しは無視する。
pub fn install(app_data_dir: &Path) {
    // ディレクトリが無ければ作る (初回起動など)。
    let _ = std::fs::create_dir_all(app_data_dir);
    let path = log_file_path(app_data_dir);

    // 肥大化していたら切り詰める。
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = File::create(&path);
        }
    }

    if LOG_PATH.set(path).is_err() {
        return; // 既に初期化済み。
    }

    write_line(
        "info",
        &format!("crateforge {} started", env!("CARGO_PKG_VERSION")),
    );
    install_panic_hook();
}

/// 任意のイベントを 1 行追記する (best-effort、失敗は握りつぶす)。
/// `install` 前に呼ばれた場合は何もしない。
pub fn write_line(level: &str, msg: &str) {
    if let Some(path) = LOG_PATH.get() {
        append_line(path, level, msg);
    }
}

/// 指定パスへ 1 行追記する (タイムスタンプ付き)。テスト可能なように分離。
fn append_line(path: &Path, level: &str, msg: &str) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f %z");
    let line = format!("[{ts}] [{level}] {msg}\n");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// panic を捕捉してログに書き、その後で既定フック (stderr 出力) も呼ぶ。
/// `panic = "abort"` でも abort 前に走る。
fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        // payload は &str か String のことが多い。
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let bt = std::backtrace::Backtrace::force_capture();
        write_line(
            "PANIC",
            &format!(
                "v{} thread='{}' at {}: {}\n--- backtrace ---\n{}",
                env!("CARGO_PKG_VERSION"),
                thread,
                location,
                msg,
                bt
            ),
        );
        // 既定フック (stderr へのメッセージ出力) も呼んでおく。
        prev(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_file_path_joins() {
        let p = log_file_path(Path::new("/tmp/somedir"));
        assert!(p.ends_with("crateforge.log"));
        assert_eq!(p.parent().unwrap(), Path::new("/tmp/somedir"));
    }

    #[test]
    fn append_line_creates_and_appends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        append_line(&path, "info", "hello");
        append_line(&path, "PANIC", "boom at foo.rs:42");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("[info] hello"), "got: {content}");
        assert!(content.contains("[PANIC] boom at foo.rs:42"), "got: {content}");
        assert_eq!(content.lines().count(), 2, "got: {content}");
    }
}
