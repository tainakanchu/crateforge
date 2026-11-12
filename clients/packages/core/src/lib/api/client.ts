// Crateforge LAN API クライアント。
// - LAN 越しは token 必須（ヘッダ `X-API-Token` か `?token=`）＋読み取り専用。
// - メディア（artwork / stream）は <Image>/expo-audio の source として使うため、
//   ヘッダを付けられる経路は headers、付けにくい経路は `?token=` を選べるよう両方提供する。
// React Native の URL/searchParams 実装は不完全なので、クエリ文字列は手組みする。

import type {
  Album,
  Artist,
  ArtistGrouping,
  DownloadQuality,
  GenreTagCount,
  Health,
  LibraryStats,
  PairPollResponse,
  PairStartRequest,
  PairStartResponse,
  PlaybackState,
  Playlist,
  PlaylistDetail,
  PlaylistTracksQuery,
  RemoteQueue,
  SimilarHit,
  SimilarQuery,
  Tag,
  TagCount,
  Track,
  TracksQuery,
} from "../types";
import type { RepeatMode } from "../../store/player";

export interface Connection {
  /** 例: "192.168.1.10:8787" / "http://host:port"。スキームは正規化で補完する。 */
  baseUrl: string;
  /** LAN は必須。loopback なら null でも可。 */
  token: string | null;
  /**
   * 通信失敗（NetworkError / InvalidResponseError / ApiError）のたびに呼ばれるフック。
   * AbortError（呼び出し側のキャンセル・タイムアウト）では呼ばない。
   * 接続ストアが「接続済みのまま古い状態」にならないよう、ここで状態遷移を起こす。
   */
  onError?: (e: unknown) => void;
  /** JSON API（request 経由）が成功するたびに呼ばれるフック（「最終接続」時刻の更新用）。 */
  onSuccess?: () => void;
}

/** HTTP エラー。status とサーバーメッセージを保持する。 */
/**
 * エラー応答の本文から表示用の文言を取り出す。`{"error": "..."}` / `{"message": "..."}` は中身、
 * それ以外（プレーンテキスト・解釈できない JSON）は本文をそのまま返す。
 */
export function extractErrorBodyMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const body = JSON.parse(trimmed) as unknown;
      if (body && typeof body === "object") {
        const { error, message } = body as { error?: unknown; message?: unknown };
        if (typeof error === "string" && error.trim() !== "") return error.trim();
        if (typeof message === "string" && message.trim() !== "") return message.trim();
      }
    } catch {
      // JSON として読めなければ本文のまま。
    }
  }
  return text;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** エラー応答が HTML だった（= Crateforge の API ではない URL の可能性が高い）。 */
    readonly htmlBody: boolean = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** fetch 自体が失敗した（ホストに到達できない・接続拒否・DNS 失敗など）。 */
export class NetworkError extends Error {
  constructor(
    message: string,
    /** fetch が投げた元の例外。 */
    readonly original?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

/** 2xx だが JSON として読めない応答（HTML のルーター画面など = Crateforge の API ではない）。 */
export class InvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResponseError";
  }
}

/** AbortController による中断（キャンセル/タイムアウト）か。 */
export function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError"
  );
}

/** レスポンスのヘッダから content-type を安全に読む（テストのモック応答は headers を持たない）。 */
function contentTypeOf(res: Response): string {
  try {
    return res.headers?.get?.("content-type") ?? "";
  } catch {
    return "";
  }
}

/** スキーム無しなら http:// を補い、末尾スラッシュを除去する。 */
export function normalizeBaseUrl(raw: string): string {
  let s = (raw ?? "").trim();
  if (s === "") return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

/** undefined/null を除外した camelCase クエリ文字列（先頭 `?` 付き、空なら ""）。 */
export function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

type MediaSource = { uri: string; headers?: Record<string, string> };

export class ApiClient {
  readonly baseUrl: string;
  readonly token: string | null;
  private readonly onError?: (e: unknown) => void;
  private readonly onSuccess?: () => void;

  constructor(conn: Connection) {
    this.baseUrl = normalizeBaseUrl(conn.baseUrl);
    this.token = conn.token ?? null;
    this.onError = conn.onError;
    this.onSuccess = conn.onSuccess;
  }

  /** onError フックへ通知する（AbortError は除外。フック内の例外は握りつぶす）。 */
  private notifyError(e: unknown): void {
    if (!this.onError || isAbortError(e)) return;
    try {
      this.onError(e);
    } catch {
      // フックの失敗で元のエラーを隠さない。
    }
  }

  /** fetch 用の認証ヘッダ。token 無しなら空。 */
  authHeaders(): Record<string, string> {
    return this.token ? { "X-API-Token": this.token } : {};
  }

  /** token をクエリに載せた絶対 URL（ヘッダを付けにくい <Image> 等向け）。 */
  mediaUrl(path: string): string {
    return this.baseUrl + path + (this.token ? `?token=${encodeURIComponent(this.token)}` : "");
  }

  /** ヘッダ認証つきの source（expo-image / expo-audio 向け）。 */
  mediaSource(path: string): MediaSource {
    return {
      uri: this.baseUrl + path,
      headers: this.token ? { "X-API-Token": this.token } : undefined,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    let result: T;
    try {
      result = await this.requestInner<T>(method, path, opts);
    } catch (e) {
      this.notifyError(e);
      throw e;
    }
    if (this.onSuccess) {
      try {
        this.onSuccess();
      } catch {
        // フックの失敗で成功した応答を失わない。
      }
    }
    return result;
  }

  private async requestInner<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const url = this.baseUrl + path + buildQuery(opts.query);
    const hasBody = opts.body !== undefined;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...this.authHeaders(),
        },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (e) {
      // キャンセル/タイムアウトはそのまま（呼び出し側が AbortError として扱う）。
      if (isAbortError(e)) throw e;
      // RN の fetch はホスト不達で TypeError("Network request failed") を投げる。
      throw new NetworkError(e instanceof Error ? e.message : String(e), e);
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      let html = /text\/html/i.test(contentTypeOf(res));
      try {
        const text = await res.text();
        if (text) {
          if (/^\s*</.test(text)) html = true;
          // HTML 本文をそのままメッセージに載せない（UI に生 HTML が出るのを防ぐ）。
          // JSON の `{"error": "..."}` は中身の文言だけを取り出す（round-3 N7）。
          if (!html) msg = extractErrorBodyMessage(text);
        }
      } catch {
        // ignore
      }
      throw new ApiError(res.status, msg, html);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new InvalidResponseError(
        `JSON として読めない応答です（${contentTypeOf(res) || "content-type 不明"}）`,
      );
    }
  }

  get<T>(path: string, query?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, { query, signal });
  }
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>("POST", path, { body, signal });
  }
  del<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("DELETE", path, { signal });
  }

  // ---- 読み取り ----
  health(signal?: AbortSignal): Promise<Health> {
    return this.get<Health>("/api/health", undefined, signal);
  }
  stats(): Promise<LibraryStats> {
    return this.get<LibraryStats>("/api/stats");
  }
  listTracks(query?: TracksQuery, signal?: AbortSignal): Promise<Track[]> {
    return this.get<Track[]>("/api/tracks", query as Record<string, unknown>, signal);
  }
  getTrack(trackId: number): Promise<Track> {
    return this.get<Track>(`/api/tracks/${trackId}`);
  }
  tracksByIds(trackIds: number[]): Promise<Track[]> {
    return this.post<Track[]>("/api/tracks/by-ids", { trackIds });
  }
  similar(trackId: number, query?: SimilarQuery): Promise<SimilarHit[]> {
    return this.get<SimilarHit[]>(`/api/tracks/${trackId}/similar`, query as Record<string, unknown>);
  }
  genres(): Promise<GenreTagCount[]> {
    return this.get<GenreTagCount[]>("/api/genres");
  }
  albums(): Promise<Album[]> {
    return this.get<Album[]>("/api/albums");
  }
  artists(grouping: ArtistGrouping = "artist"): Promise<Artist[]> {
    return this.get<Artist[]>("/api/artists", { grouping });
  }
  playlists(): Promise<Playlist[]> {
    return this.get<Playlist[]>("/api/playlists");
  }
  playlist(playlistId: number): Promise<PlaylistDetail> {
    return this.get<PlaylistDetail>(`/api/playlists/${playlistId}`);
  }
  playlistTracks(playlistId: number, query?: PlaylistTracksQuery): Promise<Track[]> {
    return this.get<Track[]>(
      `/api/playlists/${playlistId}/tracks`,
      query as Record<string, unknown>,
    );
  }

  // ---- 曲メタデータ書き込み ----
  /**
   * レーティングを設定する（`POST /api/tracks/{trackId}/rating` に `{ rating }` を送る）。
   * - rating は 0..100 スケール（★ = rating/20）。範囲外は 0..100 に clamp し整数へ丸める。
   * - DB の rating のみ更新する最小権限エンドポイント（ファイルタグ等には触れない）。
   *   LAN からは token 認証つき（X-API-Token ヘッダ）で通る。
   * - 解決値（後続のキャッシュ無効化用）は呼び出し側で持つため戻り値は void。
   */
  async setRating(trackId: number, rating: number): Promise<void> {
    const clamped = Math.round(Math.max(0, Math.min(100, rating)));
    await this.post<unknown>(`/api/tracks/${trackId}/rating`, { rating: clamped });
  }

  // ---- first-class Tags（Genre とは独立・DB のみ。古いホストは 404）----
  /**
   * 全タグの頻度一覧（`GET /api/tags`）。
   * ホストが未対応なら ApiError(404) を投げる → 呼び出し側で degrade。
   */
  listTags(): Promise<TagCount[]> {
    return this.get<TagCount[]>("/api/tags");
  }

  /**
   * 1 曲に付いている first-class Tags（`GET /api/tracks/{id}/tags`）。
   * ホストが未対応なら ApiError(404)。
   */
  getTrackTags(trackId: number): Promise<Tag[]> {
    return this.get<Tag[]>(`/api/tracks/${trackId}/tags`);
  }

  /**
   * 複数曲に first-class Tag を付与（`POST /api/tracks/tags/add`）。
   * `tag` は `mood:dreamy` 形式、free は `bridge` のように value のみ。
   * 更新件数を返す。ホスト未対応なら 404。
   */
  async addTrackTags(trackIds: number[], tag: string): Promise<{ updated: number }> {
    return this.post<{ updated: number }>("/api/tracks/tags/add", { trackIds, tag });
  }

  /**
   * 複数曲から first-class Tag を除去（`POST /api/tracks/tags/remove`）。
   * ホスト未対応なら 404。
   */
  async removeTrackTags(trackIds: number[], tag: string): Promise<{ updated: number }> {
    return this.post<{ updated: number }>("/api/tracks/tags/remove", { trackIds, tag });
  }

  // ---- メディア ----
  artworkUrl(trackId: number): string {
    return this.mediaUrl(`/api/tracks/${trackId}/artwork`);
  }
  artworkSource(trackId: number): MediaSource {
    return this.mediaSource(`/api/tracks/${trackId}/artwork`);
  }
  /**
   * 再生用ストリーム source（ヘッダ認証つき）。
   * - opts.native=true で `?native=true` を付け、端末再生可能な形式は無変換、不可なら AAC で配信させる。
   *   （旧版は `native=1` を送っていたが、古いホストの `Option<bool>` が 1 を受けず 400 になっていた。
   *   `true` なら新旧どちらのホストでも通る。）
   * - opts.forceAac=true で `?fmt=aac` を付け、常に ADTS AAC へ再エンコードさせる
   *   （端末で再生できない形式の "Source error" フォールバック用）。forceAac は native より優先。
   */
  streamSource(trackId: number, opts?: { native?: boolean; forceAac?: boolean }): MediaSource {
    const query = buildQuery(
      opts?.forceAac ? { fmt: "aac" } : opts?.native ? { native: true } : {},
    );
    return {
      uri: this.baseUrl + `/api/tracks/${trackId}/stream` + query,
      headers: this.token ? { "X-API-Token": this.token } : undefined,
    };
  }

  /**
   * オフライン保存用のダウンロード URL（token をクエリに載せた完全 URL）。
   * expo-file-system の `File.downloadFileAsync` がカスタムヘッダ無しで使えるよう、認証はクエリで渡す。
   * - original: 無変換の元バイト（`?original=true&native=true`。`1` は古いホストで 400 になるため `true`）。
   * - aacNNN: AAC へ再エンコード（`?fmt=aac&br=NNN`）。
   */
  downloadUrl(trackId: number, quality: DownloadQuality): string {
    const params: Record<string, unknown> =
      quality === "original"
        ? { original: true, native: true }
        : { fmt: "aac", br: quality === "aac256" ? 256 : quality === "aac192" ? 192 : 128 };
    if (this.token) params.token = this.token;
    return this.baseUrl + `/api/tracks/${trackId}/stream` + buildQuery(params);
  }

  // ---- ペアリング（公開エンドポイント; token 不要）----
  /**
   * ペアリングセッションを開始する。トークン不要（公開エンドポイント）。
   * デスクトップ側に「<端末名> が接続しようとしています」ポップアップを出すため、
   * 任意で deviceName / platform を本文に載せる（後方互換: 省略時は本文なしで送る）。
   * レスポンスの code は目視確認用で、ワンクリック承認できないときの手入力フォールバックにも使う。
   */
  pairStart(deviceName?: string, platform?: string): Promise<PairStartResponse> {
    const body: PairStartRequest | undefined =
      deviceName != null || platform != null ? { deviceName, platform } : undefined;
    return this.post<PairStartResponse>("/api/pair/start", body);
  }

  /**
   * ペアリングの承認状態をポーリングする。トークン不要（公開エンドポイント）。
   * status が "approved" になると token が含まれる。"expired" で再試行が必要。
   */
  pairPoll(session: string): Promise<PairPollResponse> {
    return this.get<PairPollResponse>("/api/pair/poll", { session });
  }

  // ---- リモート操作（デスクトップ側を操作）----
  remoteState(signal?: AbortSignal): Promise<PlaybackState> {
    return this.get<PlaybackState>("/api/remote/state", undefined, signal);
  }
  remoteQueue(signal?: AbortSignal): Promise<RemoteQueue> {
    return this.get<RemoteQueue>("/api/remote/queue", undefined, signal);
  }
  remotePlay(trackId: number): Promise<unknown> {
    return this.post("/api/remote/play", { trackId });
  }
  remotePause(): Promise<unknown> {
    return this.post("/api/remote/pause");
  }
  remoteResume(): Promise<unknown> {
    return this.post("/api/remote/resume");
  }
  remoteStop(): Promise<unknown> {
    return this.post("/api/remote/stop");
  }
  remoteNext(): Promise<unknown> {
    return this.post("/api/remote/next");
  }
  remotePrev(): Promise<unknown> {
    return this.post("/api/remote/prev");
  }
  remoteSeek(positionMs: number): Promise<unknown> {
    return this.post("/api/remote/seek", { positionMs });
  }
  /**
   * 再生キューを置き換える（`POST /api/remote/set-queue`）。
   * opts.play=true なら置き換え後に startIndex の曲から再生を始める（新しいホストのみ。
   * 古いホストは play を無視してキューだけ置き換える）。
   */
  remoteSetQueue(
    trackIds: number[],
    startIndex?: number,
    opts?: { play?: boolean },
  ): Promise<unknown> {
    return this.post("/api/remote/set-queue", {
      trackIds,
      startIndex,
      ...(opts?.play ? { play: true } : {}),
    });
  }
  /**
   * 現在のキュー（`remoteQueue().trackIds` の再生順）の index 番目にジャンプして再生する
   * （`POST /api/remote/play-at`）。キュー順・シャッフル順は保たれる。
   * 範囲外は 404。古いホストは 404（呼び出し側で remoteSetQueue へフォールバック可）。
   */
  remotePlayAt(index: number): Promise<{ trackId: number | null } | undefined> {
    return this.post("/api/remote/play-at", { index });
  }
  /** 音量（0.0–1.0）。 */
  remoteVolume(volume: number): Promise<unknown> {
    return this.post("/api/remote/volume", { volume: Math.max(0, Math.min(1, volume)) });
  }
  /** シャッフルの ON/OFF。 */
  remoteShuffle(on: boolean): Promise<unknown> {
    return this.post("/api/remote/shuffle", { on });
  }
  /** リピートモード。 */
  remoteRepeat(mode: RepeatMode): Promise<unknown> {
    return this.post("/api/remote/repeat", { mode });
  }
}
