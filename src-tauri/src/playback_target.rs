//! Playback Coordinator: 有効な再生先 (このコンピューター / Google Cast) へ再生操作を
//! 振り分ける単一窓口。設計は `docs/cast/design.md` §3。
//!
//! - キュー / 再生順 / shuffle / repeat の権威は従来どおり `AudioPlayer`。
//! - Cast 中の `AudioPlayer` は「外部出力で再生中の曲」を覚えているだけで rodio の sink を
//!   持たない (`set_external_current`)。位置・再生中・音量は Cast の状態から作る。
//! - 曲の終了は Cast の `ItemEnded(Finished)` を `finished` に立て、`advance_worker` が
//!   [`PlaybackCoordinator::take_finished`] で取り出して従来と同じ経路で次曲へ進める。
//! - 再生実績 (play/skip) は Cast では `ItemEnded.played_ms` だけを根拠にする。
//!   再生先の切替では同じ曲の実績を二重に数えない:
//!   - Local → Cast: ローカルの実績は捨て、その分を Cast アイテムに `carry_ms` として持ち越す。
//!   - Cast → Local: Cast アイテムの実績は捨て (suppressed)、ローカルが位置ごと引き継ぐ。
//!     ただし接続断などで Cast 側が既に計上済みなら、ローカルは `report_offset` でその分を引く。
//! - 切替要求ごとに世代番号を進め、古い要求は await の後で `SUPERSEDED` として手を引く。
//! - 通信断でローカルへ自動で音を出すことはしない。

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::audio::{AudioPlayer, PlayReport};
use crate::cast::media_ticket::MediaTickets;
use crate::cast::protocol::{LoadRequest, PlayerState};
use crate::cast::session::{CastMediaSnapshot, CastSession, EndReason, SessionEvent};
use crate::cast::transport::CastTransport;
use crate::cast::{
    cast_media_type, CastConnectionState, CastDevice, CastError, CastErrorCode, CastStatus,
    PlaybackTarget,
};
use crate::models::PlaybackState;

/// 再生に必要な曲の情報 (DB から解決したもの)。
#[derive(Debug, Clone)]
pub struct TrackInfo {
    pub track_id: i64,
    pub path: String,
    pub duration_ms: u64,
    pub gain_db: Option<f64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// Coordinator が外界 (AudioPlayer / DB / API サーバー / WebView) に触れる窓口。
/// 本番は [`TauriEnv`]、テストはモックを差し込む。
pub trait CoordinatorEnv: Send + Sync {
    fn player(&self) -> &Mutex<AudioPlayer>;
    /// 曲を解決する。見つからない / パスが無い場合は Err。
    fn track(&self, track_id: i64) -> Result<TrackInfo, String>;
    /// 再生実績を DB へ反映する (preview / 閾値の判定は `apply_report` の規則どおり)。
    fn apply_report(&self, report: Option<PlayReport>);
    fn add_recent(&self, track_id: i64);
    fn preview_on(&self) -> bool;
    /// Receiver が音源を取りに来られる API サーバーの実 bind ポート。
    /// サーバー停止中 / LAN 公開 OFF なら `LAN_DISABLED`。
    fn media_port(&self) -> Result<u16, CastError>;
    /// Receiver に渡すこのマシンの IP。
    fn media_host(&self, device: SocketAddr) -> Result<IpAddr, CastError>;
    fn tickets(&self) -> &MediaTickets;
    fn transport(&self) -> Result<Arc<dyn CastTransport>, CastError>;
    fn emit_status(&self, status: &CastStatus);
}

/// 再生操作の失敗。自動送りが「この曲を飛ばして次へ」してよいかを区別する。
#[derive(Debug, Clone, PartialEq)]
pub enum PlayError {
    Local(String),
    Cast(CastError),
}

impl PlayError {
    /// 曲固有の失敗 (ファイル欠損・未対応形式・Receiver の読み込み失敗) か。
    /// 接続断などは次の曲でも同じ結果になるので飛ばさない。
    pub fn is_track_specific(&self) -> bool {
        match self {
            PlayError::Local(_) => true,
            PlayError::Cast(e) => matches!(
                e.code,
                CastErrorCode::TrackUnavailable
                    | CastErrorCode::UnsupportedFormat
                    | CastErrorCode::LoadFailed
            ),
        }
    }
}

impl From<PlayError> for String {
    fn from(e: PlayError) -> Self {
        match e {
            PlayError::Local(s) => s,
            PlayError::Cast(e) => e.to_string(),
        }
    }
}

impl From<CastError> for PlayError {
    fn from(e: CastError) -> Self {
        PlayError::Cast(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    Local,
    Cast,
}

/// いま Cast で鳴らしているアイテム。
#[derive(Debug, Clone)]
struct CurrentItem {
    session_id: u64,
    item_id: u64,
    ticket: String,
    duration_ms: u64,
}

/// まだ終わっていないアイテムのメタ情報 (実績計上用)。
#[derive(Debug, Clone)]
struct ItemMeta {
    duration_ms: u64,
    /// 切替前の再生先で聴いた分 (Local → Cast の持ち越し)。
    carry_ms: u64,
    ticket: String,
}

type ItemKey = (u64, u64);

struct Inner {
    /// 実際に操作を振り分ける先 (切替が確定するまでは旧い先のまま)。
    route: Route,
    /// UI に見せる再生先 (接続中は新しい先を出す)。
    target: PlaybackTarget,
    connection: CastConnectionState,
    last_error: Option<CastError>,
    /// route=Cast のときの端末とセッション。切断後もセッションは最後の状態の参照用に残す。
    device: Option<CastDevice>,
    session: Option<CastSession>,
    current: Option<CurrentItem>,
    /// 現在アイテムが最後まで再生された (advance_worker が取り出す)。
    finished: bool,
    items: HashMap<ItemKey, ItemMeta>,
    /// 実績を捨てるアイテム (Cast → Local / Cast → Cast の引き継ぎ)。
    suppressed: HashSet<ItemKey>,
    /// Receiver が音量を報告するまでの表示用 (最後に送った値)。
    cast_volume: Option<f32>,
}

impl Inner {
    fn new() -> Self {
        Self {
            route: Route::Local,
            target: PlaybackTarget::Local,
            connection: CastConnectionState::Idle,
            last_error: None,
            device: None,
            session: None,
            current: None,
            finished: false,
            items: HashMap::new(),
            suppressed: HashSet::new(),
            cast_volume: None,
        }
    }

    fn is_current_session(&self, session_id: u64) -> bool {
        self.session.as_ref().is_some_and(|s| s.id() == session_id)
    }
}

/// 切替時に引き継ぐ再生状態。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Handoff {
    track_id: i64,
    position_ms: u64,
    playing: bool,
}

/// Cast の状態のうち、有効再生状態の合成に使う部分。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CastView {
    pub connected: bool,
    pub playing: bool,
    pub item_tag: Option<i64>,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub volume: Option<f32>,
}

impl CastView {
    fn from_snapshot(snap: &CastMediaSnapshot, closed: bool) -> Self {
        let connected = !closed && snap.connection == CastConnectionState::Connected;
        Self {
            connected,
            playing: connected && snap.is_playing(),
            item_tag: snap.item_tag,
            position_ms: snap.position_now(),
            duration_ms: snap.duration_ms,
            volume: snap.volume,
        }
    }
}

/// `AudioPlayer` の状態 (キュー系・現在曲) に Cast の位置 / 再生中 / 音量を重ねる。
/// `cast` が None (Cast 中なのにセッションが無い = 切断後) なら停止扱い。
pub(crate) fn merge_state(
    mut local: PlaybackState,
    cast: Option<CastView>,
    cast_volume: Option<f32>,
) -> PlaybackState {
    local.is_playing = false;
    let same_item =
        cast.is_some_and(|c| c.item_tag.is_some() && c.item_tag == local.current_track_id);
    if let Some(c) = cast {
        if same_item {
            local.is_playing = c.playing;
            local.position_ms = c.position_ms;
            if c.duration_ms > 0 {
                local.duration_ms = c.duration_ms;
            }
        } else {
            local.position_ms = 0;
        }
    } else {
        local.position_ms = local.position_ms.min(local.duration_ms);
    }
    if let Some(v) = cast.and_then(|c| c.volume).or(cast_volume) {
        local.volume = v;
    }
    local
}

/// UI に出す接続状態。Connected でも Receiver が読み込み / バッファ中なら Buffering。
pub(crate) fn derive_connection(
    target: &PlaybackTarget,
    connection: CastConnectionState,
    player_state: Option<PlayerState>,
) -> CastConnectionState {
    if *target == PlaybackTarget::Local {
        return CastConnectionState::Idle;
    }
    if connection == CastConnectionState::Connected
        && matches!(
            player_state,
            Some(PlayerState::Buffering | PlayerState::Loading)
        )
    {
        return CastConnectionState::Buffering;
    }
    connection
}

fn superseded() -> CastError {
    CastError::new(
        CastErrorCode::Superseded,
        "新しい再生先の選択に置き換えられました",
    )
}

fn connection_lost() -> CastError {
    CastError::new(
        CastErrorCode::ConnectionLost,
        "Cast 端末との接続が切れています。再接続するか「このコンピューター」に戻してください",
    )
}

fn preview_active() -> CastError {
    CastError::new(
        CastErrorCode::PreviewActive,
        "試聴 (Preview) 中は Cast に切り替えられません",
    )
}

/// 再生先の切替と、再生操作の振り分けを担う。Clone して共有する (中身は Arc)。
#[derive(Clone)]
pub struct PlaybackCoordinator {
    env: Arc<dyn CoordinatorEnv>,
    inner: Arc<Mutex<Inner>>,
    generation: Arc<AtomicU64>,
    /// テスト用: 確定 (commit) の直前で止めて、競合する操作を差し込むための関門。
    #[cfg(test)]
    commit_gate: Arc<Mutex<Option<Arc<tests::CommitGate>>>>,
}

/// Local → Cast の確定を、ローカルの曲が替わったために見送った後の再試行回数。
const HANDOFF_ATTEMPTS: usize = 3;

/// 引き継ぎのために LOAD 済みのアイテム。
struct Loaded {
    handoff: Handoff,
    track: TrackInfo,
    item_id: u64,
    ticket: String,
}

/// 確定の試行結果。
enum Commit {
    /// 確定した。旧セッション (Cast → Cast) と、DB へ反映すべきローカルの実績を返す。
    Done {
        old_session: Option<CastSession>,
        report: Option<PlayReport>,
    },
    /// 新しい切替要求に置き換えられた。
    Superseded,
    /// LOAD の間にローカルの曲が替わった / 鳴り終わった。読み直して LOAD し直す。
    Moved { wait_for_advance: bool },
}

/// Cast からこのコンピューターへ戻すときの読み込み方。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LocalResume {
    pub position_ms: u64,
    pub playing: bool,
    /// Cast 側で既に実績を計上済み (接続断・アイテム終了) なので、ローカルの続きは数えない。
    pub suppress_report: bool,
}

/// Cast の最後の状態 (`tag`, 位置, 再生中, 実績計上済み) から、ローカルでの再開方法を決める。
/// Cast が別の曲を指していれば頭から一時停止。
pub(crate) fn local_resume(
    track_id: i64,
    cast: Option<(Option<i64>, u64, bool, bool)>,
) -> LocalResume {
    match cast {
        Some((tag, position_ms, playing, stats_done)) if tag == Some(track_id) => LocalResume {
            position_ms,
            playing,
            suppress_report: stats_done,
        },
        _ => LocalResume {
            position_ms: 0,
            playing: false,
            suppress_report: false,
        },
    }
}

impl PlaybackCoordinator {
    pub fn new(env: Arc<dyn CoordinatorEnv>) -> Self {
        Self {
            env,
            inner: Arc::new(Mutex::new(Inner::new())),
            generation: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            commit_gate: Arc::new(Mutex::new(None)),
        }
    }

    // ロック順: `AudioPlayer` → `Inner` の順でしか入れ子にしない
    // (Inner を握ったまま AudioPlayer を取らない)。どちらも await を跨いで握らない。
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn player(&self) -> std::sync::MutexGuard<'_, AudioPlayer> {
        self.env.player().lock().unwrap_or_else(|e| e.into_inner())
    }

    fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current_gen(&self, gen: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == gen
    }

    /// 操作を Cast に振り分ける状態か (切断後も含む)。
    pub fn is_casting(&self) -> bool {
        self.lock().route == Route::Cast
    }

    // ===== 状態 =====

    /// 有効な再生先の再生状態 (UI / Remote API / SMTC が参照する)。
    pub fn get_state(&self) -> PlaybackState {
        let local = self.player().get_state();
        let inner = self.lock();
        if inner.route == Route::Local {
            return local;
        }
        let view = inner
            .session
            .as_ref()
            .map(|s| CastView::from_snapshot(&s.snapshot(), s.is_closed()));
        merge_state(local, view, inner.cast_volume)
    }

    /// Cast 中の再生位置 (永続化用)。Local なら None。
    pub fn cast_position(&self) -> Option<u64> {
        self.is_casting().then(|| self.get_state().position_ms)
    }

    pub fn status(&self) -> CastStatus {
        let st = self.get_state();
        let inner = self.lock();
        let snap = inner.session.as_ref().map(|s| s.snapshot());
        CastStatus {
            target: inner.target.clone(),
            connection_state: derive_connection(
                &inner.target,
                inner.connection,
                snap.as_ref().map(|s| s.player_state),
            ),
            is_playing: st.is_playing,
            current_track_id: st.current_track_id,
            position_ms: st.position_ms,
            duration_ms: st.duration_ms,
            volume: st.volume,
            last_error: inner.last_error.clone(),
            last_status_at: snap.and_then(|s| s.last_status_epoch_ms),
        }
    }

    fn emit(&self) {
        self.env.emit_status(&self.status());
    }

    /// Cast の現在アイテムが最後まで再生されたか (1 回だけ true を返す)。
    pub fn take_finished(&self) -> bool {
        let mut inner = self.lock();
        if inner.route == Route::Cast && inner.finished {
            inner.finished = false;
            return true;
        }
        false
    }

    // ===== 再生操作 =====

    /// 曲を再生する。Local なら従来どおり AudioPlayer、Cast なら Receiver へ LOAD する。
    ///
    /// Local か Cast かは `AudioPlayer` の外部出力モードを **同じロックの下で** 見て決める。
    /// Local → Cast の確定 (`set_external_current`) もこのロックの下で行うので、確定の前後で
    /// ローカルの sink が作られて PC と Cast の両方から鳴ることはない。
    pub async fn play_track(&self, track_id: i64, preview: bool) -> Result<(), PlayError> {
        if !self.is_casting() {
            let t = self.env.track(track_id).map_err(PlayError::Local)?;
            if let Some(result) = self.try_play_local(&t, preview) {
                let report = result.map_err(PlayError::Local)?;
                self.env.apply_report(report);
                if !preview {
                    self.env.add_recent(track_id);
                }
                return Ok(());
            }
            // 確認の後に Cast へ切り替わっていた。Cast で鳴らす。
        }
        if preview {
            return Err(preview_active().into());
        }
        self.cast_play(track_id, 0, true).await?;
        Ok(())
    }

    /// 外部出力モードでなければローカルで鳴らす。モード判定と再生を同じロックの下で
    /// 行う。外部出力モードなら None (呼び出し側が Cast へ振り替える)。
    fn try_play_local(
        &self,
        t: &TrackInfo,
        preview: bool,
    ) -> Option<Result<Option<PlayReport>, String>> {
        let mut p = self.player();
        (!p.is_external()).then(|| p.play(&t.path, t.track_id, t.duration_ms, t.gain_db, preview))
    }

    /// Cast 中に曲を LOAD して現在アイテムにする。
    async fn cast_play(
        &self,
        track_id: i64,
        start_ms: u64,
        autoplay: bool,
    ) -> Result<(), CastError> {
        let (session, device) = {
            let inner = self.lock();
            match (&inner.session, &inner.device) {
                (Some(s), Some(d)) if !s.is_closed() => (s.clone(), d.clone()),
                _ => return Err(connection_lost()),
            }
        };
        let result = async {
            let track = self.resolve_castable(track_id)?;
            let (item_id, ticket) = self
                .cast_load(&session, &device, &track, start_ms, autoplay)
                .await?;
            Ok::<_, CastError>((track, item_id, ticket))
        }
        .await;
        let (track, item_id, ticket) = match result {
            Ok(v) => v,
            Err(e) => {
                if e.code != CastErrorCode::Superseded {
                    self.lock().last_error = Some(e.clone());
                    self.emit();
                }
                return Err(e);
            }
        };
        let key = (session.id(), item_id);
        {
            let mut inner = self.lock();
            if !inner.is_current_session(session.id()) {
                // LOAD 中に再生先が替わった。このアイテムは引き継がない。
                inner.suppressed.insert(key);
                drop(inner);
                self.env.tickets().revoke(&ticket);
                return Err(superseded());
            }
            inner.items.insert(
                key,
                ItemMeta {
                    duration_ms: track.duration_ms,
                    carry_ms: 0,
                    ticket: ticket.clone(),
                },
            );
            inner.current = Some(CurrentItem {
                session_id: session.id(),
                item_id,
                ticket,
                duration_ms: track.duration_ms,
            });
            inner.finished = false;
            inner.last_error = None;
        }
        // Cast 中の AudioPlayer は sink を持たない (実績 0) ので、前の曲の report は捨てる。
        // 前の曲の実績は ItemEnded(Replaced) で反映される。
        let _ = self
            .player()
            .set_external_current(track_id, track.duration_ms);
        self.env.add_recent(track_id);
        self.emit();
        Ok(())
    }

    /// 曲を解決し、Cast に渡せるか (ファイル有無・形式・LAN 公開) を確かめる。
    fn resolve_castable(&self, track_id: i64) -> Result<TrackInfo, CastError> {
        let track = self
            .env
            .track(track_id)
            .map_err(|e| CastError::new(CastErrorCode::TrackUnavailable, e))?;
        if !Path::new(&track.path).exists() {
            return Err(CastError::new(
                CastErrorCode::TrackUnavailable,
                "音源ファイルが見つかりません",
            ));
        }
        cast_media_type(Path::new(&track.path))?;
        self.env.media_port()?;
        Ok(track)
    }

    /// チケットを発行して LOAD する。失敗したらチケットは失効させる。
    async fn cast_load(
        &self,
        session: &CastSession,
        device: &CastDevice,
        track: &TrackInfo,
        start_ms: u64,
        autoplay: bool,
    ) -> Result<(u64, String), CastError> {
        let content_type = cast_media_type(Path::new(&track.path))?;
        let port = self.env.media_port()?;
        let addr = device.socket_addr().ok_or_else(|| {
            CastError::new(CastErrorCode::DeviceNotFound, "端末のアドレスが不正です")
        })?;
        let host = match self.env.media_host(addr)? {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => format!("[{v6}]"),
        };
        let tickets = self.env.tickets();
        let ticket = tickets.issue(track.track_id, session.id(), track.duration_ms);
        let req = LoadRequest {
            content_id: format!("http://{host}:{port}/api/cast/media/{ticket}"),
            content_type: content_type.to_string(),
            duration_ms: (track.duration_ms > 0).then_some(track.duration_ms),
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            start_ms,
            autoplay,
        };
        match session.load(req, track.track_id).await {
            Ok(item_id) => Ok((item_id, ticket)),
            Err(e) => {
                tickets.revoke(&ticket);
                Err(e)
            }
        }
    }

    /// Cast 中に使うセッション。切断済みなら CONNECTION_LOST。
    fn live_session(&self) -> Result<Option<CastSession>, CastError> {
        let inner = self.lock();
        if inner.route == Route::Local {
            return Ok(None);
        }
        match &inner.session {
            Some(s) if !s.is_closed() => Ok(Some(s.clone())),
            _ => Err(connection_lost()),
        }
    }

    pub async fn pause(&self) -> Result<(), PlayError> {
        match self.live_session()? {
            None => self.player().pause(),
            Some(s) => s.pause().await?,
        }
        Ok(())
    }

    pub async fn resume(&self) -> Result<(), PlayError> {
        let Some(session) = self.live_session()? else {
            self.player().resume();
            return Ok(());
        };
        let snap = session.snapshot();
        let track = self.player().get_state().current_track_id;
        // Receiver 側で止められた (TV リモコンの停止・再生エラー等) 後は、同じ曲を
        // 最後の位置から読み込み直して再開する。
        let media_gone = snap.item_ended || snap.media_session_id.is_none();
        match track {
            Some(tid) if media_gone => {
                let pos = if snap.item_tag == Some(tid) {
                    snap.position_now()
                } else {
                    0
                };
                self.cast_play(tid, pos, true).await?;
            }
            _ => session.play().await?,
        }
        Ok(())
    }

    pub async fn seek(&self, position_ms: u64) -> Result<(), PlayError> {
        match self.live_session()? {
            None => self.player().seek(position_ms),
            Some(s) => s.seek(position_ms).await?,
        }
        Ok(())
    }

    /// 音量。Local は AudioPlayer (ユーザーのローカル音量)、Cast は Receiver の音量で、
    /// 互いに独立している (Cast から戻るとローカルの音量に戻る)。
    pub async fn set_volume(&self, volume: f32) -> Result<(), PlayError> {
        let volume = volume.clamp(0.0, 1.0);
        match self.live_session()? {
            None => self.player().set_volume(volume),
            Some(s) => {
                s.set_volume(volume).await?;
                self.lock().cast_volume = Some(volume);
            }
        }
        Ok(())
    }

    /// 停止する。Local は実績をここで反映し、Cast は `ItemEnded(Stopped)` で反映される。
    /// Cast が切断済みでも AudioPlayer 側の「現在曲」は片付ける。
    pub async fn stop(&self) -> Result<(), PlayError> {
        let session = {
            let inner = self.lock();
            match inner.route {
                Route::Local => None,
                Route::Cast => Some(inner.session.clone()),
            }
        };
        match session {
            None => {
                let report = self.player().stop();
                self.env.apply_report(report);
            }
            Some(session) => {
                // Cast への STOP はベストエフォート。接続断で失敗しても手元の状態は片付ける。
                let sent = match session.filter(|s| !s.is_closed()) {
                    Some(s) => s.stop().await,
                    None => Ok(()),
                };
                // 外部出力中の AudioPlayer は sink が無く実績 0 なので捨てる。
                self.player().stop();
                {
                    let mut inner = self.lock();
                    inner.current = None;
                    inner.finished = false;
                }
                self.emit();
                sent?;
            }
        }
        Ok(())
    }

    // ===== 再生先の切替 =====

    /// いまの再生先で鳴っている (読み込まれている) 曲と位置。
    fn handoff_source(&self) -> Option<Handoff> {
        let local = self.player().get_state();
        let track_id = local.current_track_id?;
        let inner = self.lock();
        match (inner.route, &inner.session) {
            (Route::Cast, Some(s)) => {
                let snap = s.snapshot();
                let same = snap.item_tag == Some(track_id);
                Some(Handoff {
                    track_id,
                    position_ms: if same { snap.position_now() } else { 0 },
                    playing: same
                        && !s.is_closed()
                        && snap.connection == CastConnectionState::Connected
                        && snap.is_playing(),
                })
            }
            (Route::Cast, None) => Some(Handoff {
                track_id,
                position_ms: 0,
                playing: false,
            }),
            (Route::Local, _) => Some(Handoff {
                track_id,
                position_ms: local.position_ms,
                playing: local.is_playing,
            }),
        }
    }

    /// Google Cast 端末へ切り替える (Local → Cast / Cast → 別の Cast)。
    /// 途中で失敗したら元の再生先のまま。新しい切替要求が来たら `SUPERSEDED`。
    pub async fn connect_cast(&self, device: CastDevice) -> Result<CastStatus, CastError> {
        let gen = self.bump_generation();
        if self.env.preview_on() {
            return Err(preview_active());
        }
        {
            let inner = self.lock();
            let same_device = inner.device.as_ref().is_some_and(|d| d.id == device.id);
            let alive = inner.session.as_ref().is_some_and(|s| !s.is_closed());
            if inner.route == Route::Cast && same_device && alive {
                drop(inner);
                return Ok(self.status());
            }
        }
        // 先に検証できるものは接続前に断る (LAN 公開・現在曲の形式)。
        let precheck = self
            .env
            .media_port()
            .and_then(|_| match self.handoff_source() {
                Some(h) => self.resolve_castable(h.track_id).map(|_| ()),
                None => Ok(()),
            });
        if let Err(e) = precheck {
            self.fail_switch(gen, None, e.clone());
            return Err(e);
        }

        let previous = {
            let mut inner = self.lock();
            let prev = (
                inner.target.clone(),
                inner.connection,
                inner.last_error.clone(),
            );
            inner.target = PlaybackTarget::GoogleCast {
                device_id: device.id.clone(),
                device_name: device.name.clone(),
            };
            inner.connection = CastConnectionState::Connecting;
            inner.last_error = None;
            prev
        };
        self.emit();

        match self.connect_and_commit(gen, device).await {
            Ok(()) => Ok(self.status()),
            Err(e) => {
                self.fail_switch(gen, Some(previous), e.clone());
                Err(e)
            }
        }
    }

    /// 切替失敗時に表示を元へ戻し、エラーを残す (新しい要求に置き換えられていれば何もしない)。
    fn fail_switch(
        &self,
        gen: u64,
        previous: Option<(PlaybackTarget, CastConnectionState, Option<CastError>)>,
        error: CastError,
    ) {
        if !self.is_current_gen(gen) || error.code == CastErrorCode::Superseded {
            return;
        }
        {
            let mut inner = self.lock();
            if let Some((target, connection, _)) = previous {
                inner.target = target;
                inner.connection = connection;
            }
            inner.last_error = Some(error);
        }
        self.emit();
    }

    async fn connect_and_commit(&self, gen: u64, device: CastDevice) -> Result<(), CastError> {
        let transport = self.env.transport()?;
        let (tx, rx) = mpsc::unbounded_channel();
        let session = CastSession::connect(device.clone(), transport, tx).await?;
        tokio::spawn(self.clone().pump(session.id(), rx));
        if !self.is_current_gen(gen) {
            session.disconnect(true).await;
            return Err(superseded());
        }

        // 引き継ぐ曲を LOAD してから、ロックの下で「まだその曲か」を確かめて確定する。
        // LOAD の間にローカルで曲が替わった (自動送り・ユーザー操作) ら、新しい曲で
        // LOAD し直す (newest wins、曲の取りこぼし無し)。
        for _ in 0..HANDOFF_ATTEMPTS {
            let loaded = match self.handoff_source() {
                None => None,
                Some(h) => match self.load_handoff(&session, &device, h).await {
                    Ok(l) => Some(l),
                    Err(e) => {
                        session.disconnect(true).await;
                        return Err(e);
                    }
                },
            };
            #[cfg(test)]
            self.wait_commit_gate().await;
            match self.try_commit(gen, &session, &device, loaded) {
                Commit::Done {
                    old_session,
                    report,
                } => {
                    self.env.apply_report(report);
                    if let Some(old) = old_session {
                        self.env.tickets().revoke_session(old.id());
                        tokio::spawn(async move { old.disconnect(true).await });
                    }
                    self.emit();
                    return Ok(());
                }
                Commit::Superseded => {
                    session.disconnect(true).await;
                    return Err(superseded());
                }
                Commit::Moved { wait_for_advance } => {
                    if wait_for_advance {
                        // advance_worker (100ms 周期) が次の曲へ送るのを待ってから読み直す。
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                }
            }
        }
        session.disconnect(true).await;
        Err(superseded())
    }

    async fn load_handoff(
        &self,
        session: &CastSession,
        device: &CastDevice,
        h: Handoff,
    ) -> Result<Loaded, CastError> {
        let track = self.resolve_castable(h.track_id)?;
        let (item_id, ticket) = self
            .cast_load(session, device, &track, h.position_ms, h.playing)
            .await?;
        Ok(Loaded {
            handoff: h,
            track,
            item_id,
            ticket,
        })
    }

    #[cfg(test)]
    async fn wait_commit_gate(&self) {
        let gate = self.commit_gate.lock().unwrap().clone();
        if let Some(g) = gate {
            g.reached.notify_one();
            g.proceed.notified().await;
        }
    }

    /// 確定する。`AudioPlayer` → `Inner` の順で両方のロックを握ったまま、世代番号と
    /// ローカルの現在曲を確かめてから再生先を切り替える (間に割り込まれない)。
    fn try_commit(
        &self,
        gen: u64,
        session: &CastSession,
        device: &CastDevice,
        loaded: Option<Loaded>,
    ) -> Commit {
        let mut p = self.player();
        let mut inner = self.lock();
        let key = loaded.as_ref().map(|l| (session.id(), l.item_id));
        let abandon = |inner: &mut Inner| {
            if let Some(k) = key {
                inner.suppressed.insert(k);
            }
            if let Some(l) = &loaded {
                self.env.tickets().revoke(&l.ticket);
            }
        };
        if !self.is_current_gen(gen) {
            abandon(&mut inner);
            return Commit::Superseded;
        }
        let expected = loaded.as_ref().map(|l| l.handoff.track_id);
        if p.get_state().current_track_id != expected {
            abandon(&mut inner);
            return Commit::Moved {
                wait_for_advance: false,
            };
        }
        if inner.route == Route::Local && p.finish_pending() {
            // ローカルの曲が鳴り終わり、自動送りを待っている。ここで sink を外すと送りが
            // 起きなくなるので、送られた後の曲で LOAD し直す。
            abandon(&mut inner);
            return Commit::Moved {
                wait_for_advance: true,
            };
        }

        // --- 確定: ここで初めて旧い再生先を止める ---
        let old_session = inner.session.take();
        // Cast → Cast: 旧アイテムの実績は捨てて新アイテムへ持ち越す。
        let mut carry = None;
        if let (Some(old), Some(cur)) = (&old_session, inner.current.take()) {
            let old_key = (cur.session_id, cur.item_id);
            let snap = old.snapshot();
            if !snap.item_ended {
                inner.suppressed.insert(old_key);
                let prior = inner.items.get(&old_key).map(|m| m.carry_ms).unwrap_or(0);
                carry = Some(prior + snap.played_ms());
            }
        }
        // ローカルの sink を止めて外部出力モードへ。同じ曲で試聴でなければ、その実績は
        // Cast アイテムへ持ち越す (試聴の実績は apply_report 側で捨てられる)。
        // Cast → Cast では AudioPlayer は既に外部出力 (sink 無し・実績 0) なので捨てる。
        let was_external = p.is_external();
        let mut report = match &loaded {
            Some(l) => p.set_external_current(l.track.track_id, l.track.duration_ms),
            None => p.enter_external(),
        }
        .filter(|_| !was_external);
        if let (Some(l), Some(r)) = (&loaded, &report) {
            if carry.is_none() && r.track_id == l.handoff.track_id && !r.preview {
                carry = Some(r.played_ms);
                report = None;
            }
        }
        drop(p);

        inner.route = Route::Cast;
        inner.target = PlaybackTarget::GoogleCast {
            device_id: device.id.clone(),
            device_name: device.name.clone(),
        };
        inner.connection = CastConnectionState::Connected;
        inner.last_error = None;
        inner.device = Some(device.clone());
        inner.session = Some(session.clone());
        inner.finished = false;
        inner.cast_volume = None;
        if let Some(l) = loaded {
            inner.items.insert(
                (session.id(), l.item_id),
                ItemMeta {
                    duration_ms: l.track.duration_ms,
                    carry_ms: carry.unwrap_or(0),
                    ticket: l.ticket.clone(),
                },
            );
            inner.current = Some(CurrentItem {
                session_id: session.id(),
                item_id: l.item_id,
                ticket: l.ticket,
                duration_ms: l.track.duration_ms,
            });
        }
        Commit::Done {
            old_session,
            report,
        }
    }

    /// このコンピューターへ戻す。`force_paused` なら Cast が再生中でも一時停止で引き継ぐ
    /// (「切断」操作)。接続断の後は常に一時停止で読み込む (勝手に音を出さない)。
    pub async fn switch_to_local(&self, force_paused: bool) -> Result<CastStatus, String> {
        self.bump_generation();
        let taken = {
            // 再生先と外部出力モードを同じロックの下で戻す (play_track との競合を避ける)。
            let mut p = self.player();
            let mut inner = self.lock();
            let was_cast = inner.route == Route::Cast;
            inner.route = Route::Local;
            inner.target = PlaybackTarget::Local;
            inner.connection = CastConnectionState::Idle;
            inner.last_error = None;
            inner.device = None;
            inner.finished = false;
            inner.cast_volume = None;
            let session = inner.session.take();
            let current = inner.current.take();
            if !was_cast {
                None
            } else {
                p.leave_external();
                let track = p.get_state().current_track_id;
                let cast = session.as_ref().map(|s| {
                    let snap = s.snapshot();
                    let closed = s.is_closed();
                    // 既に Cast 側で実績を計上済みか (アイテム終了 / セッション終了)。
                    let stats_done = snap.item_ended || closed;
                    if let Some(cur) = &current {
                        if !stats_done {
                            inner.suppressed.insert((cur.session_id, cur.item_id));
                        }
                    }
                    let playing = !force_paused
                        && !closed
                        && snap.connection == CastConnectionState::Connected
                        && snap.is_playing();
                    (snap.item_tag, snap.position_now(), playing, stats_done)
                });
                Some((session, track.map(|tid| (tid, local_resume(tid, cast)))))
            }
        };

        if let Some((session, resume)) = taken {
            if let Some(s) = session {
                self.env.tickets().revoke_session(s.id());
                tokio::spawn(async move { s.disconnect(true).await });
            }
            if let Some((tid, plan)) = resume {
                if let Err(e) = self.load_local(tid, plan) {
                    self.emit();
                    return Err(e);
                }
            }
        }
        self.emit();
        Ok(self.status())
    }

    /// Cast から引き継いだ曲をローカルに読み込む。切替の後にユーザーが別の曲を
    /// 鳴らし始めていたら (sink がある / 曲が違う) 何もしない。
    fn load_local(&self, track_id: i64, plan: LocalResume) -> Result<(), String> {
        let t = self.env.track(track_id)?;
        let mut p = self.player();
        if p.has_local_sink() || p.get_state().current_track_id != Some(track_id) {
            return Ok(());
        }
        p.load_paused(
            &t.path,
            track_id,
            t.duration_ms,
            t.gain_db,
            plan.position_ms,
        )?;
        if plan.suppress_report {
            p.suppress_next_report();
        }
        if plan.playing {
            p.resume();
        }
        Ok(())
    }

    /// API サーバーの停止 / LAN 公開 OFF に追従する。Cast 中ならセッションとチケットを畳み、
    /// 再生先は Cast のまま「切断」表示にする (ローカルでは鳴らさない)。
    pub async fn on_media_server_changed(&self) {
        let Err(e) = self.env.media_port() else {
            return;
        };
        let session = {
            let mut inner = self.lock();
            if inner.route != Route::Cast {
                return;
            }
            inner.connection = CastConnectionState::Disconnected;
            inner.last_error = Some(CastError::new(
                CastErrorCode::LanDisabled,
                format!("{} そのため Cast を切断しました", e.message),
            ));
            inner.session.clone()
        };
        if let Some(s) = session {
            self.env.tickets().revoke_session(s.id());
            s.disconnect(true).await;
        }
        self.emit();
    }

    /// アプリ終了時: チケットを全失効させ、Cast を切断する (ベストエフォート)。
    pub async fn shutdown(&self) {
        self.env.tickets().revoke_all();
        let session = self.lock().session.take();
        if let Some(s) = session {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), s.disconnect(true)).await;
        }
    }

    // ===== セッションイベント =====

    async fn pump(self, session_id: u64, mut rx: mpsc::UnboundedReceiver<SessionEvent>) {
        while let Some(ev) = rx.recv().await {
            self.on_event(session_id, ev);
        }
    }

    fn on_event(&self, session_id: u64, ev: SessionEvent) {
        match ev {
            SessionEvent::Status(snap) => {
                let mut inner = self.lock();
                if !inner.is_current_session(session_id) {
                    return;
                }
                if inner.connection != CastConnectionState::Connecting {
                    inner.connection = match snap.connection {
                        CastConnectionState::Reconnecting => CastConnectionState::Reconnecting,
                        CastConnectionState::Disconnected => CastConnectionState::Disconnected,
                        _ => CastConnectionState::Connected,
                    };
                }
                if snap.volume.is_some() {
                    inner.cast_volume = snap.volume;
                }
                // 再生が続いている間はチケットを延長する。
                if snap.is_playing() {
                    if let Some(cur) = &inner.current {
                        self.env.tickets().extend(&cur.ticket, cur.duration_ms);
                    }
                }
            }
            SessionEvent::ItemEnded {
                item_id,
                tag,
                played_ms,
                reason,
            } => {
                let key = (session_id, item_id);
                let (meta, suppressed) = {
                    let mut inner = self.lock();
                    let meta = inner.items.remove(&key);
                    let suppressed = inner.suppressed.remove(&key);
                    let is_current = inner
                        .current
                        .as_ref()
                        .is_some_and(|c| (c.session_id, c.item_id) == key);
                    if is_current {
                        match reason {
                            EndReason::Finished => inner.finished = true,
                            EndReason::Error => {
                                inner.last_error = Some(CastError::new(
                                    CastErrorCode::LoadFailed,
                                    "Cast 端末が再生エラーを報告しました (形式や音源 URL に到達できるか確認してください)",
                                ));
                            }
                            _ => {}
                        }
                    }
                    (meta, suppressed)
                };
                if let Some(m) = &meta {
                    self.env.tickets().revoke(&m.ticket);
                }
                if !suppressed {
                    let duration_ms = match &meta {
                        Some(m) => m.duration_ms,
                        None => self.env.track(tag).map(|t| t.duration_ms).unwrap_or(0),
                    };
                    self.env.apply_report(Some(PlayReport {
                        track_id: tag,
                        played_ms: played_ms + meta.as_ref().map(|m| m.carry_ms).unwrap_or(0),
                        duration_ms,
                        preview: false,
                    }));
                }
            }
            SessionEvent::Closed { reason } => {
                self.env.tickets().revoke_session(session_id);
                let mut inner = self.lock();
                inner.suppressed.retain(|(sid, _)| *sid != session_id);
                inner.items.retain(|(sid, _), _| *sid != session_id);
                if !inner.is_current_session(session_id) {
                    return;
                }
                inner.connection = CastConnectionState::Disconnected;
                if inner.last_error.is_none() {
                    inner.last_error = Some(CastError::new(CastErrorCode::ConnectionLost, reason));
                }
            }
        }
        self.emit();
    }
}

// ===== 本番環境 (Tauri) =====

/// `AppHandle` 経由で managed state / DB / イベントに触れる本番の環境。
pub struct TauriEnv {
    app: tauri::AppHandle,
}

impl TauriEnv {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl CoordinatorEnv for TauriEnv {
    fn player(&self) -> &Mutex<AudioPlayer> {
        use tauri::Manager;
        self.app.state::<Mutex<AudioPlayer>>().inner()
    }

    fn track(&self, track_id: i64) -> Result<TrackInfo, String> {
        let db = crate::commands::library::open_db(&self.app)?;
        let track = db
            .get_track_by_track_id(track_id)
            .map_err(|e| e.to_string())?
            .ok_or("Track not found")?;
        let path = track
            .location_path
            .clone()
            .filter(|p| !p.is_empty())
            .ok_or("No file path for this track")?;
        let gain_db = db
            .get_analysis(track_id)
            .ok()
            .flatten()
            .and_then(|a| a.replaygain_db);
        Ok(TrackInfo {
            track_id,
            path,
            duration_ms: track.total_time_ms.unwrap_or(0).max(0) as u64,
            gain_db,
            title: track.name,
            artist: track.artist,
            album: track.album,
        })
    }

    fn apply_report(&self, report: Option<PlayReport>) {
        if report.is_none() {
            return;
        }
        if let Ok(db) = crate::commands::library::open_db(&self.app) {
            crate::commands::playback::apply_report(&db, report);
        }
    }

    fn add_recent(&self, track_id: i64) {
        if let Ok(db) = crate::commands::library::open_db(&self.app) {
            let _ = db.add_recent_track(track_id);
        }
    }

    fn preview_on(&self) -> bool {
        use tauri::Manager;
        self.app
            .state::<crate::commands::playback::PreviewMode>()
            .get()
    }

    fn media_port(&self) -> Result<u16, CastError> {
        use tauri::Manager;
        let server = self.app.state::<Mutex<Option<crate::api::ServerControl>>>();
        let guard = server.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(c) if c.addr.ip().is_unspecified() => Ok(c.addr.port()),
            Some(_) => Err(CastError::new(
                CastErrorCode::LanDisabled,
                "API サーバーの LAN 公開が無効です。",
            )),
            None => Err(CastError::new(
                CastErrorCode::LanDisabled,
                "API サーバーが停止しています。",
            )),
        }
    }

    fn media_host(&self, device: SocketAddr) -> Result<IpAddr, CastError> {
        crate::cast::local_ip_for(device)
    }

    fn tickets(&self) -> &MediaTickets {
        use tauri::Manager;
        self.app.state::<MediaTickets>().inner()
    }

    fn transport(&self) -> Result<Arc<dyn CastTransport>, CastError> {
        crate::cast::transport::TlsTransport::new()
            .map(|t| Arc::new(t) as Arc<dyn CastTransport>)
            .map_err(|e| CastError::new(CastErrorCode::Internal, e))
    }

    fn emit_status(&self, status: &CastStatus) {
        use tauri::Emitter;
        let _ = self.app.emit("cast-state-changed", status);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::RepeatMode;
    use crate::cast::proto::CastMessage;
    use crate::cast::protocol::{NS_MEDIA, NS_RECEIVER, RECEIVER_ID};
    use crate::cast::transport::{MockDevice, MockTransport};
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::time::Duration;

    const TID: &str = "web-7";

    /// 確定の直前で止めるための関門 (`PlaybackCoordinator::commit_gate`)。
    #[derive(Default)]
    pub(super) struct CommitGate {
        pub reached: tokio::sync::Notify,
        pub proceed: tokio::sync::Notify,
    }

    struct TestEnv {
        player: Mutex<AudioPlayer>,
        tracks: HashMap<i64, TrackInfo>,
        reports: Mutex<Vec<PlayReport>>,
        preview: AtomicBool,
        lan: AtomicBool,
        tickets: MediaTickets,
        transport: Arc<MockTransport>,
        emits: AtomicUsize,
        _dir: tempfile::TempDir,
    }

    impl CoordinatorEnv for TestEnv {
        fn player(&self) -> &Mutex<AudioPlayer> {
            &self.player
        }
        fn track(&self, track_id: i64) -> Result<TrackInfo, String> {
            self.tracks
                .get(&track_id)
                .cloned()
                .ok_or_else(|| "Track not found".to_string())
        }
        fn apply_report(&self, report: Option<PlayReport>) {
            if let Some(r) = report {
                self.reports.lock().unwrap().push(r);
            }
        }
        fn add_recent(&self, _track_id: i64) {}
        fn preview_on(&self) -> bool {
            self.preview.load(Ordering::SeqCst)
        }
        fn media_port(&self) -> Result<u16, CastError> {
            if self.lan.load(Ordering::SeqCst) {
                Ok(8787)
            } else {
                Err(CastError::new(CastErrorCode::LanDisabled, "LAN off"))
            }
        }
        fn media_host(&self, _device: SocketAddr) -> Result<IpAddr, CastError> {
            Ok("192.168.1.2".parse().unwrap())
        }
        fn tickets(&self) -> &MediaTickets {
            &self.tickets
        }
        fn transport(&self) -> Result<Arc<dyn CastTransport>, CastError> {
            Ok(self.transport.clone())
        }
        fn emit_status(&self, _status: &CastStatus) {
            self.emits.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn track(dir: &Path, id: i64, file: &str) -> (i64, TrackInfo) {
        let path = dir.join(file);
        std::fs::write(&path, b"").unwrap();
        (
            id,
            TrackInfo {
                track_id: id,
                path: path.to_string_lossy().into_owned(),
                duration_ms: 180_000,
                gain_db: None,
                title: Some(format!("t{id}")),
                artist: None,
                album: None,
            },
        )
    }

    fn setup() -> (
        PlaybackCoordinator,
        Arc<TestEnv>,
        mpsc::UnboundedReceiver<MockDevice>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let tracks = HashMap::from([
            track(dir.path(), 1, "a.mp3"),
            track(dir.path(), 2, "b.mp3"),
            track(dir.path(), 3, "c.flac"),
        ]);
        let (transport, devices) = MockTransport::new();
        let env = Arc::new(TestEnv {
            player: Mutex::new(AudioPlayer::new()),
            tracks,
            reports: Mutex::new(Vec::new()),
            preview: AtomicBool::new(false),
            lan: AtomicBool::new(true),
            tickets: MediaTickets::default(),
            transport: Arc::new(transport),
            emits: AtomicUsize::new(0),
            _dir: dir,
        });
        let coord = PlaybackCoordinator::new(env.clone());
        (coord, env, devices)
    }

    fn device() -> CastDevice {
        CastDevice {
            id: "dev-1".into(),
            name: "Living TV".into(),
            model: None,
            host: "192.168.1.9".into(),
            port: 8009,
        }
    }

    fn device_b() -> CastDevice {
        CastDevice {
            id: "dev-2".into(),
            name: "Kitchen Speaker".into(),
            model: None,
            host: "192.168.1.10".into(),
            port: 8009,
        }
    }

    fn fake_local(env: &TestEnv, id: i64, position_ms: u64) {
        let path = env.tracks[&id].path.clone();
        env.player
            .lock()
            .unwrap()
            .fake_loaded(id, &path, 180_000, position_ms);
    }

    /// テスト側から見た Cast 端末。
    struct Fake {
        dev: MockDevice,
    }

    impl Fake {
        /// heartbeat / 仮想接続以外で次に来た Sender のメッセージ。
        async fn next(&mut self) -> Value {
            loop {
                let m = self.dev.from_sender.recv().await.expect("sender closed");
                let v: Value = serde_json::from_str(&m.payload_utf8).unwrap();
                if matches!(
                    v["type"].as_str(),
                    Some("PING" | "PONG" | "CONNECT" | "CLOSE")
                ) {
                    continue;
                }
                return v;
            }
        }

        async fn expect(&mut self, ty: &str) -> Value {
            let v = self.next().await;
            assert_eq!(v["type"], ty, "unexpected message: {v}");
            v
        }

        fn send(&self, ns: &str, src: &str, v: Value) {
            let _ = self.dev.to_sender.send(CastMessage {
                source_id: src.into(),
                destination_id: "sender-0".into(),
                namespace: ns.into(),
                payload_utf8: v.to_string(),
                payload_binary: None,
            });
        }

        fn media(&self, rid: u64, msid: i64, state: &str, extra: Value) {
            let mut e = json!({ "mediaSessionId": msid, "playerState": state, "currentTime": 0.0,
                "media": { "contentId": "x", "duration": 180.0 } });
            if let (Some(e), Some(x)) = (e.as_object_mut(), extra.as_object()) {
                for (k, v) in x {
                    e.insert(k.clone(), v.clone());
                }
            }
            self.send(
                NS_MEDIA,
                TID,
                json!({ "type": "MEDIA_STATUS", "requestId": rid, "status": [e] }),
            );
        }

        /// LOAD を受けて `state` で応答し、LOAD の内容を返す。
        async fn answer_load(&mut self, msid: i64, state: &str) -> Value {
            let load = self.expect("LOAD").await;
            let rid = load["requestId"].as_u64().unwrap();
            let at = load["currentTime"].clone();
            self.media(rid, msid, state, json!({ "currentTime": at }));
            load
        }
    }

    /// `connect_cast` を走らせ、LAUNCH に応答したところまで進める。
    async fn start_connect(
        coord: &PlaybackCoordinator,
        devices: &mut mpsc::UnboundedReceiver<MockDevice>,
    ) -> (tokio::task::JoinHandle<Result<CastStatus, CastError>>, Fake) {
        start_connect_to(coord, devices, device()).await
    }

    async fn start_connect_to(
        coord: &PlaybackCoordinator,
        devices: &mut mpsc::UnboundedReceiver<MockDevice>,
        dev: CastDevice,
    ) -> (tokio::task::JoinHandle<Result<CastStatus, CastError>>, Fake) {
        let c = coord.clone();
        let task = tokio::spawn(async move { c.connect_cast(dev).await });
        let mut fake = Fake {
            dev: devices.recv().await.unwrap(),
        };
        let launch = fake.expect("LAUNCH").await;
        fake.send(
            NS_RECEIVER,
            RECEIVER_ID,
            json!({ "type": "RECEIVER_STATUS", "requestId": launch["requestId"], "status": {
                "applications": [{ "appId": "CC1AD845", "sessionId": "s1", "transportId": TID }],
                "volume": { "level": 0.4, "muted": false }
            }}),
        );
        (task, fake)
    }

    fn ticket_of(load: &Value) -> String {
        let url = load["media"]["contentId"].as_str().unwrap();
        assert!(
            url.starts_with("http://192.168.1.2:8787/api/cast/media/"),
            "{url}"
        );
        url.rsplit('/').next().unwrap().to_string()
    }

    /// 非同期のイベント処理 (pump) を待つ。
    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn local_to_cast_stops_local_only_after_load_succeeds() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 30_000);

        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        let load = fake.expect("LOAD").await;
        assert_eq!(load["currentTime"], json!(30.0));
        assert_eq!(load["autoplay"], json!(false));
        assert_eq!(load["media"]["contentType"], "audio/mpeg");
        let ticket = ticket_of(&load);
        assert_eq!(env.tickets.validate(&ticket), Some(1));

        // LOAD の応答前: ローカルはまだ止めていない (失敗したら元のまま再生を続けるため)。
        assert!(env.player.lock().unwrap().current_path().is_some());
        assert!(!coord.is_casting());
        let st = coord.status();
        assert_eq!(st.connection_state, CastConnectionState::Connecting);
        assert!(matches!(st.target, PlaybackTarget::GoogleCast { .. }));

        let rid = load["requestId"].as_u64().unwrap();
        fake.media(rid, 1, "PAUSED", json!({ "currentTime": 30.0 }));
        let st = task.await.unwrap().unwrap();
        assert_eq!(st.connection_state, CastConnectionState::Connected);
        assert!(coord.is_casting());
        {
            let mut p = env.player.lock().unwrap();
            assert!(p.current_path().is_none(), "local sink must be released");
            assert_eq!(p.get_state().current_track_id, Some(1));
            // ローカルの advance_worker は Cast 中に独自に曲を進めない。
            assert!(!p.is_finished());
        }
        assert_eq!(coord.get_state().position_ms, 30_000);
        assert_eq!(coord.get_state().volume, 0.4);
    }

    #[tokio::test(start_paused = true)]
    async fn load_failure_keeps_local_and_reports_error() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 5_000);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        let load = fake.expect("LOAD").await;
        let ticket = ticket_of(&load);
        fake.send(
            NS_MEDIA,
            TID,
            json!({ "type": "LOAD_FAILED", "requestId": load["requestId"] }),
        );
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, CastErrorCode::LoadFailed);
        assert!(!coord.is_casting());
        assert_eq!(
            env.player.lock().unwrap().current_path().map(|_| ()),
            Some(())
        );
        let st = coord.status();
        assert_eq!(st.target, PlaybackTarget::Local);
        assert_eq!(st.connection_state, CastConnectionState::Idle);
        assert_eq!(st.last_error.unwrap().code, CastErrorCode::LoadFailed);
        assert_eq!(env.tickets.validate(&ticket), None);
    }

    #[tokio::test(start_paused = true)]
    async fn cast_finish_signals_advance_once_with_carried_stats() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 30_000);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();
        assert!(coord.get_state().is_playing);

        tokio::time::advance(Duration::from_secs(10)).await;
        fake.media(0, 1, "IDLE", json!({ "idleReason": "FINISHED" }));
        settle().await;

        assert!(coord.take_finished());
        assert!(!coord.take_finished(), "finish is consumed exactly once");
        let reports = env.reports.lock().unwrap().clone();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert_eq!(reports[0].track_id, 1);
        assert!(!reports[0].preview);
        // ローカルで聴いた 30 秒 + Cast で聴いた 10 秒。
        assert!(
            (40_000..40_500).contains(&reports[0].played_ms),
            "{}",
            reports[0].played_ms
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cast_play_replaces_item_and_counts_each_once() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        let first = fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();

        let c = coord.clone();
        let play = tokio::spawn(async move { c.play_track(2, false).await });
        let second = fake.answer_load(2, "PLAYING").await;
        assert_eq!(second["autoplay"], json!(true));
        play.await.unwrap().unwrap();
        settle().await;

        assert_eq!(
            env.player.lock().unwrap().get_state().current_track_id,
            Some(2)
        );
        let reports = env.reports.lock().unwrap().clone();
        assert_eq!(reports.iter().filter(|r| r.track_id == 1).count(), 1);
        assert!(reports.iter().all(|r| r.track_id != 2));
        assert_eq!(env.tickets.validate(&ticket_of(&first)), None);
        assert_eq!(env.tickets.validate(&ticket_of(&second)), Some(2));

        // Cast 中の試聴は断る。
        let err = coord.play_track(1, true).await.unwrap_err();
        assert_eq!(
            err,
            PlayError::Cast(CastError::new(
                CastErrorCode::PreviewActive,
                preview_active().message
            ))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn switching_back_to_local_does_not_double_count() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        let load = fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();
        tokio::time::advance(Duration::from_secs(8)).await;

        // テスト環境には音声デバイスが無いのでローカルの読み込みは失敗しうる。結果は問わない。
        let _ = coord.switch_to_local(false).await;
        settle().await;
        fake.expect("STOP").await; // Receiver アプリの終了
        settle().await;

        assert!(!coord.is_casting());
        assert_eq!(coord.status().target, PlaybackTarget::Local);
        // Cast アイテムの実績はローカルが位置ごと引き継ぐので、ここでは計上しない。
        assert!(env.reports.lock().unwrap().is_empty());
        assert_eq!(env.tickets.validate(&ticket_of(&load)), None);
    }

    #[tokio::test(start_paused = true)]
    async fn connection_loss_keeps_target_and_never_plays_locally() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();

        env.transport.fail_next(10);
        drop(fake);
        for _ in 0..120 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if coord.status().connection_state == CastConnectionState::Disconnected {
                break;
            }
        }
        let st = coord.status();
        assert_eq!(st.connection_state, CastConnectionState::Disconnected);
        assert!(matches!(st.target, PlaybackTarget::GoogleCast { .. }));
        assert_eq!(st.last_error.unwrap().code, CastErrorCode::ConnectionLost);
        assert!(!st.is_playing);
        assert!(coord.is_casting());
        assert!(env.player.lock().unwrap().current_path().is_none());

        let err = coord.play_track(2, false).await.unwrap_err();
        assert!(matches!(err, PlayError::Cast(ref e) if e.code == CastErrorCode::ConnectionLost));
        assert!(
            !err.is_track_specific(),
            "auto-advance must not spin through the queue"
        );
        assert!(coord.pause().await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn newer_switch_supersedes_pending_connect() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let c = coord.clone();
        let task = tokio::spawn(async move { c.connect_cast(device()).await });
        let mut fake = Fake {
            dev: devices.recv().await.unwrap(),
        };
        let launch = fake.expect("LAUNCH").await;

        // 接続中にユーザーが「このコンピューター」を選び直した。
        coord.switch_to_local(false).await.unwrap();
        fake.send(
            NS_RECEIVER,
            RECEIVER_ID,
            json!({ "type": "RECEIVER_STATUS", "requestId": launch["requestId"], "status": {
                "applications": [{ "appId": "CC1AD845", "sessionId": "s1", "transportId": TID }]
            }}),
        );
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, CastErrorCode::Superseded);
        assert!(!coord.is_casting());
        assert_eq!(coord.status().target, PlaybackTarget::Local);
        assert!(env.player.lock().unwrap().current_path().is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn prechecks_fail_before_connecting() {
        let (coord, env, mut devices) = setup();

        env.preview.store(true, Ordering::SeqCst);
        let e = coord.connect_cast(device()).await.unwrap_err();
        assert_eq!(e.code, CastErrorCode::PreviewActive);
        env.preview.store(false, Ordering::SeqCst);

        env.lan.store(false, Ordering::SeqCst);
        let e = coord.connect_cast(device()).await.unwrap_err();
        assert_eq!(e.code, CastErrorCode::LanDisabled);
        assert_eq!(
            coord.status().last_error.unwrap().code,
            CastErrorCode::LanDisabled
        );
        env.lan.store(true, Ordering::SeqCst);

        fake_local(&env, 3, 0);
        let e = coord.connect_cast(device()).await.unwrap_err();
        assert_eq!(e.code, CastErrorCode::UnsupportedFormat);

        assert!(devices.try_recv().is_err(), "no connection attempted");
        assert_eq!(coord.status().target, PlaybackTarget::Local);
    }

    /// 確定の直前に「このコンピューター」へ戻されたら、確定せずに手を引く
    /// (ロック外の世代確認だけだと Cast に戻ってローカルを止めてしまう)。
    #[tokio::test(start_paused = true)]
    async fn switch_to_local_between_load_and_commit_wins() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 10_000);
        let gate = Arc::new(CommitGate::default());
        *coord.commit_gate.lock().unwrap() = Some(gate.clone());

        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        let load = fake.answer_load(1, "PLAYING").await;
        gate.reached.notified().await;
        coord.switch_to_local(false).await.unwrap();
        gate.proceed.notify_one();

        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, CastErrorCode::Superseded);
        fake.expect("STOP").await; // 負けたセッションは閉じる
        settle().await;
        assert!(!coord.is_casting());
        assert_eq!(coord.status().target, PlaybackTarget::Local);
        {
            let p = env.player.lock().unwrap();
            assert!(!p.is_external());
            assert!(p.current_path().is_some(), "local playback stays intact");
        }
        assert_eq!(env.tickets.validate(&ticket_of(&load)), None);
        assert!(env.reports.lock().unwrap().is_empty());
    }

    /// LOAD 中にローカルの曲が終わって次の曲へ送られた (シナリオ A)。
    /// 古い曲で確定せず、送られた後の曲で LOAD し直す (曲の取りこぼし無し)。
    #[tokio::test(start_paused = true)]
    async fn local_advance_during_load_reloads_newest_track() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 179_000);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;

        let first = fake.expect("LOAD").await;
        // advance_worker が次の曲 (2) を読み込んだ。
        fake_local(&env, 2, 0);
        fake.media(
            first["requestId"].as_u64().unwrap(),
            1,
            "PLAYING",
            json!({}),
        );

        let second = fake.answer_load(2, "PLAYING").await;
        assert_eq!(second["currentTime"], json!(0.0));
        task.await.unwrap().unwrap();
        settle().await;

        {
            let mut p = env.player.lock().unwrap();
            assert!(p.is_external());
            assert_eq!(p.get_state().current_track_id, Some(2));
            assert!(!p.is_finished());
        }
        assert_eq!(env.tickets.validate(&ticket_of(&first)), None);
        assert_eq!(env.tickets.validate(&ticket_of(&second)), Some(2));
        // 引き継がなかった 1 曲目の Cast アイテムは計上しない。
        assert!(env.reports.lock().unwrap().iter().all(|r| r.track_id != 1));
    }

    /// 確定後はローカル再生の判定がロック下で外部出力モードを見て断る (シナリオ B)。
    /// `is_casting()` を見た後に確定が割り込んでも PC からは鳴らない。
    #[tokio::test(start_paused = true)]
    async fn local_play_after_commit_is_rerouted() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();

        let t2 = env.tracks[&2].clone();
        assert!(coord.try_play_local(&t2, false).is_none());
        let err = env
            .player
            .lock()
            .unwrap()
            .play(&t2.path, 2, 1, None, false)
            .unwrap_err();
        assert_eq!(err, crate::audio::EXTERNAL_OUTPUT_ACTIVE);
    }

    /// Cast 側で計上済み (接続断・終了) なら、ローカルの続きは計上しない。
    #[test]
    fn local_resume_suppresses_report_when_cast_already_counted() {
        assert_eq!(
            local_resume(1, Some((Some(1), 90_000, false, true))),
            LocalResume {
                position_ms: 90_000,
                playing: false,
                suppress_report: true
            }
        );
        assert_eq!(
            local_resume(1, Some((Some(1), 90_000, true, false))),
            LocalResume {
                position_ms: 90_000,
                playing: true,
                suppress_report: false
            }
        );
        // Cast が別の曲を指している / セッションが無い: 頭から一時停止。
        let fresh = LocalResume {
            position_ms: 0,
            playing: false,
            suppress_report: false,
        };
        assert_eq!(local_resume(1, Some((Some(2), 5_000, true, true))), fresh);
        assert_eq!(local_resume(1, None), fresh);
    }

    /// 試聴で鳴らしていた曲の実績は Cast へ持ち越さない (apply_report が捨てる)。
    #[tokio::test(start_paused = true)]
    async fn preview_listen_is_not_carried_into_cast() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 30_000);
        env.player.lock().unwrap().fake_preview();
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();
        {
            let reports = env.reports.lock().unwrap();
            assert_eq!(reports.len(), 1);
            assert!(reports[0].preview, "preview report goes to apply_report");
        }

        tokio::time::advance(Duration::from_secs(5)).await;
        fake.media(0, 1, "IDLE", json!({ "idleReason": "FINISHED" }));
        settle().await;
        let reports = env.reports.lock().unwrap().clone();
        assert_eq!(reports.len(), 2);
        assert!(!reports[1].preview);
        assert!(
            (5_000..5_500).contains(&reports[1].played_ms),
            "{}",
            reports[1].played_ms
        );
    }

    /// 接続断 (再接続中) の停止: Cast への STOP は失敗しても手元の状態は片付ける。
    #[tokio::test(start_paused = true)]
    async fn stop_during_reconnect_still_clears_local_state() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();

        env.transport.fail_next(10);
        drop(fake);
        for _ in 0..50 {
            tokio::task::yield_now().await;
            if coord.status().connection_state == CastConnectionState::Reconnecting {
                break;
            }
        }
        assert_eq!(
            coord.status().connection_state,
            CastConnectionState::Reconnecting
        );
        let err = coord.stop().await.unwrap_err();
        assert!(matches!(err, PlayError::Cast(ref e) if e.code == CastErrorCode::ConnectionLost));
        let p = env.player.lock().unwrap();
        assert_eq!(p.get_state().current_track_id, None);
        assert!(p.is_external(), "still silent locally");
        drop(p);
        assert!(coord.lock().current.is_none());
    }

    /// Cast A → Cast B: A のアイテムは計上せず、聴いた分は B へ持ち越して 1 回だけ数える。
    #[tokio::test(start_paused = true)]
    async fn cast_to_cast_carries_listened_time_once() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake_a) = start_connect(&coord, &mut devices).await;
        fake_a.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();
        tokio::time::advance(Duration::from_secs(10)).await;

        let (task, mut fake_b) = start_connect_to(&coord, &mut devices, device_b()).await;
        let load_b = fake_b.answer_load(2, "PLAYING").await;
        assert_eq!(load_b["autoplay"], json!(true));
        let at = load_b["currentTime"].as_f64().unwrap();
        assert!((10.0..10.5).contains(&at), "{at}");
        let st = task.await.unwrap().unwrap();
        assert_eq!(
            st.target,
            PlaybackTarget::GoogleCast {
                device_id: "dev-2".into(),
                device_name: "Kitchen Speaker".into()
            }
        );
        fake_a.expect("STOP").await;
        settle().await;
        assert!(
            env.reports.lock().unwrap().is_empty(),
            "A's item is handed off"
        );

        tokio::time::advance(Duration::from_secs(5)).await;
        fake_b.media(0, 2, "IDLE", json!({ "idleReason": "FINISHED" }));
        settle().await;
        let reports = env.reports.lock().unwrap().clone();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert_eq!(reports[0].track_id, 1);
        assert!(
            (15_000..15_500).contains(&reports[0].played_ms),
            "{}",
            reports[0].played_ms
        );
        assert!(coord.take_finished());
    }

    /// Cast 中に API サーバー停止 / LAN OFF: 切断表示 + LAN_DISABLED、チケット失効、PC は無音。
    #[tokio::test(start_paused = true)]
    async fn media_server_loss_disconnects_cast_silently() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        let load = fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();

        // LAN のまま再起動 (トークン再生成など) では何もしない。
        coord.on_media_server_changed().await;
        assert_eq!(
            coord.status().connection_state,
            CastConnectionState::Connected
        );

        env.lan.store(false, Ordering::SeqCst);
        coord.on_media_server_changed().await;
        fake.expect("STOP").await;
        settle().await;
        let st = coord.status();
        assert_eq!(st.connection_state, CastConnectionState::Disconnected);
        assert!(matches!(st.target, PlaybackTarget::GoogleCast { .. }));
        assert_eq!(st.last_error.unwrap().code, CastErrorCode::LanDisabled);
        assert_eq!(env.tickets.validate(&ticket_of(&load)), None);
        assert!(coord.is_casting());
        let p = env.player.lock().unwrap();
        assert!(p.is_external());
        assert!(p.current_path().is_none());
    }

    /// 一時的な接続断から戻ったら、同じアイテム・チケットのまま続ける (余計な計上なし)。
    #[tokio::test(start_paused = true)]
    async fn reconnect_keeps_current_item_and_ticket() {
        let (coord, env, mut devices) = setup();
        fake_local(&env, 1, 0);
        let (task, mut fake) = start_connect(&coord, &mut devices).await;
        let load = fake.answer_load(1, "PLAYING").await;
        task.await.unwrap().unwrap();
        let item = coord.lock().current.as_ref().map(|c| c.item_id);

        drop(fake);
        let mut fake = Fake {
            dev: devices.recv().await.unwrap(),
        };
        assert_eq!(
            coord.status().connection_state,
            CastConnectionState::Reconnecting
        );
        let get = fake.expect("GET_STATUS").await;
        fake.send(
            NS_RECEIVER,
            RECEIVER_ID,
            json!({ "type": "RECEIVER_STATUS", "requestId": get["requestId"], "status": {
                "applications": [{ "appId": "CC1AD845", "sessionId": "s1", "transportId": TID }]
            }}),
        );
        let media = fake.expect("GET_STATUS").await;
        fake.media(
            media["requestId"].as_u64().unwrap(),
            1,
            "PLAYING",
            json!({ "currentTime": 3.0 }),
        );
        settle().await;

        let st = coord.status();
        assert_eq!(st.connection_state, CastConnectionState::Connected);
        assert!(st.is_playing);
        assert_eq!(coord.lock().current.as_ref().map(|c| c.item_id), item);
        assert_eq!(env.tickets.validate(&ticket_of(&load)), Some(1));
        assert!(env.reports.lock().unwrap().is_empty());
        assert!(!coord.take_finished());
    }

    #[test]
    fn merge_state_overlays_cast_on_queue_state() {
        let local = PlaybackState {
            is_playing: false,
            current_track_id: Some(5),
            position_ms: 0,
            duration_ms: 200_000,
            shuffle: true,
            repeat: RepeatMode::All,
            volume: 0.9,
        };
        let view = CastView {
            connected: true,
            playing: true,
            item_tag: Some(5),
            position_ms: 42_000,
            duration_ms: 199_000,
            volume: Some(0.3),
        };
        let m = merge_state(local.clone(), Some(view), None);
        assert!(m.is_playing);
        assert_eq!((m.position_ms, m.duration_ms), (42_000, 199_000));
        assert_eq!(m.volume, 0.3);
        assert!(m.shuffle);
        assert_eq!(m.repeat, RepeatMode::All);

        // 別の曲を読み込み中 / 切断後は再生中にしない。
        let other = CastView {
            item_tag: Some(6),
            ..view
        };
        assert!(!merge_state(local.clone(), Some(other), None).is_playing);
        let gone = merge_state(local, None, Some(0.5));
        assert!(!gone.is_playing);
        assert_eq!(gone.volume, 0.5);
    }

    #[test]
    fn connection_state_derivation() {
        let cast = PlaybackTarget::GoogleCast {
            device_id: "d".into(),
            device_name: "n".into(),
        };
        assert_eq!(
            derive_connection(&PlaybackTarget::Local, CastConnectionState::Connected, None),
            CastConnectionState::Idle
        );
        assert_eq!(
            derive_connection(
                &cast,
                CastConnectionState::Connected,
                Some(PlayerState::Buffering)
            ),
            CastConnectionState::Buffering
        );
        assert_eq!(
            derive_connection(
                &cast,
                CastConnectionState::Reconnecting,
                Some(PlayerState::Buffering)
            ),
            CastConnectionState::Reconnecting
        );
    }
}
