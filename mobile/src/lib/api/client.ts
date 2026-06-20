// Crateforge LAN API クライアント。
// - LAN 越しは token 必須（ヘッダ `X-API-Token` か `?token=`）＋読み取り専用。
// - メディア（artwork / stream）は <Image>/expo-audio の source として使うため、
//   ヘッダを付けられる経路は headers、付けにくい経路は `?token=` を選べるよう両方提供する。
// React Native の URL/searchParams 実装は不完全なので、クエリ文字列は手組みする。

import type {
  GenreTagCount,
  Health,
  LibraryStats,
  PlaybackState,
  Playlist,
  PlaylistDetail,
  PlaylistTracksQuery,
  RemoteQueue,
  SimilarHit,
  SimilarQuery,
  Track,
  TracksQuery,
} from "@/lib/types";

export interface Connection {
  /** 例: "192.168.1.10:8787" / "http://host:port"。スキームは正規化で補完する。 */
  baseUrl: string;
  /** LAN は必須。loopback なら null でも可。 */
  token: string | null;
}

/** HTTP エラー。status とサーバーメッセージを保持する。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
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

  constructor(conn: Connection) {
    this.baseUrl = normalizeBaseUrl(conn.baseUrl);
    this.token = conn.token ?? null;
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
    const url = this.baseUrl + path + buildQuery(opts.query);
    const hasBody = opts.body !== undefined;
    const res = await fetch(url, {
      method,
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...this.authHeaders(),
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        if (text) msg = text;
      } catch {
        // ignore
      }
      throw new ApiError(res.status, msg);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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

  // ---- メディア ----
  artworkUrl(trackId: number): string {
    return this.mediaUrl(`/api/tracks/${trackId}/artwork`);
  }
  artworkSource(trackId: number): MediaSource {
    return this.mediaSource(`/api/tracks/${trackId}/artwork`);
  }
  streamSource(trackId: number): MediaSource {
    return this.mediaSource(`/api/tracks/${trackId}/stream`);
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
  remoteSetQueue(trackIds: number[], startIndex?: number): Promise<unknown> {
    return this.post("/api/remote/set-queue", { trackIds, startIndex });
  }
}
