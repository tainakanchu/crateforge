//! 1 台の Cast 端末との接続 (Default Media Receiver) を駆動する。
//!
//! [`CastSession::connect`] が TLS 接続 → `CONNECT receiver-0` → `LAUNCH CC1AD845` →
//! アプリの transportId へ `CONNECT` までを済ませ、以後は tokio タスク (driver) が
//! 受信・heartbeat・要求の応答待ち・再接続を担う。ハンドル ([`CastSession`]) は Clone 可能で、
//! 操作は mpsc で driver へ送り、応答を oneshot で待つ。
//!
//! ## アイテム (= LOAD した 1 曲)
//! - `load(req, tag)` ごとに item_id を採番する。`tag` は呼び出し側の識別子 (track_id)。
//! - アイテムが終わるとき (自然終了 / 差し替え / 停止 / Receiver 側の停止 / エラー / 切断) に
//!   [`SessionEvent::ItemEnded`] を **ちょうど 1 回** 出す。`played_ms` は PLAYING だった
//!   壁時計時間の積算で、再生実績 (play/skip) はこれだけを根拠にする。
//! - 自分の LOAD / STOP が引き起こす旧メディアセッションの IDLE は無視する (旧 mediaSessionId)。
//!
//! ## 接続断
//! 受信路が閉じる / 15 秒何も受信しない (heartbeat 3 回分) と `Reconnecting` にし、
//! 1s/2s/4s の間隔で最大 3 回つなぎ直して同じ Receiver アプリ (sessionId) に再接続する。
//! 全滅 or アプリ終了なら `ItemEnded(Disconnected)` → `Closed` を出して driver は終わる。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::proto::CastMessage;
use super::protocol::{
    self, IdleReason, Incoming, LoadRequest, MediaStatusEntry, PlayerState, ReceiverStatus,
    RunningApp, RECEIVER_ID,
};
use super::transport::{CastChannel, CastTransport};
use super::{CastConnectionState, CastDevice, CastError, CastErrorCode};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
/// これだけ何も受信しなければ接続断とみなす (PING 3 回分)。
const RX_TIMEOUT: Duration = Duration::from_secs(15);
/// 接続 + LAUNCH (または再接続時の GET_STATUS) の待ち時間。
const ESTABLISH_TIMEOUT: Duration = Duration::from_secs(20);
/// LOAD の応答待ち (Receiver が音源を取りに来るので長め)。
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
/// PLAY / PAUSE / SEEK / SET_VOLUME の応答待ち。
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const RECONNECT_ATTEMPTS: u32 = 3;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// PLAYING だった時間の積算 (再生実績用)。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct PlayClock {
    accumulated_ms: u64,
    since: Option<Instant>,
}

impl PlayClock {
    fn set_playing(&mut self, playing: bool, now: Instant) {
        match (playing, self.since) {
            (true, None) => self.since = Some(now),
            (false, Some(t)) => {
                self.accumulated_ms += now.duration_since(t).as_millis() as u64;
                self.since = None;
            }
            _ => {}
        }
    }

    fn total(&self, now: Instant) -> u64 {
        self.accumulated_ms
            + self
                .since
                .map(|t| now.duration_since(t).as_millis() as u64)
                .unwrap_or(0)
    }
}

/// Receiver から見た最新の状態。`CastSession::snapshot` で取れる。
#[derive(Debug, Clone, PartialEq)]
pub struct CastMediaSnapshot {
    /// 接続状態。`Connected` / `Reconnecting` / `Disconnected` のいずれか
    /// (`Buffering` 表示は呼び出し側が `player_state` から導く)。
    pub connection: CastConnectionState,
    pub player_state: PlayerState,
    /// 現在 (または最後) の LOAD アイテム。
    pub item_id: Option<u64>,
    /// そのアイテムの `tag` (track_id)。
    pub item_tag: Option<i64>,
    /// そのアイテムが既に終わっているか (`ItemEnded` 済み)。
    pub item_ended: bool,
    pub media_session_id: Option<i64>,
    /// 最後の状態受信時点の位置。今の位置は [`Self::position_now`]。
    pub position_ms: u64,
    pub duration_ms: u64,
    /// 端末音量 (0..1)。不明なら None。
    pub volume: Option<f32>,
    pub muted: bool,
    pub status_at: Option<Instant>,
    /// 最後の状態受信時刻 (epoch ms、UI 表示用)。
    pub last_status_epoch_ms: Option<u64>,
    clock: PlayClock,
}

impl CastMediaSnapshot {
    fn new() -> Self {
        Self {
            connection: CastConnectionState::Connected,
            player_state: PlayerState::Idle,
            item_id: None,
            item_tag: None,
            item_ended: false,
            media_session_id: None,
            position_ms: 0,
            duration_ms: 0,
            volume: None,
            muted: false,
            status_at: None,
            last_status_epoch_ms: None,
            clock: PlayClock::default(),
        }
    }

    pub fn is_playing(&self) -> bool {
        !self.item_ended
            && matches!(
                self.player_state,
                PlayerState::Playing | PlayerState::Buffering | PlayerState::Loading
            )
    }

    /// PLAYING 中は最後の状態受信からの経過時間で外挿した位置。
    pub fn position_now(&self) -> u64 {
        let mut pos = self.position_ms;
        if self.player_state == PlayerState::Playing
            && self.connection == CastConnectionState::Connected
        {
            if let Some(at) = self.status_at {
                pos += Instant::now().duration_since(at).as_millis() as u64;
            }
        }
        if self.duration_ms > 0 {
            pos.min(self.duration_ms)
        } else {
            pos
        }
    }

    /// 現在アイテムを PLAYING で聴いた合計 (ms)。
    pub fn played_ms(&self) -> u64 {
        self.clock.total(Instant::now())
    }
}

/// アイテムが終わった理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// 最後まで再生した (自動送りのトリガ)。
    Finished,
    /// 次の `load` で差し替えた。
    Replaced,
    /// `stop()` で止めた。
    Stopped,
    /// Receiver 側 (TV リモコン / 別 Sender) で停止・差し替えされた。
    Cancelled,
    /// Receiver が再生エラーを報告した。
    Error,
    /// 接続が切れた / `disconnect()` した。
    Disconnected,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// 状態が変わった (Receiver の MEDIA/RECEIVER_STATUS、接続状態の変化)。
    Status(CastMediaSnapshot),
    /// アイテムが終わった。アイテムごとに 1 回だけ。
    ItemEnded {
        item_id: u64,
        tag: i64,
        played_ms: u64,
        reason: EndReason,
    },
    /// セッション終了 (切断 / 再接続失敗 / Receiver アプリ終了)。以後イベントは来ない。
    Closed { reason: String },
}

type Reply<T> = oneshot::Sender<Result<T, CastError>>;

enum Command {
    Load {
        req: LoadRequest,
        tag: i64,
        reply: Reply<u64>,
    },
    Play(Reply<()>),
    Pause(Reply<()>),
    Seek(u64, Reply<()>),
    SetVolume(f32, Reply<()>),
    Stop(Reply<()>),
    Disconnect {
        stop_app: bool,
        reply: oneshot::Sender<()>,
    },
}

/// 1 端末とのセッションのハンドル。Clone して共有してよい。
/// 全ハンドルを drop すると driver はアプリを止めずに接続だけ閉じる。
#[derive(Clone)]
pub struct CastSession {
    id: u64,
    cmd_tx: mpsc::UnboundedSender<Command>,
    shared: Arc<Mutex<CastMediaSnapshot>>,
}

fn lost() -> CastError {
    CastError::new(
        CastErrorCode::ConnectionLost,
        "Cast 端末との接続が切れています",
    )
}

impl CastSession {
    /// 端末へ接続して Default Media Receiver を起動する。tokio ランタイム上で呼ぶこと。
    /// 失敗時は何も残さない (driver は起動しない)。
    pub async fn connect(
        device: CastDevice,
        transport: Arc<dyn CastTransport>,
        events: mpsc::UnboundedSender<SessionEvent>,
    ) -> Result<CastSession, CastError> {
        let addr = device.socket_addr().ok_or_else(|| {
            CastError::new(CastErrorCode::DeviceNotFound, "端末のアドレスが不正です")
        })?;
        let mut next_req = 0u32;
        let (conn, app, status) = establish(&*transport, addr, None, &mut next_req).await?;

        let mut snap = CastMediaSnapshot::new();
        snap.volume = status.volume_level;
        snap.muted = status.muted.unwrap_or(false);
        let shared = Arc::new(Mutex::new(snap.clone()));
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let driver = Driver {
            addr,
            transport,
            events,
            shared: shared.clone(),
            conn,
            app,
            next_req,
            item: None,
            next_item_id: 1,
            pending: Vec::new(),
            last_rx: Instant::now(),
            last_ping: Instant::now(),
            snap,
            lost: false,
            close_reason: None,
        };
        tokio::spawn(driver.run(cmd_rx));
        Ok(CastSession { id, cmd_tx, shared })
    }

    /// プロセス内で一意なセッション ID (Media Ticket の束縛に使う)。
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn snapshot(&self) -> CastMediaSnapshot {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// driver が終了済みか (Closed 後)。
    pub fn is_closed(&self) -> bool {
        self.cmd_tx.is_closed()
    }

    async fn call<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> Result<T, CastError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(make(tx)).map_err(|_| lost())?;
        rx.await.map_err(|_| lost())?
    }

    /// 音源を LOAD する。Receiver が新しいメディアを受け付けたら item_id を返す。
    /// 直前のアイテムは `ItemEnded(Replaced)` で締める。失敗したアイテムの `ItemEnded` は出ない。
    pub async fn load(&self, req: LoadRequest, tag: i64) -> Result<u64, CastError> {
        self.call(|reply| Command::Load { req, tag, reply }).await
    }

    pub async fn play(&self) -> Result<(), CastError> {
        self.call(Command::Play).await
    }

    pub async fn pause(&self) -> Result<(), CastError> {
        self.call(Command::Pause).await
    }

    pub async fn seek(&self, position_ms: u64) -> Result<(), CastError> {
        self.call(|r| Command::Seek(position_ms, r)).await
    }

    pub async fn set_volume(&self, level: f32) -> Result<(), CastError> {
        self.call(|r| Command::SetVolume(level, r)).await
    }

    /// 再生を止める (アイテムは `ItemEnded(Stopped)`)。Receiver アプリは残す。
    pub async fn stop(&self) -> Result<(), CastError> {
        self.call(Command::Stop).await
    }

    /// 切断する。`stop_app` なら Receiver アプリも終了させる (TV の Cast 画面を閉じる)。
    /// 残っているアイテムは `ItemEnded(Disconnected)`、続いて `Closed` が出る。
    pub async fn disconnect(&self, stop_app: bool) {
        let (tx, rx) = oneshot::channel();
        if self
            .cmd_tx
            .send(Command::Disconnect {
                stop_app,
                reply: tx,
            })
            .is_ok()
        {
            let _ = rx.await;
        }
    }
}

fn next_id(counter: &mut u32) -> u32 {
    *counter = counter.wrapping_add(1).max(1);
    *counter
}

fn send(conn: &CastChannel, m: CastMessage) -> bool {
    conn.tx.send(m).is_ok()
}

/// 接続を張り、Receiver アプリへの仮想接続まで作る。
/// `rejoin` が Some(sessionId) なら LAUNCH せず、そのアプリがまだ動いているかを確かめて繋ぐ。
async fn establish(
    transport: &dyn CastTransport,
    addr: std::net::SocketAddr,
    rejoin: Option<&str>,
    next_req: &mut u32,
) -> Result<(CastChannel, RunningApp, ReceiverStatus), CastError> {
    let deadline = Instant::now() + ESTABLISH_TIMEOUT;
    let connect_failed = |m: String| CastError::new(CastErrorCode::ConnectFailed, m);
    let mut conn = transport
        .connect(addr)
        .await
        .map_err(|e| connect_failed(format!("Cast 端末に接続できません: {e}")))?;
    send(&conn, protocol::connect(RECEIVER_ID));
    let rid = next_id(next_req);
    send(
        &conn,
        match rejoin {
            None => protocol::launch(rid),
            Some(_) => protocol::get_status(rid),
        },
    );
    loop {
        let m = match tokio::time::timeout_at(deadline, conn.rx.recv()).await {
            Ok(Some(m)) => m,
            Ok(None) => return Err(connect_failed("Cast 端末が接続を閉じました".into())),
            Err(_) if rejoin.is_none() => {
                return Err(CastError::new(
                    CastErrorCode::LaunchFailed,
                    "Receiver の起動がタイムアウトしました",
                ))
            }
            Err(_) => return Err(connect_failed("再接続がタイムアウトしました".into())),
        };
        match protocol::parse(&m) {
            Incoming::Ping => {
                send(&conn, protocol::pong(&m.source_id));
            }
            Incoming::ReceiverStatus { request_id, status } => {
                let app = status.media_app().cloned();
                match (rejoin, app) {
                    (None, Some(app)) => {
                        send(&conn, protocol::connect(&app.transport_id));
                        return Ok((conn, app, status));
                    }
                    (Some(sid), Some(app)) if app.session_id == sid => {
                        send(&conn, protocol::connect(&app.transport_id));
                        return Ok((conn, app, status));
                    }
                    (Some(_), _) if request_id == rid => {
                        return Err(CastError::new(
                            CastErrorCode::ConnectionLost,
                            "Receiver アプリが終了しています",
                        ))
                    }
                    // LAUNCH 直後はアプリがまだ載っていない状態通知が来うるので待つ。
                    _ => {}
                }
            }
            Incoming::LaunchError { request_id, reason }
            | Incoming::InvalidRequest { request_id, reason }
                if request_id == rid =>
            {
                return Err(CastError::new(
                    CastErrorCode::LaunchFailed,
                    format!("Receiver を起動できません ({reason})"),
                ));
            }
            _ => {}
        }
    }
}

struct Item {
    id: u64,
    tag: i64,
    content_id: String,
    media_session_id: Option<i64>,
    ended: bool,
}

enum PendingKind {
    Load { item_id: u64, reply: Reply<u64> },
    Command(Reply<()>),
}

struct Pending {
    request_id: u32,
    deadline: Instant,
    kind: PendingKind,
}

impl Pending {
    fn fail(self, e: CastError) {
        match self.kind {
            PendingKind::Load { reply, .. } => {
                let _ = reply.send(Err(e));
            }
            PendingKind::Command(reply) => {
                let _ = reply.send(Err(e));
            }
        }
    }
}

struct Driver {
    addr: std::net::SocketAddr,
    transport: Arc<dyn CastTransport>,
    events: mpsc::UnboundedSender<SessionEvent>,
    shared: Arc<Mutex<CastMediaSnapshot>>,
    conn: CastChannel,
    app: RunningApp,
    next_req: u32,
    item: Option<Item>,
    next_item_id: u64,
    pending: Vec<Pending>,
    last_rx: Instant,
    last_ping: Instant,
    snap: CastMediaSnapshot,
    /// 受信路の断を検知した (ループ末尾で再接続する)。
    lost: bool,
    /// Some なら driver を終える (Receiver アプリ終了など)。
    close_reason: Option<String>,
}

impl Driver {
    async fn run(mut self, mut cmd_rx: mpsc::UnboundedReceiver<Command>) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        self.publish();
        loop {
            tokio::select! {
                m = self.conn.rx.recv() => match m {
                    Some(m) => self.on_message(m),
                    None => self.lost = true,
                },
                c = cmd_rx.recv() => match c {
                    Some(Command::Disconnect { stop_app, reply }) => {
                        self.shutdown(stop_app);
                        let _ = reply.send(());
                        self.close_reason = Some("切断しました".into());
                    }
                    Some(c) => self.on_command(c),
                    // 全ハンドルが drop された: アプリは残して接続だけ閉じる。
                    None => {
                        self.shutdown(false);
                        self.close_reason = Some("セッションが破棄されました".into());
                    }
                },
                _ = tick.tick() => self.on_tick(),
            }
            if self.close_reason.is_none() && self.lost && !self.recover(&mut cmd_rx).await {
                self.end_item(EndReason::Disconnected);
                self.close_reason
                    .get_or_insert_with(|| "Cast 端末との接続が切れました".into());
            }
            if let Some(reason) = self.close_reason.take() {
                self.fail_pending(lost());
                self.snap.connection = CastConnectionState::Disconnected;
                self.snap.clock.set_playing(false, Instant::now());
                self.publish();
                let _ = self.events.send(SessionEvent::Closed { reason });
                return;
            }
        }
    }

    fn req_id(&mut self) -> u32 {
        next_id(&mut self.next_req)
    }

    fn publish(&mut self) {
        if let Some(item) = &self.item {
            self.snap.item_id = Some(item.id);
            self.snap.item_tag = Some(item.tag);
            self.snap.item_ended = item.ended;
            self.snap.media_session_id = item.media_session_id;
        } else {
            self.snap.item_id = None;
            self.snap.item_tag = None;
            self.snap.item_ended = false;
            self.snap.media_session_id = None;
        }
        *self.shared.lock().unwrap_or_else(|e| e.into_inner()) = self.snap.clone();
        let _ = self.events.send(SessionEvent::Status(self.snap.clone()));
    }

    /// 現在アイテムを締めて `ItemEnded` を出す (既に締めていれば何もしない)。
    fn end_item(&mut self, reason: EndReason) {
        let now = Instant::now();
        self.snap.clock.set_playing(false, now);
        let Some(item) = self.item.as_mut() else {
            return;
        };
        if item.ended {
            return;
        }
        item.ended = true;
        let _ = self.events.send(SessionEvent::ItemEnded {
            item_id: item.id,
            tag: item.tag,
            played_ms: self.snap.clock.total(now),
            reason,
        });
    }

    fn fail_pending(&mut self, e: CastError) {
        for p in self.pending.drain(..) {
            p.fail(e.clone());
        }
    }

    fn take_pending(&mut self, request_id: u32) -> Option<Pending> {
        let i = self
            .pending
            .iter()
            .position(|p| p.request_id == request_id)?;
        Some(self.pending.remove(i))
    }

    fn on_tick(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.last_rx) >= RX_TIMEOUT {
            self.lost = true;
            return;
        }
        if now.duration_since(self.last_ping) >= HEARTBEAT_INTERVAL {
            self.last_ping = now;
            if !send(&self.conn, protocol::ping()) {
                self.lost = true;
            }
        }
        let (expired, rest): (Vec<_>, Vec<_>) =
            self.pending.drain(..).partition(|p| p.deadline <= now);
        self.pending = rest;
        for p in expired {
            let load_item = match &p.kind {
                PendingKind::Load { item_id, .. } => Some(*item_id),
                PendingKind::Command(_) => None,
            };
            let code = if load_item.is_some() {
                CastErrorCode::LoadFailed
            } else {
                CastErrorCode::Internal
            };
            p.fail(CastError::new(
                code,
                "Cast 端末の応答がタイムアウトしました",
            ));
            if let Some(id) = load_item {
                self.drop_failed_item(id);
            }
        }
    }

    /// LOAD に失敗したアイテムを捨てる (再生していないので ItemEnded は出さない)。
    fn drop_failed_item(&mut self, item_id: u64) {
        if self.item.as_ref().is_some_and(|i| i.id == item_id) {
            self.item = None;
            self.snap.player_state = PlayerState::Idle;
            self.snap.clock = PlayClock::default();
            self.publish();
        }
    }

    fn on_command(&mut self, c: Command) {
        let dest = self.app.transport_id.clone();
        match c {
            Command::Load { req, tag, reply } => {
                // 先行中の LOAD は新しい要求に置き換える。
                let old: Vec<Pending> = {
                    let (old, rest) = self
                        .pending
                        .drain(..)
                        .partition(|p| matches!(p.kind, PendingKind::Load { .. }));
                    self.pending = rest;
                    old
                };
                for p in old {
                    p.fail(CastError::new(
                        CastErrorCode::Superseded,
                        "新しい読み込み要求に置き換えられました",
                    ));
                }
                self.end_item(EndReason::Replaced);
                let id = self.next_item_id;
                self.next_item_id += 1;
                self.item = Some(Item {
                    id,
                    tag,
                    content_id: req.content_id.clone(),
                    media_session_id: None,
                    ended: false,
                });
                self.snap.clock = PlayClock::default();
                self.snap.player_state = PlayerState::Loading;
                self.snap.position_ms = req.start_ms;
                self.snap.duration_ms = req.duration_ms.unwrap_or(0);
                self.snap.status_at = Some(Instant::now());
                let rid = self.req_id();
                if !send(&self.conn, protocol::load(&dest, rid, &req)) {
                    let _ = reply.send(Err(lost()));
                    self.lost = true;
                    return;
                }
                self.pending.push(Pending {
                    request_id: rid,
                    deadline: Instant::now() + LOAD_TIMEOUT,
                    kind: PendingKind::Load { item_id: id, reply },
                });
                self.publish();
            }
            Command::Stop(reply) => {
                let msid = self.active_media_session();
                self.end_item(EndReason::Stopped);
                if let Some(msid) = msid {
                    let rid = self.req_id();
                    send(&self.conn, protocol::media_stop(&dest, rid, msid));
                }
                self.snap.player_state = PlayerState::Idle;
                self.publish();
                let _ = reply.send(Ok(()));
            }
            Command::Play(reply) => self.media_command(reply, protocol::play),
            Command::Pause(reply) => self.media_command(reply, protocol::pause),
            Command::Seek(ms, reply) => {
                self.media_command(reply, move |d, r, m| protocol::seek(d, r, m, ms))
            }
            Command::SetVolume(level, reply) => {
                let rid = self.req_id();
                self.push_command(rid, protocol::set_volume(rid, level), reply);
            }
            Command::Disconnect { .. } => unreachable!("handled in run()"),
        }
    }

    /// 終わっていない現在アイテムの mediaSessionId。
    fn active_media_session(&self) -> Option<i64> {
        self.item
            .as_ref()
            .filter(|i| !i.ended)
            .and_then(|i| i.media_session_id)
    }

    fn media_command(
        &mut self,
        reply: Reply<()>,
        build: impl FnOnce(&str, u32, i64) -> CastMessage,
    ) {
        let Some(msid) = self.active_media_session() else {
            let _ = reply.send(Err(CastError::new(
                CastErrorCode::Internal,
                "Cast 先で再生中のメディアがありません",
            )));
            return;
        };
        let rid = self.req_id();
        let m = build(&self.app.transport_id, rid, msid);
        self.push_command(rid, m, reply);
    }

    fn push_command(&mut self, rid: u32, m: CastMessage, reply: Reply<()>) {
        if !send(&self.conn, m) {
            let _ = reply.send(Err(lost()));
            self.lost = true;
            return;
        }
        self.pending.push(Pending {
            request_id: rid,
            deadline: Instant::now() + COMMAND_TIMEOUT,
            kind: PendingKind::Command(reply),
        });
    }

    fn on_message(&mut self, m: CastMessage) {
        self.last_rx = Instant::now();
        match protocol::parse(&m) {
            Incoming::Ping => {
                send(&self.conn, protocol::pong(&m.source_id));
            }
            Incoming::Close => {
                if m.source_id == self.app.transport_id {
                    self.end_item(EndReason::Disconnected);
                    self.close_reason = Some("Receiver アプリが終了しました".into());
                } else {
                    self.lost = true;
                }
            }
            Incoming::ReceiverStatus { request_id, status } => {
                if let Some(p) = self.take_pending(request_id) {
                    if let PendingKind::Command(reply) = p.kind {
                        let _ = reply.send(Ok(()));
                    }
                }
                if !status
                    .apps
                    .iter()
                    .any(|a| a.session_id == self.app.session_id)
                {
                    self.end_item(EndReason::Disconnected);
                    self.close_reason = Some(
                        "Receiver アプリが終了しました (別のアプリに切り替わった可能性があります)"
                            .into(),
                    );
                    return;
                }
                if let Some(v) = status.volume_level {
                    self.snap.volume = Some(v);
                }
                if let Some(muted) = status.muted {
                    self.snap.muted = muted;
                }
                self.publish();
            }
            Incoming::MediaStatus {
                request_id,
                entries,
            } => self.on_media_status(request_id, entries),
            Incoming::LoadFailed { request_id } | Incoming::LoadCancelled { request_id } => {
                if let Some(p) = self.take_pending(request_id) {
                    let item = match &p.kind {
                        PendingKind::Load { item_id, .. } => Some(*item_id),
                        PendingKind::Command(_) => None,
                    };
                    p.fail(CastError::new(
                        CastErrorCode::LoadFailed,
                        "Cast 端末が音源を読み込めませんでした",
                    ));
                    if let Some(id) = item {
                        self.drop_failed_item(id);
                    }
                }
            }
            Incoming::InvalidRequest { request_id, reason } => {
                if let Some(p) = self.take_pending(request_id) {
                    let item = match &p.kind {
                        PendingKind::Load { item_id, .. } => Some(*item_id),
                        PendingKind::Command(_) => None,
                    };
                    let code = if item.is_some() {
                        CastErrorCode::LoadFailed
                    } else {
                        CastErrorCode::Internal
                    };
                    p.fail(CastError::new(
                        code,
                        format!("Cast 端末が要求を拒否しました ({reason})"),
                    ));
                    if let Some(id) = item {
                        self.drop_failed_item(id);
                    }
                }
            }
            Incoming::InvalidPlayerState { request_id } => {
                if let Some(p) = self.take_pending(request_id) {
                    p.fail(CastError::new(
                        CastErrorCode::Internal,
                        "Cast 端末の再生状態ではこの操作はできません",
                    ));
                }
            }
            Incoming::Pong | Incoming::LaunchError { .. } | Incoming::Other => {}
        }
    }

    fn on_media_status(&mut self, request_id: u32, entries: Vec<MediaStatusEntry>) {
        if let Some(p) = self.take_pending(request_id) {
            match p.kind {
                PendingKind::Load { item_id, reply } => {
                    let first = entries.first();
                    let failed = first.is_none_or(|e| {
                        e.player_state == PlayerState::Idle
                            && e.idle_reason == Some(IdleReason::Error)
                    });
                    if failed {
                        let _ = reply.send(Err(CastError::new(
                            CastErrorCode::LoadFailed,
                            "Cast 端末が音源を読み込めませんでした",
                        )));
                        self.drop_failed_item(item_id);
                        return;
                    }
                    if let (Some(item), Some(e)) = (self.item.as_mut(), first) {
                        if item.id == item_id {
                            item.media_session_id = Some(e.media_session_id);
                        }
                    }
                    let _ = reply.send(Ok(item_id));
                }
                PendingKind::Command(reply) => {
                    let _ = reply.send(Ok(()));
                }
            }
        }
        let mut changed = false;
        for e in entries {
            changed |= self.apply_entry(e);
        }
        if changed {
            self.publish();
        }
    }

    /// 現在アイテムの MEDIA_STATUS を反映する。関係ない (旧/他) セッションのものは無視。
    fn apply_entry(&mut self, e: MediaStatusEntry) -> bool {
        let Some(item) = self.item.as_mut() else {
            return false;
        };
        match item.media_session_id {
            Some(msid) if msid == e.media_session_id => {}
            // LOAD 応答より先に自発通知が来た場合、同じ音源で再生中なら採用する。
            None if e.player_state != PlayerState::Idle
                && e.content_id.as_deref() == Some(item.content_id.as_str()) =>
            {
                item.media_session_id = Some(e.media_session_id);
                if let Some(i) = self.pending.iter().position(
                    |p| matches!(&p.kind, PendingKind::Load { item_id, .. } if *item_id == item.id),
                ) {
                    if let PendingKind::Load { item_id, reply } = self.pending.remove(i).kind {
                        let _ = reply.send(Ok(item_id));
                    }
                }
            }
            _ => return false,
        }
        if item.ended {
            return false;
        }
        let now = Instant::now();
        self.snap.player_state = e.player_state;
        if let Some(t) = e.current_time_ms {
            self.snap.position_ms = t;
        }
        if let Some(d) = e.duration_ms.filter(|d| *d > 0) {
            self.snap.duration_ms = d;
        }
        self.snap.status_at = Some(now);
        self.snap.last_status_epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as u64);
        self.snap
            .clock
            .set_playing(e.player_state == PlayerState::Playing, now);
        if e.player_state == PlayerState::Idle {
            match e.idle_reason {
                Some(IdleReason::Finished) => {
                    if self.snap.duration_ms > 0 {
                        self.snap.position_ms = self.snap.duration_ms;
                    }
                    self.end_item(EndReason::Finished);
                }
                Some(IdleReason::Error) => self.end_item(EndReason::Error),
                Some(IdleReason::Cancelled | IdleReason::Interrupted) => {
                    self.end_item(EndReason::Cancelled)
                }
                Some(IdleReason::Other) | None => {}
            }
        }
        true
    }

    fn shutdown(&mut self, stop_app: bool) {
        self.end_item(EndReason::Disconnected);
        if stop_app {
            let rid = self.req_id();
            send(&self.conn, protocol::stop_app(rid, &self.app.session_id));
        }
        send(&self.conn, protocol::close(&self.app.transport_id));
        send(&self.conn, protocol::close(RECEIVER_ID));
    }

    /// 接続断から復旧を試みる。復旧できたら true。
    /// 試行中に届いた操作は `CONNECTION_LOST` で即座に断る (Disconnect は試行を打ち切る)。
    async fn recover(&mut self, cmd_rx: &mut mpsc::UnboundedReceiver<Command>) -> bool {
        self.lost = false;
        self.fail_pending(lost());
        self.snap.clock.set_playing(false, Instant::now());
        self.snap.connection = CastConnectionState::Reconnecting;
        self.publish();
        crate::logging::write_line("warn", "cast: connection lost, reconnecting");

        let session_id = self.app.session_id.clone();
        for attempt in 0..RECONNECT_ATTEMPTS {
            let backoff = tokio::time::sleep(Duration::from_secs(1 << attempt));
            if !reject_while(cmd_rx, backoff).await {
                return false;
            }
            let mut next_req = self.next_req;
            let attempt_fut = establish(
                &*self.transport,
                self.addr,
                Some(&session_id),
                &mut next_req,
            );
            let result = {
                tokio::pin!(attempt_fut);
                let mut out = None;
                // establish と並行して操作を断り続ける。
                loop {
                    tokio::select! {
                        r = &mut attempt_fut => { out = Some(r); break; }
                        c = cmd_rx.recv() => if !reject(c) { break; },
                    }
                }
                out
            };
            self.next_req = next_req;
            match result {
                None => return false,
                Some(Ok((conn, app, status))) => {
                    self.conn = conn;
                    self.app = app;
                    self.last_rx = Instant::now();
                    self.last_ping = Instant::now();
                    if let Some(v) = status.volume_level {
                        self.snap.volume = Some(v);
                    }
                    self.snap.connection = CastConnectionState::Connected;
                    let rid = self.req_id();
                    send(
                        &self.conn,
                        protocol::media_get_status(&self.app.transport_id, rid),
                    );
                    self.publish();
                    crate::logging::write_line("info", "cast: reconnected");
                    return true;
                }
                // アプリが既に無い: これ以上試しても戻れない。
                Some(Err(e)) if e.code == CastErrorCode::ConnectionLost => {
                    self.close_reason = Some(e.message);
                    return false;
                }
                Some(Err(_)) => continue,
            }
        }
        false
    }
}

/// 再接続中に届いた操作を断る。Disconnect / ハンドル全滅なら false。
fn reject(c: Option<Command>) -> bool {
    match c {
        None => false,
        Some(Command::Disconnect { reply, .. }) => {
            let _ = reply.send(());
            false
        }
        Some(Command::Load { reply, .. }) => {
            let _ = reply.send(Err(lost()));
            true
        }
        Some(
            Command::Play(reply)
            | Command::Pause(reply)
            | Command::Stop(reply)
            | Command::Seek(_, reply)
            | Command::SetVolume(_, reply),
        ) => {
            let _ = reply.send(Err(lost()));
            true
        }
    }
}

/// `fut` が終わるまで操作を断り続ける。途中で Disconnect が来たら false。
async fn reject_while(
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
    fut: impl std::future::Future<Output = ()>,
) -> bool {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            _ = &mut fut => return true,
            c = cmd_rx.recv() => if !reject(c) { return false; },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cast::protocol::{NS_MEDIA, NS_RECEIVER};
    use crate::cast::transport::{MockDevice, MockTransport};
    use serde_json::{json, Value};

    const TID: &str = "web-5";

    struct Fake {
        dev: MockDevice,
    }

    impl Fake {
        /// PING / CONNECT / CLOSE 以外で次に来た Sender のメッセージを (namespace, payload) で返す。
        async fn next(&mut self) -> (String, Value) {
            loop {
                let m = self.dev.from_sender.recv().await.expect("sender closed");
                let v: Value = serde_json::from_str(&m.payload_utf8).unwrap();
                if matches!(
                    v["type"].as_str(),
                    Some("PING" | "PONG" | "CONNECT" | "CLOSE")
                ) {
                    continue;
                }
                return (m.namespace, v);
            }
        }

        async fn expect(&mut self, ty: &str) -> Value {
            let (_, v) = self.next().await;
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

        fn receiver_status(&self, rid: u64, session: &str) {
            self.send(
                NS_RECEIVER,
                RECEIVER_ID,
                json!({ "type": "RECEIVER_STATUS", "requestId": rid, "status": {
                    "applications": [{ "appId": "CC1AD845", "sessionId": session, "transportId": TID }],
                    "volume": { "level": 0.5, "muted": false }
                }}),
            );
        }

        fn media(&self, rid: u64, msid: i64, state: &str, extra: Value) {
            let mut e = json!({ "mediaSessionId": msid, "playerState": state, "currentTime": 0.0,
                "media": { "contentId": "http://h/a", "duration": 180.0 } });
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
    }

    fn device() -> CastDevice {
        CastDevice {
            id: "d1".into(),
            name: "TV".into(),
            model: None,
            host: "192.168.1.9".into(),
            port: 8009,
        }
    }

    fn req() -> LoadRequest {
        LoadRequest {
            content_id: "http://h/a".into(),
            content_type: "audio/mpeg".into(),
            duration_ms: Some(180_000),
            title: None,
            artist: None,
            album: None,
            start_ms: 0,
            autoplay: true,
        }
    }

    struct Harness {
        session: CastSession,
        fake: Fake,
        events: mpsc::UnboundedReceiver<SessionEvent>,
        devices: mpsc::UnboundedReceiver<MockDevice>,
        transport: Arc<MockTransport>,
    }

    async fn connected() -> Harness {
        let (t, mut devices) = MockTransport::new();
        let transport = Arc::new(t);
        let (ev_tx, events) = mpsc::unbounded_channel();
        let connect = tokio::spawn(CastSession::connect(device(), transport.clone(), ev_tx));
        let mut fake = Fake {
            dev: devices.recv().await.unwrap(),
        };
        let launch = fake.expect("LAUNCH").await;
        assert_eq!(launch["appId"], "CC1AD845");
        fake.receiver_status(launch["requestId"].as_u64().unwrap(), "s1");
        let session = connect.await.unwrap().unwrap();
        Harness {
            session,
            fake,
            events,
            devices,
            transport,
        }
    }

    /// LOAD を受けて mediaSessionId=msid で PLAYING を返し、item_id を得る。
    async fn load_playing(h: &mut Harness, msid: i64, tag: i64) -> u64 {
        let s = h.session.clone();
        let task = tokio::spawn(async move { s.load(req(), tag).await });
        let load = h.fake.expect("LOAD").await;
        assert_eq!(load["media"]["contentId"], "http://h/a");
        h.fake.media(
            load["requestId"].as_u64().unwrap(),
            msid,
            "PLAYING",
            json!({}),
        );
        task.await.unwrap().unwrap()
    }

    async fn next_non_status(events: &mut mpsc::UnboundedReceiver<SessionEvent>) -> SessionEvent {
        loop {
            match events.recv().await.expect("events closed") {
                SessionEvent::Status(_) => continue,
                other => return other,
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn load_play_finish_reports_played_time() {
        let mut h = connected().await;
        assert_eq!(h.session.snapshot().volume, Some(0.5));
        let item = load_playing(&mut h, 1, 42).await;
        let snap = h.session.snapshot();
        assert_eq!(snap.item_tag, Some(42));
        assert!(snap.is_playing());

        tokio::time::advance(Duration::from_secs(10)).await;
        let snap = h.session.snapshot();
        assert!((10_000..10_100).contains(&snap.position_now()));
        assert!((10_000..10_100).contains(&snap.played_ms()));

        h.fake
            .media(0, 1, "IDLE", json!({ "idleReason": "FINISHED" }));
        match next_non_status(&mut h.events).await {
            SessionEvent::ItemEnded {
                item_id,
                tag,
                played_ms,
                reason,
            } => {
                assert_eq!((item_id, tag, reason), (item, 42, EndReason::Finished));
                assert!((10_000..10_100).contains(&played_ms));
            }
            e => panic!("unexpected {e:?}"),
        }
        let snap = h.session.snapshot();
        assert!(snap.item_ended);
        assert!(!snap.is_playing());
        assert_eq!(snap.position_now(), 180_000);
    }

    #[tokio::test(start_paused = true)]
    async fn paused_time_is_not_counted() {
        let mut h = connected().await;
        load_playing(&mut h, 1, 1).await;
        tokio::time::advance(Duration::from_secs(5)).await;
        h.fake.media(0, 1, "PAUSED", json!({ "currentTime": 5.0 }));
        // 状態反映を待つ。
        while h.session.snapshot().player_state != PlayerState::Paused {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_secs(30)).await;
        let snap = h.session.snapshot();
        assert_eq!(snap.position_now(), 5_000);
        assert!((5_000..5_100).contains(&snap.played_ms()));
    }

    #[tokio::test(start_paused = true)]
    async fn load_failed_is_reported_without_item_end() {
        let mut h = connected().await;
        let s = h.session.clone();
        let task = tokio::spawn(async move { s.load(req(), 7).await });
        let load = h.fake.expect("LOAD").await;
        h.fake.send(
            NS_MEDIA,
            TID,
            json!({ "type": "LOAD_FAILED", "requestId": load["requestId"] }),
        );
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, CastErrorCode::LoadFailed);
        assert_eq!(h.session.snapshot().item_id, None);
        // 失敗アイテムの ItemEnded は出ない。
        while let Ok(ev) = h.events.try_recv() {
            assert!(matches!(ev, SessionEvent::Status(_)), "{ev:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn replacing_item_ignores_stale_idle() {
        let mut h = connected().await;
        let first = load_playing(&mut h, 1, 10).await;
        let second = load_playing(&mut h, 2, 11).await;
        match next_non_status(&mut h.events).await {
            SessionEvent::ItemEnded {
                item_id, reason, ..
            } => {
                assert_eq!((item_id, reason), (first, EndReason::Replaced))
            }
            e => panic!("unexpected {e:?}"),
        }
        // 旧セッションの IDLE(INTERRUPTED) は新アイテムに影響しない。
        h.fake
            .media(0, 1, "IDLE", json!({ "idleReason": "INTERRUPTED" }));
        h.fake.media(0, 2, "PLAYING", json!({ "currentTime": 3.0 }));
        while h.session.snapshot().position_ms != 3_000 {
            tokio::task::yield_now().await;
        }
        let snap = h.session.snapshot();
        assert_eq!(snap.item_id, Some(second));
        assert!(!snap.item_ended);
        while let Ok(ev) = h.events.try_recv() {
            assert!(matches!(ev, SessionEvent::Status(_)), "{ev:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn commands_use_media_session_and_stop_ends_item_once() {
        let mut h = connected().await;
        let item = load_playing(&mut h, 3, 5).await;

        let s = h.session.clone();
        let task = tokio::spawn(async move { s.seek(61_500).await });
        let seek = h.fake.expect("SEEK").await;
        assert_eq!(seek["mediaSessionId"], 3);
        assert_eq!(seek["currentTime"], 61.5);
        h.fake.media(
            seek["requestId"].as_u64().unwrap(),
            3,
            "PLAYING",
            json!({ "currentTime": 61.5 }),
        );
        task.await.unwrap().unwrap();

        let s = h.session.clone();
        let task = tokio::spawn(async move { s.set_volume(0.3).await });
        let vol = h.fake.expect("SET_VOLUME").await;
        h.fake
            .receiver_status(vol["requestId"].as_u64().unwrap(), "s1");
        task.await.unwrap().unwrap();

        h.session.stop().await.unwrap();
        assert_eq!(h.fake.expect("STOP").await["mediaSessionId"], 3);
        // 自分の STOP による IDLE(CANCELLED) で二重に締めない。
        h.fake
            .media(0, 3, "IDLE", json!({ "idleReason": "CANCELLED" }));
        match next_non_status(&mut h.events).await {
            SessionEvent::ItemEnded {
                item_id, reason, ..
            } => {
                assert_eq!((item_id, reason), (item, EndReason::Stopped))
            }
            e => panic!("unexpected {e:?}"),
        }
        // 再生中メディアが無いので PLAY はエラー。
        assert!(h.session.play().await.is_err());
        h.session.disconnect(true).await;
        assert_eq!(h.fake.expect("STOP").await["sessionId"], "s1");
        assert!(matches!(
            next_non_status(&mut h.events).await,
            SessionEvent::Closed { .. }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn connection_loss_gives_up_after_retries() {
        let mut h = connected().await;
        let item = load_playing(&mut h, 1, 9).await;
        h.transport.fail_next(RECONNECT_ATTEMPTS as usize);
        drop(h.fake);
        let mut saw_reconnecting = false;
        loop {
            match h.events.recv().await.unwrap() {
                SessionEvent::Status(s) => {
                    saw_reconnecting |= s.connection == CastConnectionState::Reconnecting
                }
                SessionEvent::ItemEnded {
                    item_id, reason, ..
                } => {
                    assert_eq!((item_id, reason), (item, EndReason::Disconnected))
                }
                SessionEvent::Closed { .. } => break,
            }
        }
        assert!(saw_reconnecting);
        assert_eq!(
            h.session.snapshot().connection,
            CastConnectionState::Disconnected
        );
        assert_eq!(
            h.session.play().await.unwrap_err().code,
            CastErrorCode::ConnectionLost
        );
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_timeout_reconnects_to_same_app() {
        let mut h = connected().await;
        load_playing(&mut h, 1, 9).await;
        // 端末が黙る (接続は開いたまま) → 15 秒で断と判断して再接続。
        let _silent = h.fake;
        let mut fake = Fake {
            dev: h.devices.recv().await.unwrap(),
        };
        let get = fake.expect("GET_STATUS").await;
        fake.receiver_status(get["requestId"].as_u64().unwrap(), "s1");
        // 再接続後に media の GET_STATUS で状態を取り直す。
        let (ns, v) = fake.next().await;
        assert_eq!(
            (ns.as_str(), v["type"].as_str()),
            (NS_MEDIA, Some("GET_STATUS"))
        );
        let mut saw_reconnecting = false;
        loop {
            if let SessionEvent::Status(s) = h.events.recv().await.unwrap() {
                match s.connection {
                    CastConnectionState::Reconnecting => saw_reconnecting = true,
                    CastConnectionState::Connected if saw_reconnecting => break,
                    _ => {}
                }
            }
        }
        // 同じメディアセッションのまま操作を続けられる。
        fake.media(
            v["requestId"].as_u64().unwrap(),
            1,
            "PLAYING",
            json!({ "currentTime": 20.0 }),
        );
        let s = h.session.clone();
        let task = tokio::spawn(async move { s.pause().await });
        let pause = fake.expect("PAUSE").await;
        assert_eq!(pause["mediaSessionId"], 1);
        fake.media(
            pause["requestId"].as_u64().unwrap(),
            1,
            "PAUSED",
            json!({ "currentTime": 20.0 }),
        );
        task.await.unwrap().unwrap();
        assert!(!h.session.snapshot().item_ended);
    }

    #[tokio::test(start_paused = true)]
    async fn rejoin_fails_when_app_gone() {
        let mut h = connected().await;
        load_playing(&mut h, 1, 9).await;
        drop(h.fake);
        let mut fake = Fake {
            dev: h.devices.recv().await.unwrap(),
        };
        let get = fake.expect("GET_STATUS").await;
        fake.send(
            NS_RECEIVER,
            RECEIVER_ID,
            json!({ "type": "RECEIVER_STATUS", "requestId": get["requestId"],
                    "status": { "applications": [], "volume": { "level": 0.5 } } }),
        );
        loop {
            if let SessionEvent::Closed { reason } = h.events.recv().await.unwrap() {
                assert!(reason.contains("Receiver"));
                break;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn launch_error_fails_connect() {
        let (t, mut devices) = MockTransport::new();
        let (ev_tx, _ev) = mpsc::unbounded_channel();
        let connect = tokio::spawn(CastSession::connect(device(), Arc::new(t), ev_tx));
        let mut fake = Fake {
            dev: devices.recv().await.unwrap(),
        };
        let launch = fake.expect("LAUNCH").await;
        fake.send(
            NS_RECEIVER,
            RECEIVER_ID,
            json!({ "type": "LAUNCH_ERROR", "requestId": launch["requestId"], "reason": "NOT_ALLOWED" }),
        );
        let err = connect.await.unwrap().err().unwrap();
        assert_eq!(err.code, CastErrorCode::LaunchFailed);
    }

    #[tokio::test(start_paused = true)]
    async fn connect_refused_maps_to_connect_failed() {
        let (t, _devices) = MockTransport::new();
        t.fail_next(1);
        let (ev_tx, _ev) = mpsc::unbounded_channel();
        let err = CastSession::connect(device(), Arc::new(t), ev_tx)
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, CastErrorCode::ConnectFailed);
    }
}
