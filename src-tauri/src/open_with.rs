//! OS の「このアプリで開く」/ 既定のプレーヤー (ファイル関連付け) で渡された音声ファイルの受け取り。
//!
//! 受け取り経路:
//! - Windows / Linux: 初回起動の argv と、起動中の 2 回目以降の起動 (`tauri-plugin-single-instance`
//!   が既存プロセスへ argv を転送する)。
//! - macOS: `RunEvent::Opened { urls }` (file:// URL)。
//!
//! フロントが準備できる前 (起動直後) に届くことがあるので、受け取ったパスはまず
//! [`PendingOpen`] に溜める。フロントはマウント時に `take_pending_open_files` で取り出し、
//! それ以降に届いた分は `open-files` イベントで受け取る。どちらの経路で渡すかは
//! 同じロックの下で決めるので、同じファイルが二重に再生されることはない。
//!
//! Windows のエクスプローラーで複数ファイルを選んで開くと、ファイルごとに別プロセスが
//! 起動されて 1 件ずつ転送されてくる。「まとめて開いた = キューを置き換える」ために、
//! 短時間 ([`COALESCE_WINDOW`]) に続けて届いた分は 1 回の「開く」にまとめる。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// 起動中に届いたファイルをフロントへ渡すイベント名 (payload: `string[]`)。
pub const OPEN_FILES_EVENT: &str = "open-files";

/// 続けて届いたファイルを 1 回の「開く」にまとめる幅 (最後に届いてからこの時間待つ)。
pub const COALESCE_WINDOW: Duration = Duration::from_millis(600);

/// 関連付け (tauri.conf.json の `bundle.fileAssociations`) と揃えた、開けるファイルの拡張子。
/// 再生デコーダ (rodio + symphonia) が扱えるものだけ。Opus は symphonia 0.5 に
/// デコーダが無いので含めない (WMA も同様)。
pub const OPEN_WITH_EXTENSIONS: &[&str] =
    &["mp3", "flac", "wav", "aiff", "aif", "m4a", "aac", "ogg"];

/// 「このアプリで開く」で再生できる拡張子か (大文字小文字は無視)。
pub fn is_openable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| OPEN_WITH_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// 1 個の引数をファイルパスとして解釈する。フラグ (`-` 始まり) は None。
/// `file://` URL (Linux のファイルマネージャが %U で渡す場合) も受け付け、
/// 相対パスは `cwd` (起動元のカレントディレクトリ) から解決する。
fn arg_to_path(arg: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let arg = arg.trim();
    if arg.is_empty() || arg.starts_with('-') {
        return None;
    }
    if arg.starts_with("file://") {
        return url::Url::parse(arg).ok()?.to_file_path().ok();
    }
    let p = PathBuf::from(arg);
    if p.is_absolute() {
        Some(p)
    } else {
        cwd.map(|c| c.join(&p))
    }
}

/// 存在する、開ける拡張子のファイルだけを、重複を除いて順序どおりに残す。
pub(crate) fn keep_openable(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in paths {
        if p.is_file() && is_openable(&p) && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// 起動引数 (`args[0]` は実行ファイル) から開くファイルを取り出す。
/// フラグ・存在しないパス・対応外の拡張子は無視する。
pub fn paths_from_args(args: &[String], cwd: Option<&Path>) -> Vec<PathBuf> {
    keep_openable(args.iter().skip(1).filter_map(|a| arg_to_path(a, cwd)))
}

/// macOS の `RunEvent::Opened` の URL 群 (file:// のみ) から開くファイルを取り出す。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn paths_from_urls(urls: &[url::Url]) -> Vec<PathBuf> {
    keep_openable(
        urls.iter()
            .filter(|u| u.scheme() == "file")
            .filter_map(|u| u.to_file_path().ok()),
    )
}

// ===== ライブラリ照合用のパス正規化 =====

/// パス比較の流儀。OS ごとのファイルシステムの慣習に合わせる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathStyle {
    /// Linux: 大文字小文字を区別する。
    Posix,
    /// macOS: 既定の APFS / HFS+ は大文字小文字を区別しない。
    /// ファイル名の Unicode 正規化 (NFD / NFC) の違いも吸収する。
    Mac,
    /// Windows: 大文字小文字を区別せず、`/` と `\` を同一視し、`\\?\` 接頭辞を外す。
    Windows,
}

impl PathStyle {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "windows") {
            PathStyle::Windows
        } else if cfg!(target_os = "macos") {
            PathStyle::Mac
        } else {
            PathStyle::Posix
        }
    }
}

/// 開いたファイルと DB の `location_path` を突き合わせるための比較キー。
pub(crate) fn path_key(path: &str, style: PathStyle) -> String {
    use unicode_normalization::UnicodeNormalization;
    match style {
        PathStyle::Posix => path.to_string(),
        PathStyle::Mac => path.nfc().collect::<String>().to_lowercase(),
        PathStyle::Windows => {
            let p = path.replace('/', "\\");
            let p = if let Some(rest) = p.strip_prefix("\\\\?\\UNC\\") {
                format!("\\\\{rest}")
            } else if let Some(rest) = p.strip_prefix("\\\\?\\") {
                rest.to_string()
            } else {
                p
            };
            p.to_lowercase()
        }
    }
}

/// 開いたファイルの比較キーの候補 (そのままのパスと、シンボリックリンク等を解決したパス)。
pub(crate) fn candidate_keys(path: &Path, style: PathStyle) -> Vec<String> {
    let mut keys = vec![path_key(&path.to_string_lossy(), style)];
    if let Ok(canon) = std::fs::canonicalize(path) {
        let k = path_key(&canon.to_string_lossy(), style);
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    keys
}

// ===== フロント準備前の取りこぼし / 二重再生の防止 =====

/// [`PendingInner::poll`] の結果 (まとめ待ちワーカーの次の行動)。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FlushAction {
    /// まだ続きが届くかもしれないので待つ。
    Wait(Duration),
    /// まとめ終わった。フロントへイベントで渡す。
    Emit(Vec<PathBuf>),
    /// 渡すものが無い / フロントがまだなので `take_pending_open_files` に任せる。
    Idle,
}

/// 受け取ったファイルの溜め置き (純粋な状態機械。時刻は引数で受ける)。
#[derive(Debug, Default)]
pub(crate) struct PendingInner {
    paths: Vec<PathBuf>,
    last_arrival: Option<Instant>,
    /// フロントが `take_pending_open_files` を呼んだ (以降はイベントで渡す)。
    frontend_ready: bool,
    /// まとめ待ちワーカーが動いているか。
    flusher_running: bool,
}

impl PendingInner {
    fn settled(&self, now: Instant) -> bool {
        self.last_arrival
            .is_none_or(|t| now.saturating_duration_since(t) >= COALESCE_WINDOW)
    }

    /// ファイルを溜める。まとめ待ちワーカーを起動すべきなら true。
    pub(crate) fn push(&mut self, paths: Vec<PathBuf>, now: Instant) -> bool {
        if paths.is_empty() {
            return false;
        }
        for p in paths {
            if !self.paths.contains(&p) {
                self.paths.push(p);
            }
        }
        self.last_arrival = Some(now);
        if self.flusher_running {
            return false;
        }
        self.flusher_running = true;
        true
    }

    /// まとめ待ちワーカーの 1 ステップ。
    pub(crate) fn poll(&mut self, now: Instant) -> FlushAction {
        if self.paths.is_empty() {
            self.flusher_running = false;
            return FlushAction::Idle;
        }
        if !self.settled(now) {
            let since = self
                .last_arrival
                .map(|t| now.saturating_duration_since(t))
                .unwrap_or_default();
            return FlushAction::Wait(COALESCE_WINDOW.saturating_sub(since));
        }
        self.flusher_running = false;
        if self.frontend_ready {
            FlushAction::Emit(std::mem::take(&mut self.paths))
        } else {
            // フロントのマウント時の取り出しに任せる。
            FlushAction::Idle
        }
    }

    /// フロントのマウント時の取り出し。以降はイベントで渡すようになる。
    /// まとめ待ちの途中なら何も返さない (まとめ終わった時点でワーカーがイベントで渡す)。
    pub(crate) fn take_for_frontend(&mut self, now: Instant) -> Vec<PathBuf> {
        self.frontend_ready = true;
        if self.paths.is_empty() || !self.settled(now) {
            return Vec::new();
        }
        std::mem::take(&mut self.paths)
    }
}

/// 受け取ったファイルの溜め置き (Tauri managed state)。
#[derive(Default)]
pub struct PendingOpen {
    inner: Mutex<PendingInner>,
}

impl PendingOpen {
    fn lock(&self) -> std::sync::MutexGuard<'_, PendingInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn take_for_frontend(&self) -> Vec<PathBuf> {
        self.lock().take_for_frontend(Instant::now())
    }
}

/// OS から受け取ったファイルを溜め、まとめ終わったらフロントへ渡す。
/// どのスレッドから呼んでもよい (ブロックしない)。
pub fn receive(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let Some(pending) = app.try_state::<PendingOpen>() else {
        return;
    };
    if !pending.lock().push(paths, Instant::now()) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let action = app.state::<PendingOpen>().lock().poll(Instant::now());
        match action {
            FlushAction::Wait(d) => std::thread::sleep(d.max(Duration::from_millis(10))),
            FlushAction::Emit(paths) => {
                let payload: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = app.emit(OPEN_FILES_EVENT, payload);
                break;
            }
            FlushAction::Idle => break,
        }
    });
}

/// 2 回目以降の起動 (single-instance) で既存のメインウィンドウを前面に出す。
pub fn focus_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"x").unwrap();
        p
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn args_skip_exe_flags_missing_and_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let a = touch(dir.path(), "a.mp3");
        let b = touch(dir.path(), "B.FLAC");
        let txt = touch(dir.path(), "notes.txt");
        let opus = touch(dir.path(), "x.opus");
        let args = vec![
            // args[0] は実行ファイル自身 (たとえ音声ファイル名に見えても無視)。
            s(&a),
            "--some-flag".to_string(),
            "-psn_0_12345".to_string(),
            s(&b),
            s(&txt),
            s(&opus),
            s(&dir.path().join("missing.mp3")),
            s(dir.path()),
            s(&a),
            s(&b), // 重複
        ];
        assert_eq!(paths_from_args(&args, None), vec![b, a]);
    }

    #[test]
    fn args_resolve_relative_paths_and_file_urls() {
        let dir = tempfile::tempdir().unwrap();
        let a = touch(dir.path(), "song one.wav");
        let b = touch(dir.path(), "two.aif");
        let url = url::Url::from_file_path(&b).unwrap().to_string();
        let args = vec!["crateforge".into(), "song one.wav".into(), url];
        assert_eq!(paths_from_args(&args, Some(dir.path())), vec![a.clone(), b]);
        // cwd が分からなければ相対パスは捨てる。
        assert!(paths_from_args(&["exe".into(), "song one.wav".into()], None).is_empty());
    }

    #[test]
    fn urls_keep_only_existing_file_urls() {
        let dir = tempfile::tempdir().unwrap();
        let a = touch(dir.path(), "a.m4a");
        let urls = vec![
            url::Url::from_file_path(&a).unwrap(),
            url::Url::parse("https://example.com/a.mp3").unwrap(),
            url::Url::from_file_path(dir.path().join("missing.mp3")).unwrap(),
        ];
        assert_eq!(paths_from_urls(&urls), vec![a]);
    }

    #[test]
    fn path_key_normalizes_per_platform_style() {
        // Linux は大文字小文字を区別する。
        assert_ne!(
            path_key("/music/A.mp3", PathStyle::Posix),
            path_key("/music/a.mp3", PathStyle::Posix)
        );
        // macOS: 大文字小文字と NFD/NFC を吸収 ("が" の合成済み / 分解形)。
        assert_eq!(
            path_key("/Music/\u{304C}.mp3", PathStyle::Mac),
            path_key("/music/\u{304B}\u{3099}.MP3", PathStyle::Mac)
        );
        // Windows: 大文字小文字・区切り文字・\\?\ 接頭辞を吸収。
        let k = path_key(r"C:\Music\Artist\Song.mp3", PathStyle::Windows);
        assert_eq!(k, path_key("c:/music/artist/SONG.MP3", PathStyle::Windows));
        assert_eq!(
            k,
            path_key(r"\\?\C:\Music\Artist\Song.mp3", PathStyle::Windows)
        );
        assert_eq!(
            path_key(r"\\?\UNC\nas\share\a.mp3", PathStyle::Windows),
            path_key(r"\\NAS\share\a.mp3", PathStyle::Windows)
        );
    }

    #[test]
    fn pending_before_frontend_ready_is_taken_once_after_settling() {
        let t0 = Instant::now();
        let mut p = PendingInner::default();
        assert!(p.push(vec![PathBuf::from("/a.mp3")], t0));
        // 続けて届いた分は同じまとまりに入り、ワーカーは増やさない。
        assert!(!p.push(vec![PathBuf::from("/b.mp3")], t0 + Duration::from_millis(100)));
        assert!(matches!(
            p.poll(t0 + Duration::from_millis(200)),
            FlushAction::Wait(_)
        ));
        // まとめ終わったがフロント未準備: ワーカーは手を引き、取り出しに任せる。
        let settled = t0 + Duration::from_millis(100) + COALESCE_WINDOW;
        assert_eq!(p.poll(settled), FlushAction::Idle);
        assert_eq!(
            p.take_for_frontend(settled),
            vec![PathBuf::from("/a.mp3"), PathBuf::from("/b.mp3")]
        );
        // 二重に渡さない。
        assert!(p.take_for_frontend(settled).is_empty());
        assert_eq!(p.poll(settled), FlushAction::Idle);
    }

    #[test]
    fn pending_after_frontend_ready_is_emitted_once() {
        let t0 = Instant::now();
        let mut p = PendingInner::default();
        assert!(p.take_for_frontend(t0).is_empty());
        assert!(p.push(vec![PathBuf::from("/a.mp3")], t0));
        let settled = t0 + COALESCE_WINDOW;
        assert_eq!(
            p.poll(settled),
            FlushAction::Emit(vec![PathBuf::from("/a.mp3")])
        );
        assert_eq!(p.poll(settled), FlushAction::Idle);
        // 次のまとまりでは再びワーカーを起動する。
        assert!(p.push(vec![PathBuf::from("/b.mp3")], settled));
    }

    #[test]
    fn take_during_coalescing_defers_to_event() {
        let t0 = Instant::now();
        let mut p = PendingInner::default();
        assert!(p.push(vec![PathBuf::from("/a.mp3")], t0));
        // まとめ待ちの途中でフロントが準備できた: 取り出しでは渡さず、
        // まとめ終わった時点でワーカーがイベントで (全部まとめて) 渡す。
        assert!(p
            .take_for_frontend(t0 + Duration::from_millis(50))
            .is_empty());
        assert!(!p.push(vec![PathBuf::from("/b.mp3")], t0 + Duration::from_millis(80)));
        assert_eq!(
            p.poll(t0 + Duration::from_millis(80) + COALESCE_WINDOW),
            FlushAction::Emit(vec![PathBuf::from("/a.mp3"), PathBuf::from("/b.mp3")])
        );
    }
}
