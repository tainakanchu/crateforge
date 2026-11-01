# キャスト再生 (Google Cast) 設計メモ — P0

仕様書「Crateforge キャスト再生機能 仕様書 Draft v1」の P0 を実装するための設計判断と
内部インタフェース契約。実装の現状と食い違ったらこのファイルを更新する。

## 1. CastV2 Sender ライブラリ選定 (PoC 結果)

| 候補 | 判断 | 理由 |
|---|---|---|
| `rust_cast` 0.21 (MIT) | 不採用 | 同期 (blocking) API。`rustls` を default features で引くため `aws-lc-rs` が入り、既存の `ring` プロバイダ (reqwest 経由) と二重化して `ClientConfig::builder()` がプロセス既定プロバイダ未設定で panic しうる。Windows で cmake/nasm が要る。`protobuf =3.7.2` を build-time codegen で固定 |
| `cast-sender` 0.3 (MIT) | 不採用 | `smol` ランタイム + `async-native-tls` (Linux で OpenSSL) を追加で引く。既存は tokio 一本 |
| **自前の薄い CastV2 実装** | **採用** | CastV2 は「4byte BE 長 + protobuf `CastMessage` (7 フィールド)」を TLS 上でやり取りし、ペイロードは JSON。protobuf は手書きエンコード/デコードで足りる。TLS は既に依存ツリーにある `rustls 0.23` (ring) + `tokio-rustls 0.26` を使い、新規ネイティブ依存ゼロ。`CastTransport` trait を境界にしてモック可能 |

Cast 端末は自己署名証明書なので、TLS 検証は **Cast 接続専用の ClientConfig に限って** 無効化する
(デバイス認証 `deviceauth` は Default Media Receiver の利用に不要)。他の HTTPS (reqwest) には影響させない。

## 2. モジュール構成

```text
src-tauri/src/cast/
  mod.rs           # 公開型 (CastDevice / CastStatus / PlaybackTarget / CastConnectionState / CastErrorCode)
  proto.rs         # CastMessage の protobuf 手書き encode/decode + 長さプレフィクス framing
  transport.rs     # CastTransport trait、TLS 実装、テスト用 MockTransport
  protocol.rs      # namespace 定数と JSON メッセージ builder / RECEIVER_STATUS・MEDIA_STATUS parser
  session.rs       # 1 端末との接続を駆動する CastSession (heartbeat, launch, load, 状態追跡, 再接続)
  discovery.rs     # mdns-sd で `_googlecast._tcp.local.` を browse。純粋関数の DeviceRegistry reducer
  media_ticket.rs  # Cast 専用の短命 Media Ticket レジストリ
src-tauri/src/playback_target.rs  # Playback Coordinator (有効再生先へ振り分ける単一窓口)
src-tauri/src/commands/cast.rs    # Tauri コマンド
src/api/cast.ts, src/components/CastDevicePicker.tsx
```

## 3. Playback Coordinator

- `AudioPlayer` は引き続き **キュー / 再生順 / shuffle / repeat の権威**。
- Coordinator (`playback_target.rs`) が `PlaybackTarget` を持ち、`play_track / pause / resume / stop / seek /
  set_volume / get_state / is_finished` を Local (`AudioPlayer`) か Cast (`CastSession`) へ振り分ける。
- Tauri の playback コマンド、`advance_worker`、`/api/remote/*` は **すべて Coordinator 経由**で操作する。
- Cast 中は `AudioPlayer` に「外部出力で再生中の曲」を記録するだけで rodio の sink は持たない
  (`is_finished()` は常に false → ローカルの `advance_worker` 判定は Cast 中に発火しない)。
  曲終了は Cast の `MEDIA_STATUS` (`IDLE` + `idleReason: FINISHED`) から Coordinator が判定する。
- 再生実績 (`PlayReport`) は Cast 側で「PLAYING 状態だった壁時計時間」を積算して作る (rodio の値から推測しない)。
  再生先切替そのものでは PlayReport を作らない (二重計上防止)。
- Cast 中は Preview/Audition を無効化 (`set_preview_mode(true)` はエラー)。Preview 中は Cast へ切替不可。
- 起動時は常に Local。Cast への自動接続はしない。

### 切替シーケンス

- **Local → Cast**: (1) LAN 公開・API 稼働を確認 (無効なら `LAN_DISABLED` エラーで UI がユーザー確認) →
  (2) 現在曲の形式チェック (`UNSUPPORTED_FORMAT`) → (3) 接続 + Default Media Receiver (`CC1AD845`) 起動 →
  (4) Media Ticket 発行 → LOAD (現在位置、元の playing/paused) → (5) MEDIA_STATUS で成功確認 →
  (6) ここで初めてローカル sink を停止。途中失敗はローカル再生をそのまま維持。
  曲が無い (停止中) なら接続だけ行う。
- **Cast → Local (ユーザー操作)**: Cast の最新位置を取得 → Cast を STOP + 切断 → ローカルで同曲を位置付きで読み込み、
  Cast が playing なら再生、paused なら一時停止のまま。
- **通信断**: `reconnecting` (最大 3 回、指数バックオフ) → 失敗で `disconnected`。ローカルでは鳴らさない。
  `disconnected` からユーザーが Local を選ぶと、最後の位置で **一時停止状態** で読み込む。
- **競合**: 切替要求ごとに世代番号を振り、古い世代のタスクの結果は破棄する (新しい選択が勝つ)。

## 4. Media Ticket と HTTP

- `GET|HEAD /api/cast/media/{ticket}`。ticket = 32byte 乱数 hex (64 文字)。
- `auth_guard` は「このパス + GET/HEAD」に限って LAN トークン検証をスキップし、**ハンドラ側でチケット検証必須**。
  他メソッド・他パスは従来どおり。
- チケットは `(track_id, session_id, expires_at, revoked)` に束縛。1 回のアクセスで消費しない (Range/再接続)。
  期限 = 発行時 + 曲長 + 30 分 (曲長不明なら 2 時間)。再生中は Coordinator が延長。曲切替/切断/アプリ終了で失効。
- 配信は既存の原本配信と同じ `ServeFile` (Range/206/HEAD/Content-Length/Accept-Ranges)。
  Content-Type は明示 (`audio/mpeg`, `audio/mp4`)。`Access-Control-Allow-Origin: *` も付けるが、
  対応するのは Receiver のメディア要素が出す **単純な GET/HEAD (Range 付き) だけ**。
  CORS プリフライト (`OPTIONS`) はトークン検証の対象のままで、チケット経路の例外を広げてはいない
  (プリフライトが要る fetch では取得できない)。
- チケット・ファイルパスはログ/エラー UI に出さない (ログは track_id と ticket 先頭 6 文字まで)。
- 対応形式 (P0): `mp3` → `audio/mpeg`、`m4a/mp4/aac(コンテナ MP4)` かつ実コーデックが AAC → `audio/mp4`。
  ALAC・FLAC・WAV・AIFF・Opus 等は `UNSUPPORTED_FORMAT`。ADTS 逐次トランスコードは使わない。
- Receiver に渡すホスト IP は「Cast 端末へ UDP connect したときのローカルアドレス」で決める (複数 NIC/VPN 対策)。
  `127.0.0.1`/`localhost` は渡さない。ポートは API サーバーの実 bind ポート。

## 5. 公開インタフェース (Tauri)

型 (serde camelCase):

```ts
type PlaybackTarget =
  | { type: "local" }
  | { type: "googleCast"; deviceId: string; deviceName: string };

type CastConnectionState =
  | "idle" | "discovering" | "connecting" | "connected"
  | "buffering" | "reconnecting" | "disconnected" | "error";

type CastErrorCode =
  | "LAN_DISABLED"         // API サーバー停止 or LAN 公開 OFF。UI はユーザー確認後に setApiLanEnabled(true)
  | "DEVICE_NOT_FOUND"
  | "CONNECT_FAILED"       // TCP/TLS 失敗・タイムアウト
  | "LAUNCH_FAILED"        // Default Media Receiver 起動失敗
  | "UNSUPPORTED_FORMAT"
  | "TRACK_UNAVAILABLE"    // ファイル無し
  | "LOAD_FAILED"          // Receiver が LOAD_FAILED / ERROR
  | "PREVIEW_ACTIVE"       // Preview 中は切替不可
  | "CONNECTION_LOST"
  | "SUPERSEDED"           // 新しい切替要求に置き換えられた
  | "INTERNAL";

interface CastDevice { id: string; name: string; model: string | null; host: string; port: number }

interface CastStatus {
  target: PlaybackTarget;
  connectionState: CastConnectionState;   // target=local のときは "idle"
  isPlaying: boolean;
  currentTrackId: number | null;
  positionMs: number;
  durationMs: number;
  volume: number;                          // 0..1 (Cast 中は Receiver の音量)
  lastError: { code: CastErrorCode; message: string } | null;
  lastStatusAt: number | null;             // epoch ms
}
```

コマンド:

| コマンド | 引数 | 戻り値 | 備考 |
|---|---|---|---|
| `list_cast_devices` | – | `CastDevice[]` | 初回呼び出しで browse 開始 |
| `refresh_cast_devices` | – | `CastDevice[]` | browse をやり直す |
| `get_cast_status` | – | `CastStatus` | |
| `set_playback_target` | `target: {type:"local"} \| {type:"googleCast", deviceId}` | `CastStatus` | 失敗時 `Err("<CODE>: <message>")` |
| `disconnect_cast` | – | `CastStatus` | Cast を止めて Local へ (一時停止状態で位置を引き継ぐ) |

イベント: `cast-state-changed` (payload `CastStatus`)、`cast-devices-changed` (payload `CastDevice[]`)。
既存の `playback-advanced` は Cast 中の自動送りでも従来どおり emit する。
`get_playback_state` は有効再生先の状態を返す (Cast 中は Cast の位置/再生中/音量)。

## 6. Remote API

`GET /api/remote/state` に後方互換の追加フィールド `playbackTarget` (`PlaybackTarget`) と
`connectionState` を足す。`/api/remote/{play,pause,resume,stop,next,prev,seek,volume}` は
Coordinator 経由になり、Cast 中は Cast へ作用する。

## 7. macOS AirPlay (P0-A)

Crateforge は rodio/cpal で OS のオーディオデバイスへ出力する。macOS で AirPlay スピーカーを
「サウンド出力」に選ぶと CoreAudio デバイスとして現れるため、Crateforge の
「設定 → 一般 → 出力デバイス」でそのデバイスを選ぶか、システム既定に追従させる経路で鳴らせる見込み。
`AVRoutePickerView` は導入しない。実機検証結果は `docs/cast/airplay-macos.md` に記録する。

## 8. Session API (R1 実装済み、Coordinator はこれだけを使う)

### 8.1 スレッドモデル

- `CastSession::connect` / 各操作は **tokio ランタイム上の async**。driver は `tokio::spawn` される。
  - axum ハンドラからはそのまま `.await`。
  - 同期 Tauri コマンド / `advance_worker` (std スレッド) からは `tauri::async_runtime::block_on(...)`。
    tokio ワーカースレッド内で `block_on` しないこと。
- `CastSession` は `Clone`。全ハンドルを drop すると driver はアプリを止めずに接続だけ閉じる。
- `snapshot()` は同期 (std `Mutex` を一瞬握るだけ)。UI のポーリングから呼んでよい。
- イベントは `connect` に渡した `tokio::sync::mpsc::UnboundedSender<SessionEvent>` に流れる。
  **セッションごとに新しい channel を作る**こと (古いセッションのイベントが混ざらない)。

### 8.2 API

```rust
// cast::session
CastSession::connect(device: CastDevice, transport: Arc<dyn CastTransport>,
                     events: mpsc::UnboundedSender<SessionEvent>) -> Result<CastSession, CastError>
    // TLS 接続 → CONNECT → LAUNCH(CC1AD845) → transportId へ CONNECT。最大 20 秒。
    // 失敗: CONNECT_FAILED / LAUNCH_FAILED / DEVICE_NOT_FOUND (アドレス不正)
session.id() -> u64                      // プロセス内一意。MediaTickets の session_id に使う
session.snapshot() -> CastMediaSnapshot
session.is_closed() -> bool              // driver 終了済み
session.load(req: protocol::LoadRequest, tag: i64) -> Result<u64 /*item_id*/, CastError>
    // tag = track_id。MEDIA_STATUS で受理を確認してから返る (20 秒でタイムアウト)。
    // 失敗: LOAD_FAILED (LOAD_FAILED/LOAD_CANCELLED/INVALID_REQUEST/タイムアウト/IDLE+ERROR),
    //       SUPERSEDED (後続の load に置換), CONNECTION_LOST
session.play() / pause() / seek(ms) / set_volume(0..1) -> Result<(), CastError>
    // 応答待ち 8 秒。メディア未ロード時は INTERNAL。再接続中は CONNECTION_LOST。
session.stop() -> Result<(), CastError>  // 即時。現在アイテムを ItemEnded(Stopped) で締める
session.disconnect(stop_app: bool)       // stop_app=true で TV 側の Receiver アプリも終了

// cast::transport
TlsTransport::new() -> Result<TlsTransport, String>   // 実機用 (ring, 証明書検証なし)
MockTransport::new() -> (MockTransport, UnboundedReceiver<MockDevice>)   // #[cfg(test)]

// cast::protocol::LoadRequest { content_id, content_type, duration_ms: Option<u64>,
//                               title, artist, album: Option<String>, start_ms, autoplay }
```

`CastMediaSnapshot`: `connection` (`Connected`/`Reconnecting`/`Disconnected` のみ。`Buffering` 表示は
`player_state` が `Buffering|Loading` のとき Coordinator が導く), `player_state`, `item_id`, `item_tag`
(= track_id), `item_ended`, `media_session_id`, `duration_ms`, `volume: Option<f32>`, `muted`,
`last_status_epoch_ms`, メソッド `position_now()` (PLAYING 中は外挿), `played_ms()`, `is_playing()`。

### 8.3 イベントと再生実績

```rust
enum SessionEvent {
    Status(CastMediaSnapshot),   // MEDIA/RECEIVER_STATUS 受信・接続状態変化のたび
    ItemEnded { item_id: u64, tag: i64, played_ms: u64, reason: EndReason },
    Closed { reason: String },   // 最後のイベント。以後 driver は無い
}
enum EndReason { Finished, Replaced, Stopped, Cancelled, Error, Disconnected }
```

- **再生実績は `ItemEnded` だけを根拠にする** (`tag` = track_id、`played_ms` = PLAYING だった壁時計時間)。
  アイテムごとにちょうど 1 回。LOAD に失敗したアイテムは出ない (再生していない)。
- 自動送りのトリガは `reason == Finished` のみ。`Cancelled` は TV リモコン / 別 Sender による停止。
  `Error` は Receiver の再生エラー。
- 自分の LOAD / STOP が起こす旧 mediaSessionId の IDLE は無視済み。
- 接続断: `Status(connection=Reconnecting)` → 1s/2s/4s で最大 3 回 (各 20 秒) 再接続。成功すれば
  `Status(Connected)` で同じアイテムを継続 (切断中は played 計時を止める)。全滅 / Receiver アプリ消失なら
  `ItemEnded(Disconnected)` → `Closed`。ローカルへのフォールバックはしない (Coordinator の責務でもしない)。
  再接続後に media が既に無かった場合の扱いは未実装 (状態は Idle のまま、ItemEnded は出ない)。

### 8.4 そのほかの部品

- `cast::discovery::CastDiscovery::new(on_change: Fn(Vec<CastDevice>))` → `ensure_started()` (初回 browse),
  `restart()`, `stop()`, `devices()`, `get(id)`。`on_change` は mDNS 受信スレッドから呼ばれる
  (ここで `app.emit("cast-devices-changed", ..)` する想定)。`lib.rs` での生成・manage は R2。
- `cast::media_ticket::MediaTickets` は `lib.rs` で managed state 登録済み。`api::start` が
  `app.try_state` で同じ `Arc` を拾うので、Coordinator は `app.state::<MediaTickets>()` で
  `issue(track_id, session.id(), duration_ms)` / `extend` / `revoke` / `revoke_session` / `revoke_all` を呼ぶ。
- `cast::local_ip_for(device_addr)` で Receiver に渡すホスト IP を決める。URL は
  `http://{ip}:{実 bind ポート}/api/cast/media/{ticket}` (IPv6 は `[...]`)。
- `cast::cast_media_type(path)` で LOAD 前に形式チェック (`UNSUPPORTED_FORMAT` / `TRACK_UNAVAILABLE`)。
- HTTP: `/api/cast/media/{ticket}` は ticket 不正 / 期限切れ / 失効 / ファイル無しで 404、
  未対応形式で 415。GET/HEAD 以外は従来のトークン検証に回る (トークン無しなら 401)。

## 9. Coordinator 実装メモ (R2)

- 実体は `src-tauri/src/playback_target.rs` の `PlaybackCoordinator` (Tauri managed state)。
  外界 (AudioPlayer / DB / API サーバー / emit) へは `CoordinatorEnv` trait 経由で触れ、
  テストは `MockTransport` + テスト用 Env で切替・実績・自動送りを検証する。
- 経由する呼び出し元: `commands::playback` の play/pause/resume/stop/seek/set_volume/
  get_playback_state/play_queue_at/play_next/play_prev、`advance_worker`、
  `drop_tracks_from_playback`、`/api/remote/{play,pause,resume,stop,next,prev,seek,volume,state}`、
  `playback_persist` (Cast 中は Cast の位置を保存。復元は常にローカル一時停止)。
  キュー編集 / shuffle / repeat は従来どおり `AudioPlayer` を直接操作する。
- ロック順は `AudioPlayer` → Coordinator 内部状態の一方向。どちらも await を跨いで握らない。
- **外部出力モード**: Cast 中かどうかは `AudioPlayer` 自身のモード (`set_external_current` /
  `enter_external` で ON、`leave_external` でだけ OFF) として持つ。ON の間は `play` / `load_paused`
  を `EXTERNAL_OUTPUT_ACTIVE` で断り、`play_track` はこのモードを `AudioPlayer` のロック下で見て
  Cast へ振り替える。Local→Cast の確定と Cast→Local の解除も同じロックの下で行うため、
  確定の前後でローカルの sink が作られて PC と Cast の両方から鳴ることはない。
- **音量**: ローカル (`AudioPlayer.volume`) と Cast (Receiver の音量) は独立。Cast 中の
  `set_volume` は Receiver へ送り、`get_playback_state.volume` は Receiver の音量を返す
  (フロントは既存のポーリング逆同期でスライダーを追従させる)。接続時に Receiver の音量は変えない。
  ローカルへ戻ると元のローカル音量に戻る。
- **再生実績**: Cast アイテムは `ItemEnded.played_ms` (+ Local→Cast の持ち越し `carry_ms`) で
  1 回だけ計上。Cast→Local の明示切替では Cast 側を捨て、ローカルが位置ごと引き継ぐ。
  接続断・アイテム終了後にローカルへ戻した場合は Cast 側で計上済みなので、ローカルの続きは
  計上しない (`suppress_next_report`。差し引きにすると残りが skip 閾値に入り play + skip の二重計上になる)。
  試聴 (preview) で鳴っていた曲の実績は持ち越さず `apply_report` に渡して捨てさせる。
  Cast 中の `AudioPlayer` (sink 無し) が返す実績は 0 として捨てる。
- **自動送り**: `ItemEnded(Finished)` (現在アイテムのみ) → `finished` →
  `advance_worker` が `take_finished()` で 1 回だけ取り出し、従来の `advance_next(true)` /
  `play_with_skip_on_error` / `playback-advanced` の経路を通る。曲固有でない失敗
  (`CONNECTION_LOST` / `LAN_DISABLED` 等) ではキューを空回しせず止める。
  Receiver 側の停止 (`Cancelled`) やエラー (`Error`) では進めない。停止後の「再生」は同じ曲を
  最後の位置から LOAD し直す。
- **競合**: `connect_cast` / `switch_to_local` は世代番号を進め、古い `connect_cast` は
  `SUPERSEDED` で手を引く (作ったセッションは切断、LOAD 済みアイテムの実績とチケットは捨てる)。
  確定時の世代確認は `AudioPlayer` → 内部状態の両ロックを握ったまま行うので、確認と確定の
  間に `switch_to_local` が割り込んで上書きされることはない。
  Cast 中の `play_track` が LOAD 中に再生先が替わった場合も `SUPERSEDED`。
- **確定時の曲の境目 (newest wins)**: 引き継ぐ曲を LOAD した後、ロック下で
  「ローカルの現在曲がまだその曲か」を確かめる。違っていれば (自動送り・ユーザー操作で先へ
  進んだ) その LOAD は捨てて **新しい現在曲を LOAD し直してから** 確定する (最大 3 回、だめなら
  `SUPERSEDED` でローカルのまま)。ローカルの曲が鳴り終わって自動送り待ちの場合も、ここで sink を
  外すと送りが起きなくなるため確定せず、250ms 待って送られた後の曲で LOAD し直す。
  中止ではなく再 LOAD を選んだのは、ユーザーの「Cast へ切り替える」意図を保ちつつ曲を飛ばさないため。
- **停止**: Cast への STOP はベストエフォート。接続断で失敗しても `AudioPlayer` の現在曲と
  Cast の現在アイテムは必ず片付けてからエラーを返す。
- **API サーバー停止 / LAN OFF**: `set_api_server_config` / `set_api_lan_enabled` /
  `regenerate_api_token` の後に `on_media_server_changed` を呼び、LAN で待受できていなければ
  Cast を切断 (再生先は Cast のまま `disconnected` + `LAN_DISABLED`)。トークン再生成など
  LAN のまま再起動した場合は何もしない。アプリ終了時はチケット全失効 + 切断 (2 秒で打ち切り)。
- Remote API: play/pause/resume/stop/prev/seek/volume の Cast 起因の失敗は 409 (`"<CODE>: <message>"`)、ローカル再生の失敗は従来どおり 500 (next はコマンドとキュー処理を共有するため常に 500)。

